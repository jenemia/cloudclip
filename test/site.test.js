import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteConfig, hasGtag, isClipPath, csp, robotsTxt, sitemapXml, llmsTxt, headExtras } from '../lib/site.js';

const REQ = 'https://cloudclip.pages.dev/';

test('siteConfig uses SITE_URL as canonical origin and validates IDs', () => {
  const cfg = siteConfig(
    {
      SITE_URL: 'https://clip.example.com/some/path',
      GOOGLE_ADS_ID: 'AW-123456789',
      GOOGLE_ADS_CONVERSION_LABEL: 'AbC-dEf_123',
      GA_MEASUREMENT_ID: 'G-ABC123XYZ',
      GOOGLE_SITE_VERIFICATION: 'abcdefgh12345678',
      CONTACT_EMAIL: 'hello@example.com',
    },
    REQ,
  );
  assert.equal(cfg.origin, 'https://clip.example.com');
  assert.equal(cfg.isCanonicalHost, false);
  assert.equal(cfg.adsId, 'AW-123456789');
  assert.equal(cfg.adsLabel, 'AbC-dEf_123');
  assert.equal(cfg.gaId, 'G-ABC123XYZ');
  assert.equal(cfg.contactEmail, 'hello@example.com');
  assert.ok(hasGtag(cfg));
});

test('siteConfig falls back to request origin and rejects injected values', () => {
  const cfg = siteConfig({ GOOGLE_ADS_ID: 'AW-1"><script>', GA_MEASUREMENT_ID: 'x', CONTACT_EMAIL: '"><b>' }, REQ);
  assert.equal(cfg.origin, 'https://cloudclip.pages.dev');
  assert.equal(cfg.isCanonicalHost, true);
  assert.equal(cfg.adsId, '');
  assert.equal(cfg.gaId, '');
  assert.equal(cfg.contactEmail, '');
  assert.equal(hasGtag(cfg), false);
  assert.equal(headExtras(cfg, { gtag: false }), '');
});

test('clip paths are detected', () => {
  assert.equal(isClipPath('/ab3k9xyz'), true);
  assert.equal(isClipPath('/p/ab3k9xyzab3k9xyz'), true);
  assert.equal(isClipPath('/p/short'), false);
  assert.equal(isClipPath('/privacy'), false);
  assert.equal(isClipPath('/'), false);
});

test('CSP only allows Google where the tag is enabled', () => {
  assert.doesNotMatch(csp({ gtag: false }), /google/);
  const withTag = csp({ gtag: true });
  assert.match(withTag, /script-src 'self' https:\/\/www\.googletagmanager\.com/);
  assert.match(withTag, /frame-ancestors 'none'/);
  assert.doesNotMatch(withTag, /unsafe-inline/);
});

test('robots.txt allows public pages + AI crawlers, blocks API, links sitemap', () => {
  const txt = robotsTxt(siteConfig({}, REQ));
  assert.match(txt, /User-agent: \*\nAllow: \/\nDisallow: \/api\/\nDisallow: \/p\//);
  for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'Yeti']) assert.match(txt, new RegExp(`User-agent: ${bot}`));
  assert.match(txt, /Sitemap: https:\/\/cloudclip\.pages\.dev\/sitemap\.xml/);
});

test('sitemap and llms.txt use absolute canonical URLs and never list clips', () => {
  const cfg = siteConfig({ SITE_URL: 'https://clip.example.com' }, REQ);
  const xml = sitemapXml(cfg);
  assert.match(xml, /<loc>https:\/\/clip\.example\.com\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/clip\.example\.com\/privacy<\/loc>/);
  const llms = llmsTxt(cfg);
  assert.match(llms, /^# CloudClip\n\n> /);
  assert.match(llms, /https:\/\/clip\.example\.com\/privacy/);
});

test('headExtras injects verification and gtag config', () => {
  const cfg = siteConfig({ GOOGLE_ADS_ID: 'AW-123456789', GOOGLE_SITE_VERIFICATION: 'tok_1234567890', NAVER_SITE_VERIFICATION: 'nav1234567890' }, REQ);
  const html = headExtras(cfg, { gtag: true });
  assert.match(html, /google-site-verification" content="tok_1234567890"/);
  assert.match(html, /naver-site-verification" content="nav1234567890"/);
  assert.match(html, /data-ads-id="AW-123456789"/);
  assert.match(html, /<script src="\/ads\.js"><\/script>/);
});
