import { getAdminAuth } from "../_lib/firebase-admin.js";
import {
  HttpError,
  hasBearerToken,
  isAdminToken,
  readJsonBody,
  requireAuth,
  sendJson,
  withHandler,
} from "../_lib/http.js";
import { enforceRateLimit } from "../_lib/rate-limit.js";
import {
  LINKED_ADMIN_ROLES,
  buildCollectorClaims,
  buildSession,
  ensureAuthIdentity,
  ensureUserNumber,
  findUserByProfile,
  linkAdminEmailToUser,
  parseBirthDate,
  parseGender,
  parseLocationKey,
  parseName,
} from "../_lib/users.js";

const USER_NOT_FOUND_MESSAGE = "회원가입한 정보와 일치하는 사용자를 찾을 수 없습니다.";

// POST /api/auth/login — 이름·생년월일·성별로 로그인해 커스텀 토큰을 받는다.
// 관리자 ID 토큰을 Bearer로 함께 보내면 "관리자 연결 모드": 토큰 대신 관리자 계정에 회원 문서를 연결한다.
async function loginHandler(req, res) {
  await enforceRateLimit(req);

  const body = readJsonBody(req);
  const name = parseName(body.name);
  const birthDate = parseBirthDate(body.birthDate);
  const gender = parseGender(body.gender);
  const location = parseLocationKey(body.location);
  const callerToken = hasBearerToken(req) ? await requireAuth(req) : null;

  const userSnapshot = await findUserByProfile({ name, birthDate, gender });

  if (!userSnapshot) {
    sendJson(res, 200, {
      ok: false,
      code: "user_not_found",
      message: USER_NOT_FOUND_MESSAGE,
    });
    return;
  }

  const userRef = userSnapshot.ref;
  const userData = userSnapshot.data() || {};
  const { userNumber, memberCode } = await ensureUserNumber(userRef);

  if (callerToken && isAdminToken(callerToken)) {
    const email = String(callerToken.email || "").toLowerCase();
    const linkedEmail = String(userData.AdminEmail || "").toLowerCase();

    // 다른 관리자 계정에 이미 연결된 회원 정보는 가로채지 못하게 한다(오타로 남의 번호에 기록되는 사고 방지).
    if (linkedEmail && linkedEmail !== email) {
      throw new HttpError(409, "profile_linked_elsewhere", "이 회원 정보는 이미 다른 관리자 계정에 연결돼 있습니다.");
    }

    await linkAdminEmailToUser(userRef, email);
    await getAdminAuth().setCustomUserClaims(callerToken.uid, {
      role: "admin",
      roles: [...LINKED_ADMIN_ROLES],
      userDocId: userRef.id,
      email,
    });

    sendJson(res, 200, {
      ok: true,
      linked: true,
      session: buildSession({
        userId: userRef.id,
        userData,
        location,
        userNumber,
        memberCode,
        role: "collector",
        roles: LINKED_ADMIN_ROLES,
      }),
    });
    return;
  }

  const authUid = await ensureAuthIdentity(userRef, userData);
  const customToken = await getAdminAuth().createCustomToken(
    authUid,
    buildCollectorClaims(userRef.id),
  );

  sendJson(res, 200, {
    ok: true,
    customToken,
    session: buildSession({
      userId: userRef.id,
      userData,
      location,
      userNumber,
      memberCode,
    }),
  });
}

export default withHandler(loginHandler, { methods: ["POST"] });
