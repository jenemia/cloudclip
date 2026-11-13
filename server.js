'use strict';

/**
 * CloudClip — paste text/images on one device, read them on another.
 *
 * - No external dependencies (Node >= 18).
 * - Clips live only in memory and are removed after TTL (default 1 hour).
 * - Each clip gets an unguessable random path: https://host/<id>
 * - Optional 4-digit PIN. Too many wrong PINs deletes the clip.
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '0.0.0.0',
  ttlMs: Number(process.env.CLIP_TTL_MS) || 60 * 60 * 1000, // 1 hour
  maxBodyBytes: Number(process.env.MAX_BODY_BYTES) || 25 * 1024 * 1024, // per request (base64 JSON)
  maxTotalBytes: Number(process.env.MAX_TOTAL_BYTES) || 512 * 1024 * 1024, // all clips in memory
  maxItems: 20,
  maxTextChars: 1_000_000,
  maxPinAttempts: 5,
  idLength: 8,
  trustProxy: process.env.TRUST_PROXY === '1',
  // Native TLS: set both to PEM file paths to serve HTTPS directly from Node.
  tlsCert: process.env.TLS_CERT || '',
  tlsKey: process.env.TLS_KEY || '',
  // With native TLS: also listen on this port and redirect plain HTTP to HTTPS (e.g. 80). 0 = off.
  httpRedirectPort: Number(process.env.HTTP_REDIRECT_PORT) || 0,
  // Behind a TLS-terminating proxy (TRUST_PROXY=1): redirect requests whose X-Forwarded-Proto is http.
  forceHttps: process.env.FORCE_HTTPS === '1',
  hstsMaxAge: process.env.HSTS_MAX_AGE !== undefined ? Number(process.env.HSTS_MAX_AGE) : 15552000, // 180 days
};

// Unambiguous alphabet (no 0/o, 1/l/i) so an id can be typed by hand on a phone.
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ID_RE = new RegExp(`^[${ID_ALPHABET}]{${CONFIG.idLength}}$`);
const PIN_RE = /^\d{4}$/;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/avif']);

/** @type {Map<string, {id:string, items:Array, pinHash:string|null, pinSalt:string|null, createdAt:number, expiresAt:number, bytes:number, failedPins:number}>} */
const clips = new Map();
let totalBytes = 0;

function randomId() {
  const bytes = crypto.randomBytes(CONFIG.idLength * 2);
  let out = '';
  for (let i = 0; i < bytes.length && out.length < CONFIG.idLength; i++) {
    // Rejection sampling to avoid modulo bias.
    const limit = 256 - (256 % ID_ALPHABET.length);
    if (bytes[i] < limit) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  }
  return out.length === CONFIG.idLength ? out : randomId();
}

function hashPin(pin, salt) {
  return crypto.scryptSync(pin, salt, 32).toString('hex');
}

function pinMatches(clip, pin) {
  if (!clip.pinHash) return true;
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) return false;
  const a = Buffer.from(hashPin(pin, clip.pinSalt), 'hex');
  const b = Buffer.from(clip.pinHash, 'hex');
  return crypto.timingSafeEqual(a, b);
}

function removeClip(id) {
  const clip = clips.get(id);
  if (!clip) return;
  clips.delete(id);
  totalBytes -= clip.bytes;
}

function getLiveClip(id) {
  const clip = clips.get(id);
  if (!clip) return null;
  if (clip.expiresAt <= Date.now()) {
    removeClip(id);
    return null;
  }
  return clip;
}

function sweep() {
  const now = Date.now();
  for (const [id, clip] of clips) if (clip.expiresAt <= now) removeClip(id);
}

// ---------- simple per-IP rate limiting (protects id/PIN guessing) ----------
const buckets = new Map();
function rateLimited(ip, key, limit, windowMs) {
  const k = `${key}:${ip}`;
  const now = Date.now();
  let b = buckets.get(k);
  if (!b || b.reset <= now) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(k, b);
  }
  b.count++;
  return b.count > limit;
}
function sweepBuckets() {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
}

function clientIp(req) {
  if (CONFIG.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// ---------- validation ----------
function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw httpError(400, '붙여넣은 내용이 없습니다.');
  if (items.length > CONFIG.maxItems) throw httpError(400, `항목은 최대 ${CONFIG.maxItems}개까지 가능합니다.`);
  let bytes = 0;
  const clean = items.map((item) => {
    if (!item || typeof item !== 'object') throw httpError(400, '잘못된 항목입니다.');
    if (item.type === 'text') {
      if (typeof item.text !== 'string' || item.text.length === 0) throw httpError(400, '빈 텍스트입니다.');
      if (item.text.length > CONFIG.maxTextChars) throw httpError(413, '텍스트가 너무 깁니다.');
      bytes += Buffer.byteLength(item.text);
      return { type: 'text', text: item.text };
    }
    if (item.type === 'image') {
      if (!IMAGE_MIMES.has(item.mime)) throw httpError(400, '지원하지 않는 이미지 형식입니다.');
      if (typeof item.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data)) {
        throw httpError(400, '이미지 데이터가 올바르지 않습니다.');
      }
      const name = typeof item.name === 'string' ? item.name.slice(0, 200) : '';
      bytes += item.data.length;
      return { type: 'image', mime: item.mime, data: item.data, name };
    }
    throw httpError(400, '알 수 없는 항목 형식입니다.');
  });
  return { items: clean, bytes };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---------- HTTP helpers ----------
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function isSecure(req) {
  if (req.socket.encrypted) return true;
  if (CONFIG.trustProxy) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    return proto === 'https';
  }
  return false;
}

