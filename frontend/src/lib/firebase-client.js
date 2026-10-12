import { getApp, getApps, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, onAuthStateChanged } from "firebase/auth";
import { firebaseConfig, hasFirebaseConfig } from "../../config/firebase-config.js";

const API_REQUEST_TIMEOUT_MS = 12000;
const USE_FIREBASE_EMULATORS = import.meta.env?.VITE_USE_FIREBASE_EMULATORS === "true";

let authReadyPromise = null;
let authEmulatorConnected = false;

export function getFirebaseApp() {
  // 배포 환경 변수가 비어 있으면 초기화 단계에서 바로 실패시키는 처리함.
  if (!hasFirebaseConfig()) {
    throw new Error("Firebase environment variables are missing.");
  }

  return getApps().length ? getApp() : initializeApp(firebaseConfig);
}

export function getFirebaseAuth() {
  const auth = getAuth(getFirebaseApp());

  // 로컬 에뮬레이터 모드에서는 Auth 에뮬레이터에 한 번만 연결함.
  if (USE_FIREBASE_EMULATORS && !authEmulatorConnected) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    authEmulatorConnected = true;
  }

  return auth;
}

export function resetFirebaseAuthReady() {
  // 로그인·로그아웃 뒤 다음 대기가 새 인증 상태를 기준으로 하도록 초기화함.
  authReadyPromise = null;
}

// 익명 로그인은 하지 않는다. 저장된 Firebase 로그인 상태가 복원될 때까지만 기다린 뒤
// 현재 사용자(없으면 null)를 돌려준다.
export async function waitForFirebaseAuthReady() {
  const auth = getFirebaseAuth();

  if (!authReadyPromise) {
    authReadyPromise = new Promise((resolve) => {
      const unsubscribe = onAuthStateChanged(
        auth,
        () => {
          unsubscribe();
          resolve();
        },
        () => {
          unsubscribe();
          resolve();
        },
      );
    });
  }

  await authReadyPromise;
  return auth.currentUser;
}

function buildFailure(code, message) {
  return { ok: false, code, message };
}

// 서버 API 호출 헬퍼. 서버가 돌려준 JSON은 ok:false여도 그대로 반환하고(throw 하지 않음),
// 네트워크·타임아웃·JSON 아님은 { ok:false, code, message } 형태로 통일한다.
export async function apiRequest(path, { method = "POST", body, auth = true } = {}) {
  const headers = { Accept: "application/json" };

  if (auth) {
    let user = null;

    try {
      user = await waitForFirebaseAuthReady();
    } catch {
      user = null;
    }

    if (!user) {
      return buildFailure("unauthenticated", "인증 상태가 만료되었습니다. 다시 로그인해 주세요.");
    }

    try {
      headers.Authorization = `Bearer ${await user.getIdToken()}`;
    } catch (error) {
      if (String(error?.code || "").includes("network-request-failed")) {
        return buildFailure("network", "네트워크 연결 상태를 확인해 주세요.");
      }

      return buildFailure("unauthenticated", "인증 상태가 만료되었습니다. 다시 로그인해 주세요.");
    }
  }

  const init = { method, headers };

  if (body !== undefined && method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);
  init.signal = controller.signal;

  let response;

  try {
    response = await fetch(path, init);
  } catch (error) {
    window.clearTimeout(timeoutId);

    if (error?.name === "AbortError") {
      return buildFailure("timeout", "서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.");
    }

    return buildFailure("network", "네트워크 연결 상태를 확인해 주세요.");
  }

  let payload;

  try {
    payload = await response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      return buildFailure("timeout", "서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.");
    }

    return buildFailure("server", "서버 응답을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  } finally {
    window.clearTimeout(timeoutId);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return buildFailure("server", "서버 응답을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }

  if (typeof payload.ok !== "boolean") {
    if (!response.ok) {
      return buildFailure("server", "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    }

    return { ok: true, ...payload };
  }

  return payload;
}
