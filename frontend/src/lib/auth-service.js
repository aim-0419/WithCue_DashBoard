import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCustomToken,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import {
  apiRequest,
  getFirebaseAuth,
  resetFirebaseAuthReady,
  waitForFirebaseAuthReady,
} from "./firebase-client.js";

// localStorage에는 표시용 프로필만 둔다. 권한 판정은 항상 Firebase ID 토큰 claims로 한다.
export const SESSION_STORAGE_KEYS = {
  admin: "withcue-admin-session",
  collector: "withcue-collector-session",
  legacyProfile: "withcue-auth-profile",
};

export function clearStoredSessions() {
  Object.values(SESSION_STORAGE_KEYS).forEach((key) => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // 저장소 접근이 막힌 환경에서도 로그아웃 흐름은 계속 진행함.
    }
  });
}

export function readStoredCollectorProfile() {
  try {
    const value = window.localStorage.getItem(SESSION_STORAGE_KEYS.collector);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

export function storeCollectorProfile(session) {
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEYS.collector, JSON.stringify(session));
  } catch {
    // 표시용 캐시라 실패해도 세션 자체는 유지함.
  }
}

export function removeStoredCollectorProfile() {
  try {
    window.localStorage.removeItem(SESSION_STORAGE_KEYS.collector);
  } catch {
    // 무시
  }
}

export function toFriendlyFirebaseError(error, fallbackMessage) {
  const code = String(error?.code || "");

  if (code.includes("popup-closed-by-user") || code.includes("cancelled-popup-request")) {
    return "로그인 창이 닫혔습니다.";
  }

  if (code.includes("popup-blocked")) {
    return "브라우저가 로그인 창을 차단했습니다. 팝업 차단을 해제한 뒤 다시 시도해 주세요.";
  }

  if (code.includes("network-request-failed")) {
    return "네트워크 연결 상태를 확인해 주세요.";
  }

  if (code.includes("too-many-requests")) {
    return "요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.";
  }

  if (code.includes("user-disabled")) {
    return "사용이 중지된 계정입니다. 관리자에게 문의해 주세요.";
  }

  if (code.includes("account-exists-with-different-credential")) {
    return "이미 다른 로그인 방식으로 등록된 계정입니다.";
  }

  if (code.includes("unauthorized-domain") || code.includes("operation-not-allowed")) {
    return "이 주소에서는 Google 로그인을 사용할 수 없습니다. 관리자에게 문의해 주세요.";
  }

  if (code.includes("invalid-custom-token") || code.includes("custom-token-mismatch")) {
    return "로그인 토큰이 올바르지 않습니다. 다시 로그인해 주세요.";
  }

  if (code.includes("user-token-expired") || code.includes("unauthenticated")) {
    return "인증 상태가 만료되었습니다. 다시 로그인해 주세요.";
  }

  if (code.includes("deadline-exceeded") || code.includes("timeout")) {
    return "응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.";
  }

  if (code.includes("permission-denied")) {
    return "접근 권한이 없습니다.";
  }

  return fallbackMessage || error?.message || "알 수 없는 오류가 발생했습니다.";
}

function normalizeClaims(claims) {
  const roles = Array.isArray(claims?.roles)
    ? claims.roles.filter((role) => role === "admin" || role === "collector")
    : [];

  return {
    // 다른 탭에서 다른 사용자로 로그인한 경우를 감지하기 위해 토큰의 uid 도 함께 둔다.
    uid: typeof claims?.user_id === "string" ? claims.user_id : typeof claims?.sub === "string" ? claims.sub : "",
    role: typeof claims?.role === "string" ? claims.role : "",
    roles,
    userDocId: typeof claims?.userDocId === "string" ? claims.userDocId : "",
  };
}

// 현재 Firebase 사용자의 ID 토큰 claims를 읽는다. forceRefresh면 서버가 바꾼 claims를 다시 받음.
export async function getCurrentClaims({ forceRefresh = false } = {}) {
  const user = await waitForFirebaseAuthReady();

  if (!user) {
    return null;
  }

  const tokenResult = await user.getIdTokenResult(forceRefresh);
  return normalizeClaims(tokenResult.claims);
}

export function isAdminClaims(claims) {
  return claims?.role === "admin";
}

export function isCollectorClaims(claims) {
  return Boolean(claims?.roles?.includes("collector") && claims?.userDocId);
}

// Firebase 로그인 사용자 변화를 구독한다(다른 탭 로그아웃·세션 만료 감지용). 해제 함수를 반환.
export function subscribeAuthUser(callback) {
  try {
    return onAuthStateChanged(getFirebaseAuth(), callback);
  } catch {
    return () => {};
  }
}

export async function clearFirebaseSession() {
  try {
    await signOut(getFirebaseAuth());
  } finally {
    resetFirebaseAuthReady();
  }
}

async function signOutQuietly() {
  await clearFirebaseSession().catch(() => {});
}

export async function signUpUser({ name, birthDate, gender, consentAgreed }) {
  const result = await apiRequest("/api/auth/signup", {
    auth: false,
    body: { name, birthDate, gender, consentAgreed: consentAgreed === true },
  });

  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      message: result.message || "회원가입 처리 중 알 수 없는 오류가 발생했습니다.",
    };
  }

  return {
    ok: true,
    alreadyRegistered: Boolean(result.alreadyRegistered),
    profile: result.profile || null,
    message: result.message || "회원가입이 완료됐습니다. 같은 정보로 로그인해 주세요.",
  };
}

