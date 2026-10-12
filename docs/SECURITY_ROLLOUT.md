# 서버 검증 인증 구조 전환 — 운영 적용 절차

## 왜 바꾸는가

이전 구조는 익명 로그인 + "로그인했으면 읽기 허용" 규칙이었다. 공개된 Firebase 웹 키로 익명 로그인만 하면 누구나
`users`(이름·생년월일·성별)를 통째로 읽을 수 있었고, 로그인 화면만 열어도 브라우저가 4개 컬렉션을 전부 내려받았으며,
`Roles` 배열을 고쳐 관리자 화면에 들어갈 수도 있었다. 관리자 로그인도 이름·생년월일·성별 세 값뿐이었다.

새 구조:

- 로그인·회원가입·참여/세션 기록·대시보드 데이터는 **Vercel 서버 함수(`api/`)** 가 Admin SDK로 처리한다.
- 브라우저는 다른 사람의 개인정보를 받지 않는다. 대시보드는 집계에 필요한 필드만 받는다.
- 수집 참여자는 서버가 발급한 **커스텀 토큰**으로 로그인하고, 관리자는 **Google 계정 + 허용 이메일 목록**으로 로그인한다.
- Firestore 규칙은 **모든 컬렉션을 닫는다.** 보정 기록(legacyAdjustments)까지 서버 API가 처리하므로 브라우저는 Firestore에 직접 접근하지 않는다.
- 관리자 권한은 API 호출마다 서버가 Google 로그인 + 이메일 인증 + `ADMIN_EMAILS` 허용 목록으로 다시 확인한다(남은 claim만으로는 아무것도 못 한다).
- 참여·세션 문서에 개인정보를 더 이상 복사하지 않는다(기존 복사본은 백필로 제거).

## 적용 순서 (순서가 중요함 — 코드 먼저, 규칙은 마지막)

### 1. Firebase 콘솔 (프로젝트 `withcuedashboard`)

1. **Authentication → Sign-in method → Google** 사용 설정(지원 이메일 선택).
2. **Authentication → Settings → Authorized domains** 에 `withcuedashboard.vercel.app` 추가(이미 있으면 통과).
   Vercel 프리뷰 도메인에서도 관리자 로그인을 쓰려면 그 도메인도 추가.
3. **익명 로그인은 아직 끄지 않는다.** 새 프론트가 배포된 뒤(4단계) 끈다.

### 2. 서비스 계정 키 발급 (Google Cloud 콘솔)

1. IAM 및 관리자 → 서비스 계정 → 새 서비스 계정 `withcue-api`.
2. 역할: `Cloud Datastore 사용자`(Firestore 읽기/쓰기) + `Firebase Authentication 관리자` + `서비스 계정 토큰 생성자`(커스텀 토큰 서명용, 자기 자신에 대해).
   간단히 하려면 `Firebase Admin SDK 관리자 서비스 에이전트` 하나로도 된다.
3. 키 → 새 키(JSON) 다운로드. **이 파일은 저장소에 넣지 않는다**(`.gitignore` 에 패턴 있음). Vercel에 넣은 뒤 로컬 파일은 삭제.

### 3. Vercel 프로젝트 환경변수 (Production + Preview)

| 변수 | 값 |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | 2단계 JSON 파일 내용 전체(한 줄) — Sensitive 로 표시 |
| `ADMIN_EMAILS` | 관리자 Google 이메일, 쉼표 구분. 예: `a@company.com,b@company.com` |
| `FIREBASE_PROJECT_ID` | `withcuedashboard` |

기존 `VITE_FIREBASE_*` 6개는 그대로 둔다.

### 4. 코드 배포

1. 이 브랜치를 `main` 에 병합 → Vercel 자동 배포(프론트 + `api/` 함수가 함께).
2. 배포 직후 확인: `https://withcuedashboard.vercel.app/api/auth/login` 에 GET → `405` JSON 이 오면 함수가 살아 있음.
3. 스모크 테스트: 회원가입 → 로그인 → 수집 화면, 관리자 Google 로그인 → 대시보드 숫자 확인.
   이 시점에는 옛 규칙이 그대로라 기능은 모두 동작하고, 노출만 아직 안 막힌 상태.

### 5. Firestore 규칙 게시 (노출이 닫히는 시점)

- 콘솔: Firestore Database → 규칙 → 저장소의 `firestore.rules` 내용을 그대로 붙여넣고 게시.
- 또는 CLI: `npx firebase-tools@14 deploy --only firestore:rules --project withcuedashboard` (firebase login 필요).
- 게시 후 다시 스모크 테스트(4-3). 옛 프론트를 캐시로 들고 있는 브라우저는 새로고침하면 된다.

### 6. 뒷정리

1. **Authentication → Sign-in method → 익명** 사용 중지. 사용자 탭에서 익명 사용자 삭제(선택, 삭제는 되돌릴 수 없으니 확인 후).
2. 기존 참여·세션 문서의 개인정보 복사본 제거:
   ```bash
   FIREBASE_SERVICE_ACCOUNT_JSON='...' node scripts/strip-pii-backfill.mjs          # 대상 수 확인
   FIREBASE_SERVICE_ACCOUNT_JSON='...' node scripts/strip-pii-backfill.mjs --apply  # 적용
   ```
3. Google Cloud 콘솔 → API 및 서비스 → 사용자 인증 정보 → 브라우저 키: HTTP 리퍼러를 `https://withcuedashboard.vercel.app/*` 로 제한(보조 장치).
4. GitHub → Security → Secret scanning 의 Google API Key 경고를 닫는다(사유: 공개용 웹 키, 규칙·서버로 접근 통제).
5. 예전 `functions/` 폴더(미배포, Blaze 필요)와 로그인 없는 관리 스크립트는 이 변경에서 삭제됐다. `firebase deploy` 는 이제 규칙만 다룬다.

## 되돌리기

- 규칙 게시 전(4단계까지)이면 Vercel 에서 이전 배포로 롤백만 하면 된다.
- 규칙 게시 후 문제가 생기면 규칙 탭의 **이전 버전**으로 되돌리고 Vercel 롤백. 데이터는 바뀌지 않는다(백필 전까지).

## 운영 중 관리

- 관리자 추가/제거: Vercel 의 `ADMIN_EMAILS` 수정 → 재배포(환경변수 변경은 재배포가 필요). 제거된 관리자는 재배포 직후부터 모든 관리자 API가 403 으로 거부되고, 다음 `admin-session` 호출 때 claim 과 회원 연결(AdminEmail)도 정리된다. Firestore 는 브라우저에 닫혀 있으므로 남은 claim 으로 할 수 있는 일은 없다.
- 로컬 개발: `npm run dev:all` 이 API 하네스(`npm run dev:api`)까지 띄운다. `.env.server.local` 에 서비스 계정 또는 에뮬레이터 설정이 있어야 하며, 에뮬레이터 설정이면 에뮬레이터 창도 함께 뜬다. 테스트는 `npm test`(규칙 + API, Java 11+ 필요).
- 서비스 계정 키는 1년 주기로 교체(새 키 발급 → Vercel 교체 → 옛 키 삭제).
- Vercel 계정에 2FA 필수. 서비스 계정 키를 들고 있는 곳이기 때문.
