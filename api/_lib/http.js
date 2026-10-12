import { getAdminAuth } from "./firebase-admin.js";

// 모든 핸들러가 같은 실패 형식 { ok:false, code, message }를 쓰도록 HttpError 하나로 통일한다.
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

const SERVER_ERROR_MESSAGE = "서버 처리 중 오류가 발생했습니다. 잠시 뒤 다시 시도해 주세요.";

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // 개인정보가 섞일 수 있는 응답이라 어떤 캐시에도 남기지 않는다.
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export function methodNotAllowed(res, allowedMethods = []) {
  if (allowedMethods.length > 0) {
    res.setHeader("Allow", allowedMethods.join(", "));
  }

  sendJson(res, 405, {
    ok: false,
    code: "method_not_allowed",
    message: "허용되지 않은 요청 방식입니다.",
  });
}

// Vercel은 JSON 요청 본문을 req.body로 파싱해 준다. 문자열·빈 값도 객체로 맞춘다.
export function readJsonBody(req) {
  let body;

  try {
    body = req.body;
  } catch {
    throw new HttpError(400, "invalid_json", "요청 본문 형식이 올바르지 않습니다.");
  }

  if (body === undefined || body === null || body === "") {
    return {};
  }

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      throw new HttpError(400, "invalid_json", "요청 본문 형식이 올바르지 않습니다.");
    }
  }

  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_json", "요청 본문 형식이 올바르지 않습니다.");
  }

  return body;
}

export function readBearerToken(req) {
  const header = String(req.headers?.authorization || "");
  const matched = header.match(/^Bearer\s+(.+)$/i);
  return matched ? matched[1].trim() : "";
}

export function hasBearerToken(req) {
  return Boolean(readBearerToken(req));
}

export async function requireAuth(req) {
  const token = readBearerToken(req);

  if (!token) {
    throw new HttpError(401, "unauthenticated", "로그인이 필요합니다.");
  }

  try {
    return await getAdminAuth().verifyIdToken(token);
  } catch {
    throw new HttpError(401, "invalid_token", "인증이 만료되었거나 올바르지 않습니다. 다시 로그인해 주세요.");
  }
}

// ADMIN_EMAILS는 쉼표로 구분하고 앞뒤 공백을 지운 뒤 소문자로 비교한다.
export function getAdminEmails() {
  return String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedAdminEmail(email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  return Boolean(normalizedEmail) && getAdminEmails().includes(normalizedEmail);
}

// Google 로그인 + 이메일 인증 + 허용 목록. 관리자 claim을 주거나 유지하는 유일한 근거다.
export function isVerifiedGoogleAdminIdentity(decoded) {
  return (
    decoded?.firebase?.sign_in_provider === "google.com" &&
    decoded?.email_verified === true &&
    isAllowedAdminEmail(decoded?.email)
  );
}

// 관리자 판정: role claim에 더해, 허용 목록에서 빠진 계정의 남은 claim은 인정하지 않는다.
export function isAdminToken(decoded) {
  return decoded?.role === "admin" && isVerifiedGoogleAdminIdentity(decoded);
}

export function isCollectorToken(decoded) {
  const roles = Array.isArray(decoded?.roles) ? decoded.roles : [];
  return roles.includes("collector") && typeof decoded?.userDocId === "string" && decoded.userDocId !== "";
}

export async function requireAdmin(req) {
  const decoded = await requireAuth(req);

  if (!isAdminToken(decoded)) {
    throw new HttpError(403, "forbidden", "관리자 권한이 필요합니다.");
  }

  return decoded;
}

export async function requireCollector(req) {
  const decoded = await requireAuth(req);

  if (!isCollectorToken(decoded)) {
    throw new HttpError(403, "not_collector", "수집 참여자 권한이 필요합니다.");
  }

  return decoded;
}

export function getClientIp(req) {
  const forwardedFor = String(req.headers?.["x-forwarded-for"] || "");
  const firstForwarded = forwardedFor.split(",")[0].trim();

  if (firstForwarded) {
    return firstForwarded;
  }

  return req.socket?.remoteAddress || "unknown";
}

// 메서드 검사 + 예외 정리를 한곳에서 한다. 예상 못 한 오류는 스택만 서버 로그에 남긴다(요청 본문·개인정보는 기록하지 않음).
export function withHandler(handler, { methods = ["POST"] } = {}) {
  return async function wrappedHandler(req, res) {
    if (!methods.includes(req.method)) {
      methodNotAllowed(res, methods);
      return;
    }

    try {
      await handler(req, res);
    } catch (error) {
      if (res.headersSent || res.writableEnded) {
        console.error("[api] 응답 전송 뒤 오류", error?.stack || String(error));
        return;
      }

      if (error instanceof HttpError) {
        sendJson(res, error.status, {
          ok: false,
          code: error.code,
          message: error.message,
        });
        return;
      }

      console.error("[api] 처리되지 않은 오류", error?.stack || String(error));
      sendJson(res, 500, {
        ok: false,
        code: "server_error",
        message: SERVER_ERROR_MESSAGE,
      });
    }
  };
}
