import { siteConfig, llmsTxt } from '../lib/site.js';

export const onRequestGet = ({ request, env }) =>
  new Response(llmsTxt(siteConfig(env, request.url)), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
  });
