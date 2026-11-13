'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createServer, CONFIG, clips, sweep, _reset } = require('../server');

let server;
let base;

before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => _reset());

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function create(body) {
  const res = await fetch(`${base}/api/clips`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

test('create and read a text + image clip without PIN', async () => {
  const { status, data } = await create({
    items: [{ type: 'text', text: '안녕 hello' }, { type: 'image', mime: 'image/png', data: PNG_1PX }],
  });
  assert.equal(status, 201);
  assert.match(data.id, /^[a-z2-9]{8}$/);
  assert.equal(data.url, `/${data.id}`);
  assert.equal(data.hasPin, false);
  assert.ok(data.expiresAt - data.createdAt === CONFIG.ttlMs);

  const res = await fetch(`${base}/api/clips/${data.id}`);
  assert.equal(res.status, 200);
  const clip = await res.json();
  assert.equal(clip.items[0].text, '안녕 hello');
  assert.equal(clip.items[1].data, PNG_1PX);

  const page = await fetch(`${base}/${data.id}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /CloudClip/);
});

test('PIN protects the clip and too many wrong attempts delete it', async () => {
  const { data } = await create({ items: [{ type: 'text', text: 'secret' }], pin: '1234' });
  assert.equal(data.hasPin, true);

  const meta = await (await fetch(`${base}/api/clips/${data.id}/meta`)).json();
  assert.equal(meta.hasPin, true);
  assert.equal(meta.items, undefined);

  let res = await fetch(`${base}/api/clips/${data.id}`);
  assert.equal(res.status, 401);

  res = await fetch(`${base}/api/clips/${data.id}`, { headers: { 'X-Clip-Pin': '1234' } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).items[0].text, 'secret');

  for (let i = 1; i <= CONFIG.maxPinAttempts; i++) {
    res = await fetch(`${base}/api/clips/${data.id}`, { headers: { 'X-Clip-Pin': '0000' } });
    assert.equal(res.status, i < CONFIG.maxPinAttempts ? 403 : 410);
  }
  res = await fetch(`${base}/api/clips/${data.id}`, { headers: { 'X-Clip-Pin': '1234' } });
  assert.equal(res.status, 404);
});

test('rejects invalid input', async () => {
  assert.equal((await create({ items: [] })).status, 400);
  assert.equal((await create({ items: [{ type: 'text', text: 'x' }], pin: '12a4' })).status, 400);
  assert.equal((await create({ items: [{ type: 'image', mime: 'image/svg+xml', data: 'AAAA' }] })).status, 400);
  assert.equal((await create({ items: [{ type: 'image', mime: 'image/png', data: '<script>' }] })).status, 400);
});

test('clips expire', async () => {
  const { data } = await create({ items: [{ type: 'text', text: 'bye' }] });
  clips.get(data.id).expiresAt = Date.now() - 1;
  const res = await fetch(`${base}/api/clips/${data.id}`);
  assert.equal(res.status, 404);
  sweep();
  assert.equal(clips.size, 0);
});

test('delete removes clip', async () => {
  const { data } = await create({ items: [{ type: 'text', text: 'x' }], pin: '9999' });
  let res = await fetch(`${base}/api/clips/${data.id}`, { method: 'DELETE', headers: { 'X-Clip-Pin': '9999' } });
  assert.equal(res.status, 200);
  res = await fetch(`${base}/api/clips/${data.id}/meta`);
  assert.equal(res.status, 404);
});

test('unknown paths 404 and static assets are served', async () => {
  assert.equal((await fetch(`${base}/not-a-valid-id`)).status, 404);
  assert.equal((await fetch(`${base}/api/clips/zzzzzzzz`)).status, 404);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/../server.js`)).status, 404);
});
