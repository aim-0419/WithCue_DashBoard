import { getAdminAuth } from "../_lib/firebase-admin.js";
import {
  HttpError,
  isVerifiedGoogleAdminIdentity,
  requireAuth,
  sendJson,
  withHandler,
} from "../_lib/http.js";
import { claimsEqual, findLinkedAdminUser, formatMemberCode, unlinkAdminEmail } from "../_lib/users.js";

const NOT_ADMIN_MESSAGE = "관리자로 등록되지 않은 계정입니다.";

// POST /api/auth/admin-session — Google 로그인 ID 토큰을 확인하고 관리자 claim을 붙인다.
async function adminSessionHandler(req, res) {
  const decoded = await requireAuth(req);

  if (!isVerifiedGoogleAdminIdentity(decoded)) {
    // 허용 목록에서 빠진 계정에 예전 관리자 claim이 남아 있으면 지워서 규칙 쪽 권한도 끊는다.
    if (decoded.role === "admin") {
      await getAdminAuth().setCustomUserClaims(decoded.uid, null);

      if (decoded.email) {
        await unlinkAdminEmail(String(decoded.email).toLowerCase());
      }
    }

    throw new HttpError(403, "not_admin", NOT_ADMIN_MESSAGE);
  }

  const email = String(decoded.email).toLowerCase();
  const linkedUser = await findLinkedAdminUser(email);
  const linkedData = linkedUser ? linkedUser.data() || {} : null;
  const roles = linkedUser ? ["admin", "collector"] : ["admin"];
  const claims = { role: "admin", roles, email };

  if (linkedUser) {
    claims.userDocId = linkedUser.id;
  }

  // 토큰에 실린 claims가 이미 같으면 Auth 쓰기를 건너뛴다(새로고침마다 쓰기 방지).
  const currentClaims = {
    role: decoded.role,
    roles: decoded.roles,
    email: decoded.email ? String(decoded.email).toLowerCase() : undefined,
    ...(decoded.userDocId ? { userDocId: decoded.userDocId } : {}),
  };

  if (!claimsEqual(currentClaims, claims)) {
    await getAdminAuth().setCustomUserClaims(decoded.uid, claims);
  }

  const userNumber = linkedData ? Number(linkedData.UserNumber || 0) || 0 : 0;

  sendJson(res, 200, {
    ok: true,
    session: {
      userId: linkedUser ? linkedUser.id : "",
      name: linkedData ? linkedData.Name || "" : decoded.name || email,
      birthDate: linkedData ? Number(linkedData.BirthDate || 0) : 0,
      gender: linkedData ? linkedData.Gender || "" : "",
      role: "admin",
      roles,
      location: "aim",
      userNumber,
      memberCode: linkedData ? linkedData.MemberCode || formatMemberCode(userNumber) : "",
      email,
    },
  });
}

export default withHandler(adminSessionHandler, { methods: ["POST"] });
