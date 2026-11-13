# CloudClip 📋

스마트폰 ↔ PC 간에 텍스트·이미지를 웹으로 옮기는 임시 클립보드 서비스입니다.

## 사용 시나리오

1. **스마트폰**에서 텍스트/사진을 복사 → 사이트 접속 → 붙여넣기 → (선택) 4자리 비밀번호 → **공유 링크 만들기**
2. `https://도메인/ab3k9xyz` 같은 고유 주소와 8자리 코드가 생성됨
3. **Mac/PC 브라우저**에서 해당 주소로 접속(또는 메인 페이지에서 코드 입력) → 비밀번호 입력 → 내용 확인 후 **복사** / **저장**

## 기능

- 텍스트 + 이미지(여러 장) 붙여넣기: `Ctrl/⌘+V`, 모바일 길게 눌러 붙여넣기, "클립보드에서 가져오기" 버튼, 사진 선택
- 클립마다 추측하기 어려운 랜덤 경로(`/xxxxxxxx`, 약 40비트) 발급 — 목록 페이지 없음
- **1시간 후 자동 삭제** (남은 시간 카운트다운 표시), "지금 삭제" 버튼
- **선택적 4자리 비밀번호** — scrypt 해시로 저장, 5회 틀리면 클립 즉시 삭제, IP별 시도 횟수 제한
- 텍스트 복사, 이미지 클립보드 복사(PNG) / 파일 저장
- 데이터는 **메모리에만** 저장 (디스크에 남지 않음, 서버 재시작 시 모두 삭제)
- 외부 의존성 없음 (Node.js 18+)

## 실행

```bash
npm start            # http://localhost:3000
npm test
```

Docker:

```bash
docker build -t cloudclip .
docker run -p 3000:3000 cloudclip
```

## HTTPS

복사·클립보드 가져오기 기능은 **HTTPS(또는 localhost)에서만** 동작합니다. HTTP로 접속하면 화면 상단에 경고가 표시됩니다.

### 방법 A — Caddy + Let's Encrypt (운영 권장)

인증서 발급·갱신과 HTTP→HTTPS 리다이렉트를 Caddy가 자동으로 처리합니다.

1. 도메인의 DNS A/AAAA 레코드를 서버 IP로 지정하고, 방화벽에서 80·443 포트를 엽니다.
2. `.env` 작성:
   ```bash
   cp .env.example .env   # DOMAIN=clip.example.com, ACME_EMAIL=...
   ```
3. 실행:
   ```bash
   docker compose up -d
   ```

CloudClip 컨테이너는 `TRUST_PROXY=1`, `FORCE_HTTPS=1`로 동작합니다. 프록시가 `X-Forwarded-Proto: http`를 넘기면 HTTPS로 308 리다이렉트하고, HTTPS 응답에는 HSTS 헤더를 붙입니다.
Nginx·Cloudflare 같은 다른 프록시를 쓸 때도 같은 두 환경 변수를 설정하고 `X-Forwarded-Proto`/`X-Forwarded-For`를 전달하면 됩니다.

### 방법 B — Node가 직접 HTTPS 제공

인증서 파일이 이미 있다면(certbot 등) 프록시 없이 실행할 수 있습니다.

```bash
TLS_CERT=/etc/letsencrypt/live/clip.example.com/fullchain.pem \
TLS_KEY=/etc/letsencrypt/live/clip.example.com/privkey.pem \
PORT=443 HTTP_REDIRECT_PORT=80 npm start
```

- 인증서 파일이 바뀌면(갱신) 재시작 없이 자동으로 다시 읽습니다. (1분 간격 확인)
- `HTTP_REDIRECT_PORT`를 지정하면 그 포트로 들어온 HTTP 요청을 HTTPS로 리다이렉트합니다.
- 443/80 포트는 root 권한이 필요합니다. 일반 사용자로 실행하려면 높은 포트를 쓰고 포트 포워딩을 하거나 방법 A를 쓰세요.

### 로컬/같은 와이파이에서 폰으로 테스트

```bash
./scripts/dev-cert.sh
```

```bash
TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem PORT=8443 npm start
```

폰에서 `https://<PC의 LAN IP>:8443`으로 접속합니다. [mkcert](https://github.com/FiloSottile/mkcert)가 설치되어 있으면 이를 사용하고, 폰에 mkcert 루트 인증서를 설치하면 경고 없이 동작합니다. mkcert가 없으면 자체 서명 인증서를 만들며, 브라우저 경고가 뜹니다.

### 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | 포트 |
| `CLIP_TTL_MS` | `3600000` | 클립 유지 시간 (1시간) |
| `MAX_BODY_BYTES` | `26214400` | 업로드 1회 최대 크기 (25MB, base64 기준) |
| `MAX_TOTAL_BYTES` | `536870912` | 전체 메모리 저장 한도 (512MB) |
| `TRUST_PROXY` | – | 리버스 프록시 뒤라면 `1` (`X-Forwarded-For`/`-Proto` 신뢰) |
| `FORCE_HTTPS` | – | `1`이면 프록시 뒤에서 HTTP 요청을 HTTPS로 리다이렉트 (`TRUST_PROXY=1` 필요) |
| `TLS_CERT` / `TLS_KEY` | – | PEM 파일 경로. 둘 다 지정하면 Node가 직접 HTTPS로 서비스 |
| `HTTP_REDIRECT_PORT` | – | 직접 HTTPS 모드에서 HTTP→HTTPS 리다이렉트용 포트 (예: `80`) |
| `HSTS_MAX_AGE` | `15552000` | HTTPS 응답의 HSTS max-age(초). `0`이면 끔 |

## 배포 시 주의

- **HTTPS 필수**: 위 [HTTPS](#https) 항목 참고.
- 데이터가 메모리에 있으므로 **단일 인스턴스**로 운영하세요. (여러 인스턴스로 확장하려면 Redis 등 TTL 지원 저장소로 교체)

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| `POST` | `/api/clips` | `{ items: [{type:'text', text} \| {type:'image', mime, data(base64), name?}], pin?: '1234' }` → `{ id, url, expiresAt, hasPin }` |
| `GET` | `/api/clips/:id/meta` | 비밀번호 여부, 만료 시각 |
| `GET` | `/api/clips/:id` | 내용 (비밀번호가 있으면 `X-Clip-Pin` 헤더 필요) |
| `DELETE` | `/api/clips/:id` | 삭제 (비밀번호가 있으면 `X-Clip-Pin` 헤더 필요) |
