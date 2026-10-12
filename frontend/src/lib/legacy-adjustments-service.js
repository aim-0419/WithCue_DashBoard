import { apiRequest, waitForFirebaseAuthReady } from "./firebase-client.js";

async function requireSignedInUser() {
  const user = await waitForFirebaseAuthReady();

  if (!user) {
    throw new Error("인증 상태가 만료되었습니다. 다시 로그인해 주세요.");
  }

  return user;
}

// 회원번호 검색은 서버(관리자 전용)에서 하고, 이름·회원번호·회원코드만 받는다.
export async function findUserByUserNumber(userNumber) {
  const normalizedUserNumber = Number(userNumber || 0);

  if (!Number.isInteger(normalizedUserNumber) || normalizedUserNumber <= 0) {
    throw new Error("회원번호는 1 이상의 숫자로 입력해 주세요.");
  }

  const result = await apiRequest(
    `/api/admin/lookup-user?userNumber=${encodeURIComponent(normalizedUserNumber)}`,
    { method: "GET" },
  );

  if (!result.ok) {
    throw new Error(result.message || "회원 검색 중 오류가 발생했습니다.");
  }

  if (!result.user) {
    return null;
  }

  return {
    id: result.user.id,
    name: result.user.name || "",
    userNumber: Number(result.user.userNumber || 0),
    memberCode: result.user.memberCode || "",
  };
}

// 보정 기록 추가·삭제는 서버 API(/api/admin/adjustments)가 관리자 허용 목록을 매번 확인한 뒤 처리한다.
// 브라우저는 Firestore에 직접 쓰지 않는다. 대상 회원의 이름·회원번호·회원코드와 작성자는 서버가 채운다.
// 호출부가 넘기는 adminSession은 쓰지 않는다(작성자는 서버가 관리자 토큰에서 정함).
export async function createLegacyAdjustment({
  location,
  bodyPartKey,
  postureType,
  sessionDelta,
  consentDelta,
  note,
  targetUser,
}) {
  await requireSignedInUser();

  const normalizedSessionDelta = Number(sessionDelta || 0);
  const normalizedConsentDelta = Number(consentDelta || 0);

  if (normalizedSessionDelta <= 0 && normalizedConsentDelta <= 0) {
    throw new Error("추가 건수 또는 인원 수를 1 이상 입력해 주세요.");
  }

  if (!targetUser?.id || !targetUser?.name || !targetUser?.userNumber) {
    throw new Error("반영할 회원번호를 먼저 검색해 주세요.");
  }

  const result = await apiRequest("/api/admin/adjustments", {
    body: {
      location,
      bodyPartKey,
      postureType: postureType === "incorrect" ? "incorrect" : "correct",
      sessionDelta: normalizedSessionDelta,
      consentDelta: normalizedConsentDelta,
      note: String(note || "").trim(),
      targetUserId: targetUser.id,
    },
  });

  if (!result.ok) {
    throw new Error(result.message || "보정 데이터를 저장하지 못했습니다.");
  }

  return result.id;
}

export async function deleteLegacyAdjustment(adjustmentId) {
  await requireSignedInUser();

  if (!adjustmentId) {
    throw new Error("삭제할 보정 데이터가 없습니다.");
  }

  const result = await apiRequest(
    `/api/admin/adjustments?id=${encodeURIComponent(adjustmentId)}`,
    { method: "DELETE" },
  );

  if (!result.ok) {
    throw new Error(result.message || "보정 데이터를 삭제하지 못했습니다.");
  }
}
