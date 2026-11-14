import { PAGE_ID_RE } from '../../lib/api.js';

// /p/<page-id> (e.g. /p/ab3k9xyzab3k9xyz) serves the app page; the page itself asks for the PIN and loads the clips.
export const onRequestGet = async ({ request, params, env, next }) => {
  if (!PAGE_ID_RE.test(params.id)) return next();
  const page = await env.ASSETS.fetch(new URL('/', request.url));
  const res = new Response(page.body, page);
  res.headers.set('Cache-Control', 'no-store');
  return res;
};
