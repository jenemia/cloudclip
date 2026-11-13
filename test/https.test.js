'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');
let tmp;
const procs = [];

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, HOST: '127.0.0.1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(child);
    let out = '';
    const onData = (d) => {
      out += d;
      const needRedirect = !!env.HTTP_REDIRECT_PORT;
      if (/listening/.test(out) && (!needRedirect || /redirect on port/.test(out))) resolve(child);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
}

function request(mod, url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { rejectUnauthorized: false, ...opts }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudclip-tls-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem'),
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' });
});

after(() => {
  for (const p of procs) p.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('native TLS serves HTTPS with HSTS and redirects plain HTTP', async () => {
  const port = await freePort();
  const redirectPort = await freePort();
  await startServer({
    TLS_CERT: path.join(tmp, 'cert.pem'),
    TLS_KEY: path.join(tmp, 'key.pem'),
    PORT: String(port),
    HTTP_REDIRECT_PORT: String(redirectPort),
  });

  const res = await request(https, `https://127.0.0.1:${port}/healthz`);
  assert.equal(res.status, 200);
  assert.match(res.headers['strict-transport-security'], /max-age=\d+/);

  const r = await request(http, `http://127.0.0.1:${redirectPort}/abcdefgh?x=1`);
  assert.equal(r.status, 308);
  assert.equal(r.headers.location, `https://127.0.0.1:${port}/abcdefgh?x=1`);

  const bad = await request(http, `http://127.0.0.1:${redirectPort}/`, { headers: { Host: 'evil.com/foo' } });
  assert.equal(bad.status, 400);
});

test('behind a proxy: FORCE_HTTPS redirects http, HSTS only on https', async () => {
  const port = await freePort();
  await startServer({ PORT: String(port), TRUST_PROXY: '1', FORCE_HTTPS: '1' });

  const plain = await request(http, `http://127.0.0.1:${port}/`, {
    headers: { Host: 'clip.example.com', 'X-Forwarded-Proto': 'http' },
  });
  assert.equal(plain.status, 308);
  assert.equal(plain.headers.location, 'https://clip.example.com/');

  const secure = await request(http, `http://127.0.0.1:${port}/`, {
    headers: { Host: 'clip.example.com', 'X-Forwarded-Proto': 'https' },
  });
  assert.equal(secure.status, 200);
  assert.ok(secure.headers['strict-transport-security']);

  const health = await request(http, `http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
});

test('plain HTTP without proxy trust sends no HSTS', async () => {
  const port = await freePort();
  await startServer({ PORT: String(port) });
  const res = await request(http, `http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers['strict-transport-security'], undefined);
});
