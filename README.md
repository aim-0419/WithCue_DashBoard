# WithCue Dashboard

WithCue 관리자 대시보드 React 프로젝트입니다.

## 폴더 구조

```text
frontend/
  index.html          Vite 진입 HTML
  src/
    components/       화면 컴포넌트
    data/             페이지 메타데이터
    hooks/            React 훅
    lib/              Firebase 데이터 로딩
    App.jsx           대시보드 루트
    main.jsx          React 진입점
  styles/             공통 스타일
  config/             Firebase 웹 설정
  public/assets/images/
                     인체 이미지

backend/
  scripts/            Firestore 확인/입력용 스크립트
```

## 실행

개발 서버:

```powershell
npm run dev
```

프로덕션 빌드:

```powershell
npm run build
```

빌드 결과 확인:

```powershell
npm run preview
```

## Firestore 데이터 확인

브라우저와 로그인 없는 스크립트는 더 이상 Firestore 를 직접 읽거나 쓸 수 없다(보안 규칙이 서버 전용으로 닫혀 있음).
데이터 확인은 Firebase 콘솔 → Firestore Database 에서 하고, 일괄 변경이 필요하면 Admin SDK 스크립트(예: `scripts/strip-pii-backfill.mjs`)처럼
`FIREBASE_SERVICE_ACCOUNT_JSON` 으로 실행한다. 규칙·API 테스트는 `npm test` (에뮬레이터 필요, Java 11+).

## 서버(API) 구성과 배포

개인정보(이름·생년월일·성별)는 브라우저가 Firestore에서 직접 읽지 않고, 저장소 루트 `api/` 폴더의 Vercel Serverless Functions가 Firebase Admin SDK로 처리합니다. `api/_lib/`는 공통 모듈이라 함수로 배포되지 않습니다(밑줄 폴더).

### Vercel 환경변수

Vercel 대시보드 → 프로젝트 → Settings → Environment Variables 에 아래 3개를 넣습니다(Production·Preview 각각). 예시는 `.env.server.example` 참고.

| 이름 | 값 |
| --- | --- |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | 서비스 계정 키 JSON 파일 내용 전체(한 줄 문자열) |
| `ADMIN_EMAILS` | 관리자 Google 계정 이메일. 쉼표로 구분, 앞뒤 공백 무시, 대소문자 구분 없음. 예: `owner@example.com,manager@example.com` |
| `FIREBASE_PROJECT_ID` | `withcuedashboard` (비우면 서비스 계정의 `project_id`) |

- 값을 바꾼 뒤에는 재배포해야 함수에 반영됩니다.
- `ADMIN_EMAILS`에서 이메일을 빼면 그 계정의 다음 API 호출부터 관리자 권한이 거부되고, 다음 관리자 로그인 시도 때 남은 관리자 claim도 지워집니다.
- 운영(`VERCEL_ENV=production`)에 `FIRESTORE_EMULATOR_HOST`·`FIREBASE_AUTH_EMULATOR_HOST`가 들어가 있으면 API가 Admin SDK 초기화를 거부하고 500을 돌려줍니다.

### 서비스 계정 키 발급

1. Google Cloud 콘솔(프로젝트 `withcuedashboard`) → IAM 및 관리자 → 서비스 계정
2. 서버용 서비스 계정을 만들거나 고른 뒤 역할 부여: `Firebase Admin SDK 관리자 서비스 에이전트(Firebase Admin SDK Administrator Service Agent)`, 또는 최소 권한으로 `Cloud Datastore 사용자(Cloud Datastore User)` + `Firebase 인증 관리자(Firebase Authentication Admin)`. 커스텀 토큰 서명을 위해 키 파일 방식(아래)을 씁니다.
3. 해당 서비스 계정 → 키 → 키 추가 → 새 키 만들기 → JSON
4. 내려받은 JSON 내용을 `FIREBASE_SERVICE_ACCOUNT_JSON`에 붙여 넣고, 파일은 저장소·메신저에 남기지 않고 지웁니다.

### 로컬 개발 순서

Java 21과 Node 20 이상이 필요합니다. 터미널 3개를 띄웁니다.

```powershell
# 1) Firebase 에뮬레이터 (Auth 9099, Firestore 8080)
npm run emulators

# 2) API 하네스 (기본 http://127.0.0.1:3000, 포트는 API_PORT로 변경)
$env:FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
$env:FIREBASE_AUTH_EMULATOR_HOST="127.0.0.1:9099"
$env:FIREBASE_PROJECT_ID="withcuedashboard"
$env:ADMIN_EMAILS="admin@example.com"
npm run dev:api

# 3) 프론트 (frontend/.env.local 에 VITE_USE_FIREBASE_EMULATORS=true)
npm run dev
```

- 환경변수를 매번 넣기 번거로우면 루트에 `.env.server.local`을 만들어 두면 `dev:api`가 읽습니다(`.gitignore`의 `.env.*.local`에 걸려 커밋되지 않음). 셸에 이미 있는 값이 우선합니다.
- 에뮬레이터 주소 없이 `dev:api`를 띄우면 경고가 나오고, 서비스 계정이 있으면 실제 프로젝트에 붙습니다. 로컬에서는 에뮬레이터를 쓰세요.

### 엔드포인트

| 메서드·경로 | 인증 | 요청 | 성공 응답 |
| --- | --- | --- | --- |
| `POST /api/auth/signup` | 없음(시도 제한) | `{ name, birthDate, gender, consentAgreed:true }` | `{ ok, message, profile }` (이미 있으면 `alreadyRegistered:true`) |
| `POST /api/auth/login` | 없음(시도 제한) / 관리자 Bearer면 프로필 연결 | `{ name, birthDate, gender, location }` | `{ ok, customToken, session }` / 연결 모드 `{ ok, linked:true, session }` / 없음 `{ ok:false, code:"user_not_found" }` |
| `POST /api/auth/admin-session` | Google 로그인 ID 토큰 | 없음 | `{ ok, session }` (허용 목록 밖이면 403 `not_admin`) |
| `POST /api/collect/consent` | 수집자 ID 토큰 | `{ location }` | `{ ok, created, id }` |
| `POST /api/collect/session` | 수집자 ID 토큰 | `{ location, bodyPartKey, fileName, mimeType, size, durationMs, sourceType, depth }` | `{ ok, sessionId }` |
| `GET /api/admin/dashboard-data` | 관리자 ID 토큰 | 없음 | `{ ok, users, participants, sessions, adjustments }` |
| `GET /api/admin/lookup-user?userNumber=12` | 관리자 ID 토큰 | 쿼리 | `{ ok, user: { id, name, userNumber, memberCode } \| null }` |

- 실패 응답은 `{ ok:false, code, message }`이며 HTTP 400(입력)·401(미인증)·403(권한)·405(메서드)·429(시도 제한)·500을 씁니다.
- 시도 제한: 로그인·회원가입·프로필 연결을 IP 해시 기준으로 합산해 10분에 30회. 기록은 Firestore `rateLimits`에 남으며, `expireAt` 필드로 Firestore TTL 정책을 걸면 자동 정리됩니다(선택).
- 참여·세션 문서에는 이름·생년월일·성별을 저장하지 않습니다(`UserId`=users 문서 ID, `UserNumber`, `MemberCode`만).
