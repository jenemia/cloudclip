/**
 * CloudClip API — runs on Cloudflare Pages Functions, data in Workers KV.
 *
 * KV layout (both keys expire automatically via KV TTL):
 *   meta:<id>  small JSON  { createdAt, expiresAt, pinHash, pinSalt, failedPins }
 *   data:<id>  JSON array of items [{type:'text',text} | {type:'image',mime,data(base64),name}]
 */

export const TTL_SECONDS = 60 * 60; // 1 hour
export const MAX_BODY_BYTES = 20 * 1024 * 1024; // KV value limit is 25 MiB
export const MAX_ITEMS = 20;
export const MAX_PIN_ATTEMPTS = 5;
export const ID_LENGTH = 8;

// Unambiguous alphabet (no 0/o, 1/l/i) so an id can be typed by hand.
export const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const ID_RE = new RegExp(`^[${ID_ALPHABET}]{${ID_LENGTH}}$`);
const PIN_RE = /^\d{4}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/avif']);

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

export function randomId() {
  const limit = 256 - (256 % ID_ALPHABET.length); // rejection sampling: no modulo bias
  let out = '';
  while (out.length < ID_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(ID_LENGTH * 2))) {
      if (b < limit && out.length < ID_LENGTH) out += ID_ALPHABET[b % ID_ALPHABET.length];
    }
  }
  return out;
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPin(pin, salt) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pin}`)));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, '붙여넣은 내용이 없습니다.');
  if (items.length > MAX_ITEMS) throw new HttpError(400, `항목은 최대 ${MAX_ITEMS}개까지 가능합니다.`);
  return items.map((item) => {
    if (item?.type === 'text') {
      if (typeof item.text !== 'string' || item.text.length === 0) throw new HttpError(400, '빈 텍스트입니다.');
      return { type: 'text', text: item.text };
    }
    if (item?.type === 'image') {
      if (!IMAGE_MIMES.has(item.mime)) throw new HttpError(400, '지원하지 않는 이미지 형식입니다.');
      if (typeof item.data !== 'string' || !B64_RE.test(item.data)) throw new HttpError(400, '이미지 데이터가 올바르지 않습니다.');
      const name = typeof item.name === 'string' ? item.name.slice(0, 200) : '';
      return { type: 'image', mime: item.mime, data: item.data, name };
    }
    throw new HttpError(400, '알 수 없는 항목 형식입니다.');
  });
}

async function readJsonBody(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY_BYTES) throw tooLarge();
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw tooLarge();
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, '요청 형식이 올바르지 않습니다.');
  }
}
const tooLarge = () => new HttpError(413, `용량이 너무 큽니다. (최대 ${MAX_BODY_BYTES / 1024 / 1024}MB)`);

// KV expirations must be at least 60s in the future.
const kvExpiration = (expiresAt) => Math.max(Math.ceil(expiresAt / 1000), Math.floor(Date.now() / 1000) + 61);

function publicMeta(id, meta) {
  return { id, hasPin: !!meta.pinHash, createdAt: meta.createdAt, expiresAt: meta.expiresAt };
}

async function loadMeta(kv, id) {
  const meta = ID_RE.test(id) ? await kv.get(`meta:${id}`, 'json') : null;
  if (!meta || meta.expiresAt <= Date.now()) throw new HttpError(404, '클립이 없거나 만료되었습니다.');
  return meta;
}

async function removeClip(kv, id) {
  await Promise.all([kv.delete(`meta:${id}`), kv.delete(`data:${id}`)]);
}

async function authorize(request, kv, id, meta) {
  if (!meta.pinHash) return;
  const pin = request.headers.get('X-Clip-Pin');
  if (pin === null) throw new HttpError(401, '비밀번호가 필요합니다.', { pinRequired: true });
  const ok = PIN_RE.test(pin) && safeEqual(await hashPin(pin, meta.pinSalt), meta.pinHash);
  if (ok) {
    if (meta.failedPins) {
      meta.failedPins = 0;
      await kv.put(`meta:${id}`, JSON.stringify(meta), { expiration: kvExpiration(meta.expiresAt) });
    }
    return;
  }
  meta.failedPins = (meta.failedPins || 0) + 1;
  const left = MAX_PIN_ATTEMPTS - meta.failedPins;
  if (left <= 0) {
    await removeClip(kv, id);
    throw new HttpError(410, '비밀번호를 여러 번 틀려 클립이 삭제되었습니다.');
  }
  await kv.put(`meta:${id}`, JSON.stringify(meta), { expiration: kvExpiration(meta.expiresAt) });
  throw new HttpError(403, `비밀번호가 틀렸습니다. (남은 시도 ${left}회)`, { pinRequired: true, attemptsLeft: left });
}

// ---------------- handlers ----------------
async function createClip(request, kv) {
  const payload = await readJsonBody(request);
  const items = validateItems(payload?.items);

  let pinHash = null;
  let pinSalt = null;
  if (payload.pin !== undefined && payload.pin !== null && payload.pin !== '') {
    if (typeof payload.pin !== 'string' || !PIN_RE.test(payload.pin)) throw new HttpError(400, '비밀번호는 숫자 4자리여야 합니다.');
    pinSalt = toHex(crypto.getRandomValues(new Uint8Array(16)));
    pinHash = await hashPin(payload.pin, pinSalt);
  }

  let id = randomId();
  while (await kv.get(`meta:${id}`)) id = randomId();

  const createdAt = Date.now();
  const meta = { createdAt, expiresAt: createdAt + TTL_SECONDS * 1000, pinHash, pinSalt, failedPins: 0 };
  const opts = { expirationTtl: TTL_SECONDS };
  // Write data first so meta never points at missing data.
  await kv.put(`data:${id}`, JSON.stringify(items), opts);
  await kv.put(`meta:${id}`, JSON.stringify(meta), opts);

  return json(201, { ...publicMeta(id, meta), url: `/${id}` });
}

async function getClip(request, kv, id) {
  const meta = await loadMeta(kv, id);
  await authorize(request, kv, id, meta);
  const items = await kv.get(`data:${id}`, 'json');
  if (!items) throw new HttpError(404, '클립이 없거나 만료되었습니다.');
  return json(200, { ...publicMeta(id, meta), items });
}

async function deleteClip(request, kv, id) {
  const meta = await loadMeta(kv, id);
  await authorize(request, kv, id, meta);
  await removeClip(kv, id);
  return json(200, { ok: true });
}

/** Entry point for /api/* — `env.CLIPS` is the KV namespace binding. */
export async function handleApi(request, env) {
  try {
    const kv = env.CLIPS;
    if (!kv) throw new HttpError(500, 'KV 바인딩(CLIPS)이 설정되지 않았습니다.');
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (pathname === '/api/clips' && method === 'POST') return await createClip(request, kv);

    let m = pathname.match(/^\/api\/clips\/([^/]+)\/meta$/);
    if (m && method === 'GET') return json(200, publicMeta(m[1], await loadMeta(kv, m[1])));

    m = pathname.match(/^\/api\/clips\/([^/]+)$/);
    if (m && method === 'GET') return await getClip(request, kv, m[1]);
    if (m && method === 'DELETE') return await deleteClip(request, kv, m[1]);

    throw new HttpError(404, 'Not found');
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message, ...(err.extra || {}) });
    console.error(err);
    return json(500, { error: '서버 오류가 발생했습니다.' });
  }
}
