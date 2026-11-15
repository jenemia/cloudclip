import { siteConfig, sitemapXml } from '../lib/site.js';

export const onRequestGet = ({ request, env }) =>
  new Response(sitemapXml(siteConfig(env, request.url)), {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
  });
