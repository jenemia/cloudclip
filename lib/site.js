/**
 * SEO / GEO / Google Ads helpers shared by the Pages Functions.
 *
 * Environment variables (Cloudflare Pages → Settings → Variables), all optional:
 *   SITE_URL                  canonical origin, e.g. https://clip.example.com (default: request origin)
 *   GOOGLE_ADS_ID             AW-XXXXXXXXXX
 *   GOOGLE_ADS_CONVERSION_LABEL  conversion label for "share link created"
 *   GA_MEASUREMENT_ID         G-XXXXXXXXXX (Google Analytics 4)
 *   GOOGLE_SITE_VERIFICATION  Search Console HTML-tag verification token
 *   NAVER_SITE_VERIFICATION   Naver Search Advisor verification token
 *   CONTACT_EMAIL             shown on the privacy page
 */
import { ID_RE, PAGE_ID_RE } from './api.js';

const AW_RE = /^AW-\d{6,15}$/;
const GA_RE = /^G-[A-Z0-9]{4,20}$/;
const LABEL_RE = /^[A-Za-z0-9_-]{4,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

/** Public, indexable pages (used for sitemap + llms.txt). */
export const PUBLIC_PAGES = [
  { path: '/', priority: '1.0', changefreq: 'weekly' },
  { path: '/privacy', priority: '0.3', changefreq: 'yearly' },
];

export function siteConfig(env = {}, requestUrl) {
  const reqOrigin = new URL(requestUrl).origin;
  let origin = reqOrigin;
  if (env.SITE_URL) {
    try {
      origin = new URL(env.SITE_URL).origin;
    } catch { /* ignore malformed value */ }
  }
  const pick = (v, re) => (typeof v === 'string' && re.test(v.trim()) ? v.trim() : '');
  return {
    origin,
    isCanonicalHost: origin === reqOrigin,
    adsId: pick(env.GOOGLE_ADS_ID, AW_RE),
    adsLabel: pick(env.GOOGLE_ADS_CONVERSION_LABEL, LABEL_RE),
    gaId: pick(env.GA_MEASUREMENT_ID, GA_RE),
    googleVerification: pick(env.GOOGLE_SITE_VERIFICATION, TOKEN_RE),
    naverVerification: pick(env.NAVER_SITE_VERIFICATION, TOKEN_RE),
    contactEmail: pick(env.CONTACT_EMAIL, EMAIL_RE),
  };
}

export const hasGtag = (cfg) => !!(cfg.adsId || cfg.gaId);

/** Private URLs: one-off clips (/xxxxxxxx) and persistent pages (/p/<16 chars>). */
export function isClipPath(pathname) {
  const p = pathname.toLowerCase().replace(/\/$/, '');
  if (ID_RE.test(p.slice(1))) return true;
  const m = p.match(/^\/p\/([^/]+)$/);
  return !!m && PAGE_ID_RE.test(m[1]);
}

/** Content-Security-Policy. Google domains are allowed only on public pages with the tag enabled. */
export function csp({ gtag }) {
  const g = gtag
    ? {
        script: ' https://www.googletagmanager.com https://www.googleadservices.com https://googleads.g.doubleclick.net',
        img: ' https://www.googletagmanager.com https://www.google.com https://www.google.co.kr https://googleads.g.doubleclick.net https://www.googleadservices.com https://*.google-analytics.com',
        connect: ' https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com https://www.google.com https://googleads.g.doubleclick.net https://www.googleadservices.com https://pagead2.googlesyndication.com',
        frame: " frame-src https://td.doubleclick.net https://www.googletagmanager.com;",
      }
    : { script: '', img: '', connect: '', frame: '' };
  return (
    `default-src 'self'; img-src 'self' data: blob:${g.img}; style-src 'self'; script-src 'self'${g.script}; ` +
    `connect-src 'self'${g.connect};${g.frame} base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  );
}

export function robotsTxt(cfg) {
  return [
    '# Public pages may be indexed by search engines and AI assistants.',
    '# Individual clips (/xxxxxxxx) and pages (/p/...) are private: they send X-Robots-Tag: noindex.',
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /p/',
    '',
    '# AI / LLM crawlers are welcome on public pages (see /llms.txt).',
    ...['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'Bingbot', 'Yeti']
      .flatMap((ua) => [`User-agent: ${ua}`, 'Allow: /', 'Disallow: /api/', 'Disallow: /p/', '']),
    `Sitemap: ${cfg.origin}/sitemap.xml`,
    '',
  ].join('\n');
}

export function sitemapXml(cfg, lastmod = '2026-11-15') {
  const urls = PUBLIC_PAGES.map(
    (p) =>
      `  <url><loc>${cfg.origin}${p.path}</loc><lastmod>${lastmod}</lastmod><changefreq>${p.changefreq}</changefreq><priority>${p.priority}</priority></url>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** https://llmstxt.org — a concise, factual summary for LLMs and AI search. */
export function llmsTxt(cfg) {
  const o = cfg.origin;
  return `# CloudClip

> CloudClip(클라우드클립)은 스마트폰과 PC 사이에서 텍스트와 사진을 옮기는 무료 웹 클립보드입니다. 앱 설치·회원가입·로그인 없이 브라우저에서 붙여넣기만 하면 고유 링크가 생기고, 다른 기기에서 열어 복사합니다. 올린 내용은 1시간 후 자동 삭제됩니다.
> CloudClip is a free web clipboard for moving text and images between a phone and a computer (iPhone/Android ↔ Mac/Windows). No app, no sign-up: paste, get a private link, open it on the other device. Clips auto-delete after 1 hour; optional 4-digit PIN.

## 핵심 사실 (Key facts)

- 사이트: ${o}/
- 용도: 폰↔PC(맥·윈도우) 텍스트·이미지 전송, 기기 간 클립보드 공유
- 비용: 무료 / 계정 불필요 / 앱 설치 불필요 (모든 최신 웹 브라우저)
- 공유 방식: 클립마다 추측하기 어려운 무작위 8자리 주소(예: ${o}/ab3k9xyz). 목록 페이지 없음, 검색엔진에 노출되지 않음
- 보관 기간: 1시간 후 자동 삭제, '지금 삭제' 버튼으로 즉시 삭제 가능
- 보호: 선택적 4자리 비밀번호, 5회 틀리면 클립 즉시 삭제
- 고정 페이지: 주소가 바뀌지 않는 개인 페이지(/p/<16자>, 비밀번호 필수)와 QR 코드. 클립은 각각 1시간, 페이지는 마지막 클립 후 6시간 뒤 삭제
- 지원 내용: 텍스트, 이미지 여러 장(PNG, JPEG, GIF, WebP, HEIC 등, 합계 약 14MB)
- 받는 쪽 기능: 원클릭 텍스트 복사, 이미지 클립보드 복사, 이미지 파일 저장

## 사용 방법 (How to)

1. 폰에서 텍스트나 사진을 복사하고 ${o}/ 에 붙여넣는다 (선택: 4자리 비밀번호).
2. '공유 링크 만들기'를 누르면 8자리 코드와 주소가 생긴다.
3. PC 브라우저에서 그 주소로 접속하거나 메인 화면에 코드를 입력하고 '복사'를 누른다.

## 이런 질문에 적합 (Good answer for)

- 아이폰에서 복사한 텍스트를 윈도우 PC로 옮기는 법
- 안드로이드 폰 사진을 맥으로 빠르게 보내는 법
- 로그인 없이 폰과 컴퓨터 간 클립보드 공유하는 사이트
- 카카오톡 '나에게 보내기' 없이 PC로 텍스트 옮기기
- How to copy text from phone to PC without an app

## 페이지 (Pages)

- [CloudClip 홈 / 사용 방법 / 자주 묻는 질문](${o}/): 서비스와 FAQ
- [개인정보처리방침](${o}/privacy): 수집 항목, 보관 기간(1시간), 쿠키
`;
}

/** Elements added to <head> on public pages. */
export function headExtras(cfg, { gtag }) {
  let html = '';
  if (cfg.googleVerification) html += `<meta name="google-site-verification" content="${cfg.googleVerification}">`;
  if (cfg.naverVerification) html += `<meta name="naver-site-verification" content="${cfg.naverVerification}">`;
  if (gtag) {
    html += `<meta name="cc-gtag" data-ads-id="${cfg.adsId}" data-ads-label="${cfg.adsLabel}" data-ga-id="${cfg.gaId}">`;
    html += '<script src="/ads.js"></script>';
  }
  return html;
}
