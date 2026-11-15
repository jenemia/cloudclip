# CloudClip 📋

스마트폰 ↔ PC 간에 텍스트·이미지를 웹으로 옮기는 임시 클립보드 서비스입니다.
Cloudflare Pages(화면) + Pages Functions(API) + Workers KV(저장소)로 동작합니다.

## 사용 시나리오

1. **스마트폰**에서 텍스트/사진 복사 → 사이트 접속 → 붙여넣기 → (선택) 4자리 비밀번호 → **공유 링크 만들기**
2. `https://도메인/ab3k9xyz` 같은 고유 주소와 8자리 코드가 생성됨
3. **Mac/PC 브라우저**에서 그 주소로 접속(또는 메인 화면에 코드 입력) → 비밀번호 입력 → **복사** / **저장**

## 기능

- 텍스트 + 이미지(여러 장) 붙여넣기: `Ctrl/⌘+V`, 모바일 길게 눌러 붙여넣기, "클립보드에서 가져오기", 사진 선택
- 클립마다 추측하기 어려운 랜덤 주소(`/xxxxxxxx`) — 목록 페이지 없음
- **1시간 후 자동 삭제** (KV 만료 기능 사용), 남은 시간 표시, "지금 삭제" 버튼
- **선택적 4자리 비밀번호** — 5회 틀리면 클립 즉시 삭제
- **📌 고정 페이지** — 주소가 바뀌지 않는 나만의 페이지(`/p/<16자>`). 아래 [고정 페이지](#고정-페이지) 참고
- 한 번에 올릴 수 있는 용량: 약 14MB (이미지 합계)
- HTTPS는 Cloudflare가 자동 처리

## 고정 페이지

메인 화면에서 **4자리 비밀번호**를 정해 *고정 페이지 만들기*를 누르면 `https://도메인/p/<16자>` 주소가 생깁니다.

- 페이지 주소는 그대로 유지되고, 여기에 붙여넣은 **클립은 각각 1시간 뒤 삭제**됩니다.
- **마지막 클립이 도착한 뒤 6시간**이 지나면 페이지도 삭제됩니다. (클립을 보낼 때마다 6시간이 새로 시작되고, 클립이 하나도 없으면 만든 시각부터 셉니다. 클립을 지워도 연장되지 않습니다.)
- 페이지 화면에 **QR 코드**와 주소가 표시됩니다. 다른 기기에서 스캔하고 비밀번호를 입력하면 같은 페이지를 열 수 있습니다. (QR에는 비밀번호가 들어 있지 않습니다.)
- 비밀번호 5회 오류 시 페이지와 클립이 삭제됩니다. 비밀번호는 항상 필요합니다.
- 이 기기에서 만든/연 페이지 주소는 브라우저(localStorage)에 기억되어 메인 화면에 *내 고정 페이지 열기*가 나타납니다. 브라우저 데이터를 지웠다면 주소나 QR로 다시 여세요. 비밀번호는 탭을 닫으면 잊혀집니다.
- 페이지당 클립은 최대 20개입니다. 페이지를 연 화면은 5초마다 새 클립을 확인합니다.
- 두 기기에서 **동시에** 올리면 드물게 한쪽 클립이 목록에서 빠질 수 있습니다. (KV는 원자적 갱신을 지원하지 않습니다.) 그 클립은 1시간 뒤 사라집니다.

KV 쓰기 한도: 고정 페이지에서 클립 1개 = 쓰기 2회(클립 + 페이지 갱신)입니다.

## Cloudflare 배포 (처음 한 번)

### 1. KV 저장소 만들기

Cloudflare 대시보드 → **Storage & Databases → Workers KV → Create** → 이름 `cloudclip` 으로 생성

### 2. Pages 프로젝트 만들기

**Workers & Pages → Create → Pages → Connect to Git** → `jenemia/cloudclip` 선택

| 항목 | 값 |
| --- | --- |
| 프로덕션 브랜치 | `main` |
| 프레임워크 프리셋 | None |
| 빌드 명령 | (비워 둠) |
| 빌드 출력 디렉터리 | `public` |
| 루트 디렉터리 | 저장소 루트 |
| 환경 변수 | `SKIP_DEPENDENCY_INSTALL=1` (로컬 개발용 패키지 설치를 건너뜀) |

### 3. KV 연결 (바인딩)

만든 Pages 프로젝트 → **Settings → Bindings → Add → KV namespace**

| Variable name | KV namespace |
| --- | --- |
| `CLIPS` | `cloudclip` |

바인딩 추가 후 **Deployments**에서 최신 배포를 **Retry deployment** 해야 적용됩니다.
(Preview 배포에서도 쓰려면 Preview 환경에도 같은 바인딩을 추가하세요.)

### 4. 확인

발급된 `https://<프로젝트>.pages.dev` 에서 붙여넣기 → 링크 생성 → 다른 기기에서 열기를 확인합니다.
도메인을 연결하려면 **Custom domains** 에서 추가합니다 (예: `clip.puzzletro.com` 같은 하위 도메인).

이후에는 `main`에 push하면 자동으로 배포됩니다.

### 5. 환경 변수 (선택)

**Settings → Variables and Secrets** 에 추가하고 재배포합니다. 값이 없으면 해당 기능만 꺼집니다.

| 변수 | 예시 | 용도 |
| --- | --- | --- |
| `SITE_URL` | `https://clip.example.com` | 대표 주소. canonical·sitemap에 사용되고, 다른 주소(`*.pages.dev`)는 검색 제외(noindex) 처리 |
| `GOOGLE_ADS_ID` | `AW-1234567890` | Google Ads 태그 |
| `GOOGLE_ADS_CONVERSION_LABEL` | `AbCdEfGh123` | 전환 라벨 (전환 = 공유 링크 생성) |
| `GA_MEASUREMENT_ID` | `G-XXXXXXXXXX` | Google Analytics 4 (선택) |
| `GOOGLE_SITE_VERIFICATION` | `abc…` | Search Console 소유권 확인(HTML 태그 방식의 content 값) |
| `NAVER_SITE_VERIFICATION` | `abc…` | 네이버 서치어드바이저 소유권 확인 |
| `CONTACT_EMAIL` | `hello@example.com` | 개인정보처리방침의 문의처 |

## 검색 노출 (SEO / GEO)

- 메인(`/`)과 개인정보처리방침(`/privacy`)만 검색에 노출됩니다. **클립 페이지(`/xxxxxxxx`)와 API는 항상 noindex**입니다.
- 메인에 서비스 소개·사용 방법·FAQ 본문이 있고, 구조화 데이터(JSON-LD: WebApplication, HowTo, FAQPage)를 넣었습니다.
- `/robots.txt`: 검색엔진과 AI 크롤러(GPTBot, ClaudeBot, PerplexityBot, Google-Extended, 네이버 Yeti 등)를 허용하고 `/api/`는 막습니다.
- `/sitemap.xml`: 공개 페이지 목록. `/llms.txt`: ChatGPT·Claude·Perplexity 같은 AI 검색이 읽기 좋은 서비스 요약.
- 링크 공유 미리보기용 Open Graph 이미지(`og.png`)가 있습니다.

배포 후 할 일:
1. `SITE_URL`을 실제 도메인으로 설정
2. [Google Search Console](https://search.google.com/search-console)과 [네이버 서치어드바이저](https://searchadvisor.naver.com)에 사이트를 등록하고, 위 인증 변수를 넣은 뒤 `https://도메인/sitemap.xml` 제출

## Google Ads

- `GOOGLE_ADS_ID`가 설정되면 메인·개인정보처리방침 페이지에만 Google 태그를 넣습니다. **클립 열람 페이지에는 넣지 않습니다.** (붙여넣은 데이터가 제3자에 노출되지 않도록)
- **동의 모드 v2**: 기본은 모두 거부 상태이고, 하단 배너에서 ‘동의’한 경우에만 광고·분석 쿠키를 씁니다. 거부해도 쿠키 없는 익명 신호로 전환 모델링이 됩니다. 사용자는 하단의 ‘쿠키 설정’으로 언제든 바꿀 수 있습니다.
- **전환 = 공유 링크 생성.** 링크를 만들면 `conversion` 이벤트(`send_to: AW-…/라벨`)가 전송됩니다.

Google Ads에서 설정:
1. **목표 → 전환 → 새 전환 액션 → 웹사이트** → 수동 설정 → 카테고리 ‘기타’(또는 ‘가입’), 이름 예: `공유 링크 생성`, 값 없음, 횟수 ‘1회’
2. 태그 설정에서 ‘Google 태그 직접 설치’를 고르면 나오는 `AW-…` ID와 **전환 라벨**을 위 환경 변수에 입력 → 재배포
3. 광고 최종 URL은 메인(`https://도메인/`)으로. 사이트에는 개인정보처리방침(`/privacy`)과 문의처(`CONTACT_EMAIL`)가 있어야 광고 정책 검토에 유리합니다.
4. Google 태그 어시스턴트로 전환이 잡히는지 확인합니다.

### 권장: 무차별 대입 방지

비밀번호는 클립별로 5회까지만 시도할 수 있지만, 추가로 대시보드 **Security → WAF → Rate limiting rules** 에서
`/api/` 경로에 IP당 요청 수 제한(예: 10분에 100회)을 걸어 두면 좋습니다. (사용자 지정 도메인 연결 시 가능)

## 무료 요금제 한도 참고

Workers KV 무료 한도는 **하루 쓰기 1,000회 / 읽기 100,000회**입니다.
클립 1개 생성 = 쓰기 2회, 비밀번호 틀림 = 쓰기 1회이므로 개인·팀 용도로는 충분합니다.

KV는 전 세계에 복제되는 저장소라, 링크를 만든 기기와 **아주 먼 지역**(예: 한국 ↔ 미국)에서 바로 열면 최대 1분 정도 "찾을 수 없음"이 뜰 수 있습니다. 같은 나라 안에서는 바로 보입니다.

## 로컬 개발

```bash
npm install
npm run dev     # http://localhost:8788 (Cloudflare 런타임 + 로컬 KV)
npm test
```

## 구조

| 경로 | 역할 |
| --- | --- |
| `public/` | 화면 (HTML/CSS/JS), 개인정보처리방침, 아이콘·OG 이미지 |
| `public/ads.js` | Google 태그 + 동의 모드 + 동의 배너 (설정 시에만 로드) |
| `functions/_middleware.js` | HTML에 절대 URL·noindex·인증 태그·Google 태그·보안 헤더 적용 |
| `functions/robots.txt.js` 등 | `/robots.txt`, `/sitemap.xml`, `/llms.txt` |
| `lib/site.js` | SEO·광고 설정 로직 |
| `functions/api/[[path]].js` | `/api/*` 요청 → `lib/api.js` |
| `functions/[id].js` | `/<클립 주소>` 접속 시 화면 반환 |
| `functions/p/[id].js` | `/p/<고정 페이지 주소>` 접속 시 화면 반환 |
| `public/qrcode.js` | QR 코드 생성 ([qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4, MIT) — CSP 때문에 CDN 대신 직접 포함 |
| `lib/api.js` | API 로직 (생성·조회·삭제·비밀번호) |

### API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/api/clips` | `{ items: [{type:'text', text} \| {type:'image', mime, data(base64), name?}], pin?: '1234' }` → `{ id, url, expiresAt, hasPin }` |
| `GET` | `/api/clips/:id/meta` | 비밀번호 여부, 만료 시각 |
| `GET` | `/api/clips/:id` | 내용 (비밀번호가 있으면 `X-Clip-Pin` 헤더 필요) |
| `DELETE` | `/api/clips/:id` | 삭제 (비밀번호가 있으면 `X-Clip-Pin` 헤더 필요) |

고정 페이지 API (비밀번호는 `X-Page-Pin` 헤더, `meta` 제외 모두 필요):

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/api/pages` | `{ pin: '1234' }` → `{ id, url, expiresAt }` |
| `GET` | `/api/pages/:pid/meta` | 존재 여부·만료 시각 (비밀번호 불필요) |
| `GET` | `/api/pages/:pid` | 클립 목록(요약) |
| `DELETE` | `/api/pages/:pid` | 페이지와 클립 삭제 |
| `POST` | `/api/pages/:pid/clips` | `{ items: [...] }` → 클립 추가, 페이지 만료를 6시간 뒤로 연장 |
| `GET` | `/api/pages/:pid/clips/:id` | 클립 내용 |
| `DELETE` | `/api/pages/:pid/clips/:id` | 클립 삭제 |
