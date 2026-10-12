import { createHash } from "node:crypto";
import { Timestamp, getDb } from "./firebase-admin.js";
import { HttpError, getClientIp } from "./http.js";

// 로그인·회원가입·프로필 연결을 IP 단위로 합산해 10분에 30회까지만 허용한다.
const RATE_LIMIT_COLLECTION = "rateLimits";
export const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
export const RATE_LIMIT_MAX_ATTEMPTS = 30;

export function hashClientKey(ip) {
  // IP 원문은 저장하지 않고 해시만 문서 ID로 쓴다.
  return createHash("sha256").update(String(ip)).digest("hex");
}

export async function enforceRateLimit(
  req,
  { limit = RATE_LIMIT_MAX_ATTEMPTS, windowMs = RATE_LIMIT_WINDOW_MS } = {},
) {
  let allowed = true;

  try {
    const db = getDb();
    const limitRef = db.collection(RATE_LIMIT_COLLECTION).doc(hashClientKey(getClientIp(req)));

    allowed = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(limitRef);
      const nowMs = Date.now();
      const data = snapshot.exists ? snapshot.data() || {} : {};
      const windowStartMs = Number(data.windowStartMs || 0);
      const count = Number(data.count || 0);

      if (!snapshot.exists || !Number.isFinite(windowStartMs) || nowMs - windowStartMs >= windowMs) {
        transaction.set(limitRef, {
          count: 1,
          windowStartMs: nowMs,
          // Firestore TTL 정책을 걸면 오래된 문서가 자동으로 지워진다(선택).
          expireAt: Timestamp.fromMillis(nowMs + windowMs),
        });
        return true;
      }

      if (count >= limit) {
        return false;
      }

      transaction.set(
        limitRef,
        {
          count: count + 1,
          windowStartMs,
          expireAt: Timestamp.fromMillis(windowStartMs + windowMs),
        },
        { merge: true },
      );
      return true;
    });
  } catch (error) {
    // 시도 제한 저장소 장애로 로그인 자체가 막히지 않도록 가용성을 우선한다.
    console.error("[rate-limit] 시도 제한 확인 실패", error?.stack || String(error));
    return;
  }

  if (!allowed) {
    throw new HttpError(429, "too_many_attempts", "요청이 너무 많습니다. 10분 뒤 다시 시도해 주세요.");
  }
}
