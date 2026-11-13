import { ID_RE } from '../lib/api.js';

// /<clip-id> (e.g. /ab3k9xyz) serves the app page; the page itself loads the clip.
export const onRequestGet = async ({ request, params, env, next }) => {
  if (!ID_RE.test(params.id)) return next();
  const page = await env.ASSETS.fetch(new URL('/', request.url));
  const res = new Response(page.body, page);
  res.headers.set('Cache-Control', 'no-store');
  return res;
};
