import { PAGE_ID_RE } from '../../lib/api.js';

const home = (request) =>
  new Response(null, { status: 302, headers: { Location: new URL('/?page=gone', request.url).href, 'Cache-Control': 'no-store' } });

// /p/<page-id> serves the app page (it asks for the PIN and loads the clips).
// A page that was never issued, or has expired, goes to the home page instead, which offers to issue one.
export const onRequestGet = async ({ request, params, env }) => {
  if (!PAGE_ID_RE.test(params.id)) return home(request);
  if (env.CLIPS) {
    const page = await env.CLIPS.get(`page:${params.id}`, 'json');
    if (!page || page.expiresAt <= Date.now()) return home(request);
  }
  const app = await env.ASSETS.fetch(new URL('/', request.url));
  const res = new Response(app.body, app);
  res.headers.set('Cache-Control', 'no-store');
  return res;
};