export async function loginUser({ name, birthDate, gender, location }) {
  // 일반 수집 로그인은 Bearer 없이 호출해 관리자 연결 모드로 해석되지 않게 한다.
  const result = await apiRequest("/api/auth/login", {
    auth: false,
    body: { name, birthDate, gender, location },
  });

  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      message: result.message || "로그인 처리 중 알 수 없는 오류가 발생했습니다.",
    };
  }

  if (!result.customToken || !result.session) {
    return { ok: false, code: "server", message: "로그인 응답이 올바르지 않습니다." };
  }

  try {
    await signInWithCustomToken(getFirebaseAuth(), result.customToken);
    resetFirebaseAuthReady();
    const claims = await getCurrentClaims();

    return { ok: true, session: result.session, claims };
  } catch (error) {
    await signOutQuietly();
    return {
      ok: false,
      code: error?.code || "auth",
      message: toFriendlyFirebaseError(error, "로그인 처리 중 알 수 없는 오류가 발생했습니다."),
    };
  }
}

// 현재 로그인된 Google 사용자로 관리자 세션을 서버에서 확인·갱신한다.
async function requestAdminSession() {
  const result = await apiRequest("/api/auth/admin-session", { body: {} });

  if (!result.ok) {
    return result;
  }

  const claims = await getCurrentClaims({ forceRefresh: true });

  if (!isAdminClaims(claims)) {
    return { ok: false, code: "not_admin", message: "관리자로 등록되지 않은 계정입니다." };
  }

  return { ok: true, session: result.session, claims };
}

export async function loginAdminWithGoogle() {
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await signInWithPopup(getFirebaseAuth(), provider);
    resetFirebaseAuthReady();
  } catch (error) {
    return {
      ok: false,
      code: error?.code || "auth",
      message: toFriendlyFirebaseError(error, "Google 로그인 중 오류가 발생했습니다."),
    };
  }

  try {
    const result = await requestAdminSession();

    if (!result.ok) {
      await signOutQuietly();
      return {
        ok: false,
        code: result.code,
        message: result.message || "관리자 로그인에 실패했습니다.",
      };
    }

    return result;
  } catch (error) {
    await signOutQuietly();
    return {
      ok: false,
      code: error?.code || "auth",
      message: toFriendlyFirebaseError(error, "관리자 로그인 중 오류가 발생했습니다."),
    };
  }
}

// 관리자 계정에 본인 수집 참여자 정보를 한 번 연결한다(관리자 Bearer로 /api/auth/login 호출).
export async function linkAdminProfile({ name, birthDate, gender, location }) {
  const result = await apiRequest("/api/auth/login", {
    body: { name, birthDate, gender, location },
  });

  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      message: result.message || "회원 정보 연결 중 알 수 없는 오류가 발생했습니다.",
    };
  }

  if (result.linked !== true || !result.session) {
    return {
      ok: false,
      code: "not_linked",
      message: "관리자 계정에 회원 정보를 연결하지 못했습니다. 다시 로그인해 주세요.",
    };
  }

  try {
    const claims = await getCurrentClaims({ forceRefresh: true });

    if (!isAdminClaims(claims) || !isCollectorClaims(claims)) {
      return {
        ok: false,
        code: "not_linked",
        message: "연결 결과를 확인하지 못했습니다. 다시 로그인해 주세요.",
      };
    }

    return { ok: true, session: result.session, claims };
  } catch (error) {
    return {
      ok: false,
      code: error?.code || "auth",
      message: toFriendlyFirebaseError(error, "연결 결과를 확인하지 못했습니다."),
    };
  }
}

// 앱 시작 시 Firebase 로그인 상태와 claims로 세션을 복원한다.
// 반환: { kind:"admin"|"collector", session, claims } 또는 null(재로그인 필요).
export async function restoreSession() {
  let user = null;

  try {
    user = await waitForFirebaseAuthReady();
  } catch {
    return null;
  }

  if (!user) {
    return null;
  }

  let claims = null;

  try {
    claims = await getCurrentClaims();
  } catch {
    await signOutQuietly();
    return null;
  }

  if (isAdminClaims(claims)) {
    try {
      const result = await requestAdminSession();

      if (!result.ok) {
        await signOutQuietly();
        return null;
      }

      // 관리자-연결 계정이 수집 화면에 있다가 새로고침한 경우 수집 화면으로 되돌린다.
      const storedCollector = readStoredCollectorProfile();

      if (
        isCollectorClaims(result.claims) &&
        storedCollector?.userId &&
        storedCollector.userId === result.claims.userDocId
      ) {
        return {
          kind: "collector",
          session: {
            ...result.session,
            role: "collector",
            roles: result.claims.roles,
            location: storedCollector.location || result.session?.location || "aim",
            postureType: "correct",
          },
          claims: result.claims,
        };
      }

      return { kind: "admin", session: result.session, claims: result.claims };
    } catch {
      await signOutQuietly();
      return null;
    }
  }

  if (isCollectorClaims(claims)) {
    const storedCollector = readStoredCollectorProfile();

    if (storedCollector?.userId && storedCollector.userId === claims.userDocId) {
      return {
        kind: "collector",
        session: {
          ...storedCollector,
          role: "collector",
          roles: claims.roles,
          postureType: "correct",
        },
        claims,
      };
    }
  }

  // 표시용 프로필이 없거나 권한이 없으면 재로그인을 유도한다.
  await signOutQuietly();
  return null;
}
