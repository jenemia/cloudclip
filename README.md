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
- 한 번에 올릴 수 있는 용량: 약 14MB (이미지 합계)
- HTTPS는 Cloudflare가 자동 처리

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
| `public/` | 화면 (HTML/CSS/JS), 보안 헤더(`_headers`) |
| `functions/api/[[path]].js` | `/api/*` 요청 → `lib/api.js` |
| `functions/[id].js` | `/<클립 주소>` 접속 시 화면 반환 |
| `lib/api.js` | API 로직 (생성·조회·삭제·비밀번호) |

### API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/api/clips` | `{ items: [{type:'text', text} \| {type:'image', mime, data(base64), name?}], pin?: '1234' }` → `{ id, url, expiresAt, hasPin }` |
| `GET` | `/api/clips/:id/meta` | 비밀번호 여부, 만료 시각 |
| `GET` | `/api/clips/:id` | 내용 (비밀번호가 있으면 `X-Clip-Pin` 헤더 필요) |
| `DELETE` | `/api/clips/:id` | 삭제 (비밀번호가 있으면 `X-Clip-Pin` 헤더 필요) |
