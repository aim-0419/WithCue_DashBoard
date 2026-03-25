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

## Firestore 확인 명령

문서 목록:

```powershell
npm run firestore:list
```

회사 문서 확인:

```powershell
npm run firestore:get:company
```

직접 값 변경:

```powershell
node .\backend\scripts\firestore-tools.mjs merge Company '{"ConsentCount":7,"SessionCount":15,"BodyParts":{"Hip":9}}'
```
