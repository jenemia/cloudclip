import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleApi, MAX_PIN_ATTEMPTS, MAX_PAGE_CLIPS, PAGE_TTL_SECONDS, TTL_SECONDS } from '../lib/api.js';

/** Minimal in-memory stand-in for a Workers KV namespace (honours expiration). */
class FakeKV {
  constructor() { this.store = new Map(); }
  async get(key, type) {
    const e = this.store.get(key);
    if (!e || (e.exp && e.exp * 1000 <= Date.now())) return null;
    return type === 'json' ? JSON.parse(e.value) : e.value;
  }
  async put(key, value, opts = {}) {
    if (opts.expirationTtl !== undefined) assert.ok(opts.expirationTtl >= 60, 'KV TTL must be >= 60s');
    const exp = opts.expiration ?? (opts.expirationTtl ? Math.floor(Date.now() / 1000) + opts.expirationTtl : 0);
    if (opts.expiration !== undefined) assert.ok(exp >= Date.now() / 1000 + 60, 'KV expiration must be >= 60s ahead');
    this.store.set(key, { value, exp });
  }
  async delete(key) { this.store.delete(key); }
}

let env;
beforeEach(() => { env = { CLIPS: new FakeKV() }; });

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function call(method, path, { body, pin, pagePin } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (pin !== undefined) headers['X-Clip-Pin'] = pin;
  if (pagePin !== undefined) headers['X-Page-Pin'] = pagePin;
  const res = await handleApi(
    new Request(`https://clip.example.com${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }),
    env,
  );
  return { status: res.status, data: await res.json() };
}

test('create and read a text + image clip without PIN', async () => {
  const { status, data } = await call('POST', '/api/clips', {
    body: { items: [{ type: 'text', text: '안녕 hello' }, { type: 'image', mime: 'image/png', data: PNG_1PX }] },
  });
  assert.equal(status, 201);
  assert.match(data.id, /^[a-z2-9]{8}$/);
  assert.equal(data.url, `/${data.id}`);
  assert.equal(data.hasPin, false);
  assert.equal(data.expiresAt - data.createdAt, TTL_SECONDS * 1000);
  assert.equal(env.CLIPS.store.get(`data:${data.id}`).exp - Math.floor(data.createdAt / 1000), TTL_SECONDS);

  const got = await call('GET', `/api/clips/${data.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.data.items[0].text, '안녕 hello');
  assert.equal(got.data.items[1].data, PNG_1PX);
});

test('PIN protects the clip and too many wrong attempts delete it', async () => {
  const { data } = await call('POST', '/api/clips', { body: { items: [{ type: 'text', text: 'secret' }], pin: '1234' } });
  assert.equal(data.hasPin, true);

  const meta = await call('GET', `/api/clips/${data.id}/meta`);
  assert.equal(meta.data.hasPin, true);
  assert.equal(meta.data.items, undefined);
  assert.equal(meta.data.pinHash, undefined);

  assert.equal((await call('GET', `/api/clips/${data.id}`)).status, 401);
  const ok = await call('GET', `/api/clips/${data.id}`, { pin: '1234' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.items[0].text, 'secret');

  for (let i = 1; i <= MAX_PIN_ATTEMPTS; i++) {
    const r = await call('GET', `/api/clips/${data.id}`, { pin: '0000' });
    assert.equal(r.status, i < MAX_PIN_ATTEMPTS ? 403 : 410);
    if (i < MAX_PIN_ATTEMPTS) assert.equal(r.data.attemptsLeft, MAX_PIN_ATTEMPTS - i);
  }
  assert.equal((await call('GET', `/api/clips/${data.id}`, { pin: '1234' })).status, 404);
  assert.equal(env.CLIPS.store.size, 0);
});

test('a correct PIN resets the failure counter', async () => {
  const { data } = await call('POST', '/api/clips', { body: { items: [{ type: 'text', text: 'x' }], pin: '1111' } });
  for (let i = 0; i < MAX_PIN_ATTEMPTS - 1; i++) await call('GET', `/api/clips/${data.id}`, { pin: '2222' });
  assert.equal((await call('GET', `/api/clips/${data.id}`, { pin: '1111' })).status, 200);
  assert.equal((await call('GET', `/api/clips/${data.id}`, { pin: '2222' })).data.attemptsLeft, MAX_PIN_ATTEMPTS - 1);
});

test('rejects invalid input', async () => {
  const post = (body) => call('POST', '/api/clips', { body });
  assert.equal((await post({ items: [] })).status, 400);
  assert.equal((await post({ items: [{ type: 'text', text: 'x' }], pin: '12a4' })).status, 400);
  assert.equal((await post({ items: [{ type: 'image', mime: 'image/svg+xml', data: 'AAAA' }] })).status, 400);
  assert.equal((await post({ items: [{ type: 'image', mime: 'image/png', data: '<script>' }] })).status, 400);
  assert.equal((await post({ items: [{ type: 'text', text: 'x'.repeat(21 * 1024 * 1024) }] })).status, 413);
});

test('expired clips are not served', async () => {
  const { data } = await call('POST', '/api/clips', { body: { items: [{ type: 'text', text: 'bye' }] } });
  const meta = JSON.parse(env.CLIPS.store.get(`meta:${data.id}`).value);
  meta.expiresAt = Date.now() - 1;
  env.CLIPS.store.get(`meta:${data.id}`).value = JSON.stringify(meta);
  assert.equal((await call('GET', `/api/clips/${data.id}`)).status, 404);
});

test('delete removes clip', async () => {
  const { data } = await call('POST', '/api/clips', { body: { items: [{ type: 'text', text: 'x' }], pin: '9999' } });
  assert.equal((await call('DELETE', `/api/clips/${data.id}`)).status, 401);
  assert.equal((await call('DELETE', `/api/clips/${data.id}`, { pin: '9999' })).status, 200);
  assert.equal((await call('GET', `/api/clips/${data.id}/meta`)).status, 404);
});

test('unknown routes and bad ids 404; missing KV binding is reported', async () => {
  assert.equal((await call('GET', '/api/clips/zzzzzzzz')).status, 404);
  assert.equal((await call('GET', '/api/clips/../../x')).status, 404);
  assert.equal((await call('GET', '/api/nope')).status, 404);
  env = {};
  const r = await call('GET', '/api/clips/abcdefgh');
  assert.equal(r.status, 500);
  assert.match(r.data.error, /CLIPS/);
});

// ---------------- persistent pages ----------------
const newPage = async (pin = '1234') => (await call('POST', '/api/pages', { body: { pin } })).data;
const sendClip = (pid, text = 'hi', pagePin = '1234') =>
  call('POST', `/api/pages/${pid}/clips`, { body: { items: [{ type: 'text', text }] }, pagePin });
const pageRecord = (pid) => env.CLIPS.store.get(`page:${pid}`);

test('page: requires a 4-digit PIN and gets a stable /p/<id> URL', async () => {
  assert.equal((await call('POST', '/api/pages', { body: {} })).status, 400);
  assert.equal((await call('POST', '/api/pages', { body: { pin: '12' } })).status, 400);
  const { status, data } = await call('POST', '/api/pages', { body: { pin: '1234' } });
  assert.equal(status, 201);
  assert.match(data.id, /^[a-z2-9]{16}$/);
  assert.equal(data.url, `/p/${data.id}`);
  assert.equal(data.expiresAt - data.createdAt, PAGE_TTL_SECONDS * 1000);
  assert.equal(data.pinHash, undefined);

  const meta = await call('GET', `/api/pages/${data.id}/meta`);
  assert.equal(meta.status, 200);
  assert.equal(meta.data.hasPin, true);
  assert.equal(meta.data.clips, undefined);
});

test('page: every read/write needs the PIN', async () => {
  const { id } = await newPage();
  assert.equal((await call('GET', `/api/pages/${id}`)).status, 401);
  assert.equal((await call('POST', `/api/pages/${id}/clips`, { body: { items: [{ type: 'text', text: 'x' }] } })).status, 401);
  assert.equal((await call('GET', `/api/pages/${id}`, { pagePin: '1234' })).status, 200);
  // The one-off clip header must not unlock a page.
  assert.equal((await call('GET', `/api/pages/${id}`, { pin: '1234' })).status, 401);
});

test('page: clips keep a 1h TTL and each new clip pushes page expiry to 6h after it', async () => {
  const { id, expiresAt: firstExpiry } = await newPage();
  // Pretend the page is 5 hours old and nearly expired.
  const rec = JSON.parse(pageRecord(id).value);
  rec.expiresAt = Date.now() + 60 * 60 * 1000;
  rec.lastClipAt = Date.now() - 5 * 60 * 60 * 1000;
  pageRecord(id).value = JSON.stringify(rec);

  const sent = await sendClip(id, 'hello');
  assert.equal(sent.status, 201);
  const clip = sent.data.clip;
  assert.equal(clip.expiresAt - clip.createdAt, TTL_SECONDS * 1000);
  assert.equal(sent.data.expiresAt - clip.createdAt, PAGE_TTL_SECONDS * 1000);
  assert.ok(sent.data.expiresAt > firstExpiry - 1000);
  assert.equal(env.CLIPS.store.get(`pclip:${id}:${clip.id}`).exp - Math.floor(clip.createdAt / 1000), TTL_SECONDS);
  assert.equal(pageRecord(id).exp, Math.ceil(sent.data.expiresAt / 1000));

  const view = await call('GET', `/api/pages/${id}`, { pagePin: '1234' });
  assert.equal(view.data.clips.length, 1);
  assert.equal(view.data.clips[0].texts, 1);
  assert.equal(view.data.clips[0].items, undefined);

  const got = await call('GET', `/api/pages/${id}/clips/${clip.id}`, { pagePin: '1234' });
  assert.equal(got.data.items[0].text, 'hello');
});

test('page: expired clips disappear but the page and its URL stay', async () => {
  const { id } = await newPage();
  const { data } = await sendClip(id, 'old');
  const rec = JSON.parse(pageRecord(id).value);
  rec.clips[0].expiresAt = Date.now() - 1;
  pageRecord(id).value = JSON.stringify(rec);

  const view = await call('GET', `/api/pages/${id}`, { pagePin: '1234' });
  assert.equal(view.status, 200);
  assert.deepEqual(view.data.clips, []);
  assert.equal((await call('GET', `/api/pages/${id}/clips/${data.clip.id}`, { pagePin: '1234' })).status, 404);
  assert.equal((await sendClip(id, 'new')).status, 201);
});

test('page: gone 6 hours after the last clip', async () => {
  const { id } = await newPage();
  const rec = JSON.parse(pageRecord(id).value);
  rec.expiresAt = Date.now() - 1;
  pageRecord(id).value = JSON.stringify(rec);
  assert.equal((await call('GET', `/api/pages/${id}/meta`)).status, 404);
  assert.equal((await call('GET', `/api/pages/${id}`, { pagePin: '1234' })).status, 404);
  assert.equal((await sendClip(id)).status, 404);
});

test('page: too many wrong PINs delete the page and its clips', async () => {
  const { id } = await newPage();
  const { data } = await sendClip(id);
  for (let i = 1; i <= MAX_PIN_ATTEMPTS; i++) {
    const r = await call('GET', `/api/pages/${id}`, { pagePin: '0000' });
    assert.equal(r.status, i < MAX_PIN_ATTEMPTS ? 403 : 410);
  }
  assert.equal(env.CLIPS.store.has(`page:${id}`), false);
  assert.equal(env.CLIPS.store.has(`pclip:${id}:${data.clip.id}`), false);
  assert.equal((await call('GET', `/api/pages/${id}`, { pagePin: '1234' })).status, 404);
});

test('page: limits clips, deletes a clip, deletes the page', async () => {
  const { id } = await newPage();
  for (let i = 0; i < MAX_PAGE_CLIPS; i++) assert.equal((await sendClip(id, `c${i}`)).status, 201);
  assert.equal((await sendClip(id, 'one too many')).status, 400);

  const view = await call('GET', `/api/pages/${id}`, { pagePin: '1234' });
  const before = pageRecord(id).exp;
  const first = view.data.clips[0].id;
  assert.equal((await call('DELETE', `/api/pages/${id}/clips/${first}`)).status, 401);
  assert.equal((await call('DELETE', `/api/pages/${id}/clips/${first}`, { pagePin: '1234' })).status, 200);
  assert.equal(pageRecord(id).exp, before, 'deleting a clip must not extend the page');
  assert.equal(env.CLIPS.store.has(`pclip:${id}:${first}`), false);
  assert.equal((await sendClip(id, 'fits again')).status, 201);

  assert.equal((await call('DELETE', `/api/pages/${id}`, { pagePin: '1234' })).status, 200);
  assert.equal(env.CLIPS.store.size, 0);
});

test('page: bad ids and routes 404', async () => {
  assert.equal((await call('GET', '/api/pages/short/meta')).status, 404);
  assert.equal((await call('GET', '/api/pages/zzzzzzzzzzzzzzzz/meta')).status, 404);
  const { id } = await newPage();
  assert.equal((await call('GET', `/api/pages/${id}/clips/notanid`, { pagePin: '1234' })).status, 404);
  assert.equal((await call('PUT', `/api/pages/${id}`, { pagePin: '1234' })).status, 404);
});
