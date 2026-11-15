import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/p/[id].js';

const PID = 'abcdefghjkmnpqrs'; // 16 chars from the id alphabet
const kvWith = (page) => ({ get: async (key) => (key === `page:${PID}` ? page : null) });
const run = (id, env) =>
  onRequestGet({
    request: new Request(`https://clip.example.com/p/${id}`),
    params: { id },
    env: { ASSETS: { fetch: async () => new Response('<html>app</html>') }, ...env },
  });

test('page route: unknown / expired / malformed page ids redirect to the home page', async () => {
  for (const [id, page] of [[PID, null], [PID, { expiresAt: Date.now() - 1 }], ['short', null]]) {
    const res = await run(id, { CLIPS: kvWith(page) });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), 'https://clip.example.com/?page=gone');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  }
});

test('page route: an existing page serves the app', async () => {
  const res = await run(PID, { CLIPS: kvWith({ expiresAt: Date.now() + 60_000 }) });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<html>app</html>');
});
