import { HttpError, requireAdmin, sendJson, withHandler } from "../_lib/http.js";
import { formatMemberCode, getUsersCollection } from "../_lib/users.js";

function parseUserNumber(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const text = String(raw ?? "").trim();

  if (!/^\d{1,9}$/.test(text) || Number(text) <= 0) {
    throw new HttpError(400, "invalid_user_number", "회원번호가 올바르지 않습니다.");
  }

  return Number(text);
}

// GET /api/admin/lookup-user?userNumber=12 — 보정 입력용 회원 확인. 생년월일·성별은 돌려주지 않는다.
async function lookupUserHandler(req, res) {
  await requireAdmin(req);

  const userNumber = parseUserNumber(req.query?.userNumber);
  const snapshot = await getUsersCollection().where("UserNumber", "==", userNumber).limit(1).get();

  if (snapshot.empty) {
    sendJson(res, 200, { ok: true, user: null });
    return;
  }

  const userSnapshot = snapshot.docs[0];
  const data = userSnapshot.data() || {};

  sendJson(res, 200, {
    ok: true,
    user: {
      id: userSnapshot.id,
      name: data.Name || "",
      userNumber,
      memberCode: data.MemberCode || formatMemberCode(userNumber),
    },
  });
}

export default withHandler(lookupUserHandler, { methods: ["GET"] });