function send(res, status, body, headers = {}) {
  const extra = {};
  if (CONFIG.hstsMaxAge > 0 && res.req && isSecure(res.req)) {
    extra['Strict-Transport-Security'] = `max-age=${CONFIG.hstsMaxAge}`;
  }
  res.writeHead(status, { ...SECURITY_HEADERS, ...extra, ...headers });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > CONFIG.maxBodyBytes) {
        reject(httpError(413, `용량이 너무 큽니다. (최대 ${Math.floor(CONFIG.maxBodyBytes / 1024 / 1024)}MB)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};
const staticCache = new Map();
function serveStatic(res, file) {
  let entry = staticCache.get(file);
  if (!entry) {
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(full)) return false;
    entry = { body: fs.readFileSync(full), type: STATIC_TYPES[path.extname(file)] || 'application/octet-stream' };
    if (process.env.NODE_ENV === 'production') staticCache.set(file, entry);
  }
  send(res, 200, entry.body, { 'Content-Type': entry.type, 'Cache-Control': 'no-cache' });
  return true;
}

function clipMeta(clip) {
  return { id: clip.id, hasPin: !!clip.pinHash, createdAt: clip.createdAt, expiresAt: clip.expiresAt };
}

// ---------- API handlers ----------
async function createClip(req, res) {
  const ip = clientIp(req);
  if (rateLimited(ip, 'create', 60, 10 * 60 * 1000)) throw httpError(429, '요청이 너무 많습니다. 잠시 후 다시 시도하세요.');

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    if (e.status) throw e;
    throw httpError(400, '요청 형식이 올바르지 않습니다.');
  }
  const { items, bytes } = validateItems(payload.items);

  let pinHash = null;
  let pinSalt = null;
  if (payload.pin !== undefined && payload.pin !== null && payload.pin !== '') {
    if (typeof payload.pin !== 'string' || !PIN_RE.test(payload.pin)) throw httpError(400, '비밀번호는 숫자 4자리여야 합니다.');
    pinSalt = crypto.randomBytes(16).toString('hex');
    pinHash = hashPin(payload.pin, pinSalt);
  }

  sweep();
  if (totalBytes + bytes > CONFIG.maxTotalBytes) throw httpError(507, '서버 저장 공간이 부족합니다. 잠시 후 다시 시도하세요.');

  let id;
  do id = randomId();
  while (clips.has(id));

  const now = Date.now();
  const clip = { id, items, pinHash, pinSalt, createdAt: now, expiresAt: now + CONFIG.ttlMs, bytes, failedPins: 0 };
  clips.set(id, clip);
  totalBytes += bytes;

  sendJson(res, 201, { ...clipMeta(clip), url: `/${id}` });
}

function authorize(req, clip) {
  if (!clip.pinHash) return;
  const pin = req.headers['x-clip-pin'];
  if (pin === undefined) throw Object.assign(httpError(401, '비밀번호가 필요합니다.'), { extra: { pinRequired: true } });
  if (rateLimited(clientIp(req), 'pin', 30, 10 * 60 * 1000)) throw httpError(429, '시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
  if (!pinMatches(clip, String(pin))) {
    clip.failedPins++;
    const left = CONFIG.maxPinAttempts - clip.failedPins;
    if (left <= 0) {
      removeClip(clip.id);
      throw httpError(410, '비밀번호를 여러 번 틀려 클립이 삭제되었습니다.');
    }
    throw Object.assign(httpError(403, `비밀번호가 틀렸습니다. (남은 시도 ${left}회)`), {
      extra: { pinRequired: true, attemptsLeft: left },
    });
  }
  clip.failedPins = 0;
}

function lookup(req, id) {
  if (rateLimited(clientIp(req), 'lookup', 120, 10 * 60 * 1000)) throw httpError(429, '요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
  const clip = ID_RE.test(id) ? getLiveClip(id) : null;
  if (!clip) throw httpError(404, '클립이 없거나 만료되었습니다.');
  return clip;
}

function getClip(req, res, id) {
  const clip = lookup(req, id);
  authorize(req, clip);
  sendJson(res, 200, { ...clipMeta(clip), items: clip.items });
}

function getClipMeta(req, res, id) {
  const clip = lookup(req, id);
  sendJson(res, 200, clipMeta(clip));
}

function deleteClip(req, res, id) {
  const clip = lookup(req, id);
  authorize(req, clip);
  removeClip(id);
  sendJson(res, 200, { ok: true });
}

// ---------- router ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method;

  if (CONFIG.forceHttps && CONFIG.trustProxy && !isSecure(req) && p !== '/healthz') {
    return redirectToHttps(req, res);
  }

  if (p === '/api/clips' && method === 'POST') return createClip(req, res);

  let m = p.match(/^\/api\/clips\/([^/]+)\/meta$/);
  if (m && method === 'GET') return getClipMeta(req, res, m[1]);

  m = p.match(/^\/api\/clips\/([^/]+)$/);
  if (m && method === 'GET') return getClip(req, res, m[1]);
  if (m && method === 'DELETE') return deleteClip(req, res, m[1]);

  if (p === '/healthz') return sendJson(res, 200, { ok: true, clips: clips.size });

  if (method !== 'GET' && method !== 'HEAD') throw httpError(405, 'Method not allowed');

  if (p === '/' || ID_RE.test(p.slice(1))) {
    serveStatic(res, 'index.html');
    return;
  }
  if (/^\/[a-z0-9._-]+$/i.test(p) && serveStatic(res, p.slice(1))) return;

  throw httpError(404, 'Not found');
}

function onRequest(req, res) {
  handle(req, res).catch((err) => {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (res.headersSent) return res.end();
    if (req.url.startsWith('/api/')) {
      sendJson(res, status, { error: status === 500 ? '서버 오류가 발생했습니다.' : err.message, ...(err.extra || {}) });
    } else {
      send(res, status, status === 404 ? 'Not found' : 'Error', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  });
}

const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i;

function redirectToHttps(req, res, httpsPort) {
  // Only echo back a syntactically valid Host header (prevents header/open-redirect tricks).
  let host = String(req.headers.host || '');
  if (!HOST_RE.test(host)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad Request');
  }
  if (httpsPort) {
    host = host.replace(/:\d+$/, '');
    if (httpsPort !== 443) host += `:${httpsPort}`;
  }
  const pathAndQuery = req.url.startsWith('/') ? req.url : '/';
  res.writeHead(308, { Location: `https://${host}${pathAndQuery}`, 'Cache-Control': 'no-store' });
  res.end();
}

function loadTlsOptions() {
  return { cert: fs.readFileSync(CONFIG.tlsCert), key: fs.readFileSync(CONFIG.tlsKey) };
}

function createServer() {
  if (CONFIG.tlsCert && CONFIG.tlsKey) {
    const server = https.createServer({ ...loadTlsOptions(), minVersion: 'TLSv1.2' }, onRequest);
    // Pick up renewed certificates (e.g. certbot) without a restart.
    const reload = () => {
      try {
        server.setSecureContext(loadTlsOptions());
        console.log('TLS certificate reloaded');
      } catch (e) {
        console.error('TLS certificate reload failed:', e.message);
      }
    };
    let debounce;
    for (const f of [CONFIG.tlsCert, CONFIG.tlsKey]) {
      fs.watchFile(f, { interval: 60 * 1000 }, () => {
        clearTimeout(debounce);
        debounce = setTimeout(reload, 2000);
      });
    }
    server.on('close', () => [CONFIG.tlsCert, CONFIG.tlsKey].forEach((f) => fs.unwatchFile(f)));
    return server;
  }
  if (CONFIG.tlsCert || CONFIG.tlsKey) throw new Error('TLS_CERT and TLS_KEY must both be set');
  return http.createServer(onRequest);
}

function start() {
  const server = createServer();
  const secure = server instanceof https.Server;
  const timer = setInterval(() => {
    sweep();
    sweepBuckets();
  }, 30 * 1000);
  timer.unref();
  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`CloudClip listening on ${secure ? 'https' : 'http'}://${CONFIG.host}:${CONFIG.port} (TTL ${CONFIG.ttlMs / 60000} min)`);
    if (!secure && !CONFIG.trustProxy) {
      console.log('  ! Plain HTTP: clipboard features need HTTPS (except on localhost). See README "HTTPS".');
    }
  });
  if (secure && CONFIG.httpRedirectPort) {
    http
      .createServer((req, res) => redirectToHttps(req, res, CONFIG.port))
      .listen(CONFIG.httpRedirectPort, CONFIG.host, () => {
        console.log(`  HTTP -> HTTPS redirect on port ${CONFIG.httpRedirectPort}`);
      });
  }
  return server;
}

if (require.main === module) start();

module.exports = { createServer, redirectToHttps, isSecure, CONFIG, clips, sweep, _reset: () => { clips.clear(); buckets.clear(); totalBytes = 0; } };
