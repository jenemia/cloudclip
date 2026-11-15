import { siteConfig, hasGtag, isClipPath, csp, headExtras } from '../lib/site.js';

/**
 * Runs for every request routed to Functions (see public/_routes.json).
 * For HTML pages it:
 *  - makes canonical / og:url / og:image absolute (SITE_URL or request origin)
 *  - marks private clip pages and non-canonical hosts (e.g. *.pages.dev) noindex
 *  - injects search-console verification + Google tag (public pages only)
 *  - sets security headers (CSP allows Google only where the tag is loaded)
 */
export async function onRequest({ request, env, next }) {
  const res = await next();
  const type = res.headers.get('Content-Type') || '';
  if (!type.includes('text/html')) return res;

  const url = new URL(request.url);
  const cfg = siteConfig(env, request.url);
  const clip = isClipPath(url.pathname);
  const gtag = !clip && hasGtag(cfg);
  const pageUrl = `${cfg.origin}${url.pathname === '/index.html' ? '/' : url.pathname}`;

  const out = new Response(res.body, res);
  const h = out.headers;
  h.set('Content-Security-Policy', csp({ gtag }));
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Clip URLs are secrets: never leak them via Referer.
  h.set('Referrer-Policy', clip ? 'no-referrer' : 'strict-origin-when-cross-origin');
  if (clip || !cfg.isCanonicalHost || res.status >= 400) h.set('X-Robots-Tag', 'noindex, nofollow');
  else h.delete('X-Robots-Tag');
  if (clip) h.set('Cache-Control', 'no-store');

  const absolutize = (attr) => ({
    element(el) {
      const v = el.getAttribute(attr);
      if (v && v.startsWith('/')) el.setAttribute(attr, v === '/' ? pageUrl : `${cfg.origin}${v}`);
    },
  });

  let rw = new HTMLRewriter()
    .on('link[rel="canonical"]', absolutize('href'))
    .on('meta[property="og:url"]', absolutize('content'))
    .on('meta[property="og:image"]', absolutize('content'))
    .on('meta[name="twitter:image"]', absolutize('content'))
    .on('[data-contact]', {
      element(el) {
        if (cfg.contactEmail) {
          el.setInnerContent(cfg.contactEmail);
          el.setAttribute('href', `mailto:${cfg.contactEmail}`);
        }
      },
    });

  if (clip) {
    rw = rw
      .on('meta[name="robots"]', { element: (el) => el.setAttribute('content', 'noindex, nofollow') })
      .on('script[type="application/ld+json"]', { element: (el) => el.remove() })
      .on('link[rel="canonical"]', { element: (el) => el.remove() });
  } else {
    const extras = headExtras(cfg, { gtag });
    if (extras) rw = rw.on('head', { element: (el) => el.append(extras, { html: true }) });
  }
  return rw.transform(out);
}
