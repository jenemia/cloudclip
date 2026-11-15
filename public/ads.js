'use strict';

/**
 * Google tag (Google Ads + optional GA4) with Consent Mode v2.
 *
 * Loaded only on public pages (home, privacy) and only when the IDs are configured
 * as Cloudflare environment variables — see functions/_middleware.js and README.
 * Never loaded on private clip pages.
 *
 * Config is read from <meta name="cc-gtag" data-ads-id data-ads-label data-ga-id>.
 */
(() => {
  const cfg = document.querySelector('meta[name="cc-gtag"]');
  if (!cfg) return;
  const adsId = cfg.dataset.adsId || ''; // AW-XXXXXXXXXX
  const adsLabel = cfg.dataset.adsLabel || ''; // conversion label
  const gaId = cfg.dataset.gaId || ''; // G-XXXXXXXXXX
  const primary = adsId || gaId;
  if (!primary) return;

  const KEY = 'cc-consent'; // 'granted' | 'denied'
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const write = (v) => { try { localStorage.setItem(KEY, v); } catch { /* private mode */ } };

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  // Consent Mode v2: everything denied until the visitor chooses.
  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    wait_for_update: 500,
  });
  // Keep gclid/wbraid in the URL so conversions can be measured cookielessly.
  gtag('set', 'url_passthrough', true);
  gtag('set', 'ads_data_redaction', true);

  const grant = (granted) => {
    const v = granted ? 'granted' : 'denied';
    gtag('consent', 'update', { ad_storage: v, ad_user_data: v, ad_personalization: v, analytics_storage: v });
  };
  const saved = read();
  if (saved) grant(saved === 'granted');

  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(primary)}`;
  document.head.appendChild(s);

  gtag('js', new Date());
  if (adsId) gtag('config', adsId);
  if (gaId) gtag('config', gaId, { anonymize_ip: true });

  /** Called by app.js: 'generate_link' (share link created) and 'create_page' (persistent page) are conversions. */
  const CONVERSIONS = new Set(['generate_link', 'create_page']);
  window.ccTrack = (name, params = {}) => {
    if (gaId) gtag('event', name, { ...params, transport_type: 'beacon' });
    if (adsId && adsLabel && CONVERSIONS.has(name)) {
      gtag('event', 'conversion', { send_to: `${adsId}/${adsLabel}`, transport_type: 'beacon' });
    }
  };

  // ---------- consent banner ----------
  function banner() {
    if (document.getElementById('consent')) return;
    const box = document.createElement('div');
    box.id = 'consent';
    box.className = 'consent';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', '쿠키 동의');
    const p = document.createElement('p');
    p.append('서비스 개선과 광고 성과 측정을 위해 Google 쿠키를 사용합니다. 붙여넣은 내용은 수집하지 않습니다. ');
    const a = document.createElement('a');
    a.href = '/privacy';
    a.textContent = '자세히';
    p.appendChild(a);
    const row = document.createElement('div');
    row.className = 'consent-actions';
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'secondary';
    no.textContent = '거부';
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'primary';
    yes.textContent = '동의';
    const choose = (ok) => () => { write(ok ? 'granted' : 'denied'); grant(ok); box.remove(); };
    no.addEventListener('click', choose(false));
    yes.addEventListener('click', choose(true));
    row.append(no, yes);
    box.append(p, row);
    document.body.appendChild(box);
  }

  const start = () => {
    if (!read()) banner();
    const settings = document.getElementById('consent-settings');
    if (settings) {
      settings.hidden = false;
      settings.addEventListener('click', banner);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
