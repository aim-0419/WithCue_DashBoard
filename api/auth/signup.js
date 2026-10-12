import { FieldValue, getDb } from "../_lib/firebase-admin.js";
import { HttpError, readJsonBody, sendJson, withHandler } from "../_lib/http.js";
import { enforceRateLimit } from "../_lib/rate-limit.js";
import {
  buildSession,
  ensureUserNumber,
  findUserByProfile,
  getUsersCollection,
  parseBirthDate,
  parseGender,
  parseName,
} from "../_lib/users.js";

// POST /api/auth/signup — 수집 참여자 회원가입. 토큰은 발급하지 않고 로그인 화면으로 돌려보낸다.
async function signupHandler(req, res) {
  await enforceRateLimit(req);

  const body = readJsonBody(req);

  if (body.consentAgreed !== true) {
    throw new HttpError(400, "consent_required", "개인정보 수집·이용에 동의해야 가입할 수 있습니다.");
  }

  const name = parseName(body.name);
  const birthDate = parseBirthDate(body.birthDate);
  const gender = parseGender(body.gender);

  // 같은 정보로 동시에 가입해도 문서가 둘 생기지 않도록 조회와 생성을 한 트랜잭션에서 한다.
  const newUserRef = getUsersCollection().doc();
  const { userRef, alreadyRegistered } = await getDb().runTransaction(async (transaction) => {
    const existingUser = await findUserByProfile({ name, birthDate, gender }, { transaction });

    if (existingUser) {
      return { userRef: existingUser.ref, alreadyRegistered: true };
    }

    transaction.create(newUserRef, {
      Name: name,
      NameNormalized: name,
      BirthDate: birthDate,
      Gender: gender,
      ConsentAgreed: true,
      ConsentAt: FieldValue.serverTimestamp(),
      Role: "collector",
      Roles: ["collector"],
      UserNumber: 0,
      MemberCode: "00",
      AuthUid: "",
      CreatedAt: FieldValue.serverTimestamp(),
      UpdatedAt: FieldValue.serverTimestamp(),
    });

    return { userRef: newUserRef, alreadyRegistered: false };
  });

  const { userNumber, memberCode } = await ensureUserNumber(userRef);
  const userSnapshot = await userRef.get();
  const profile = buildSession({
    userId: userRef.id,
    userData: userSnapshot.data(),
    location: "",
    userNumber,
    memberCode,
  });

  if (alreadyRegistered) {
    sendJson(res, 200, {
      ok: true,
      alreadyRegistered: true,
      message: "이미 등록된 계정입니다. 같은 정보로 로그인해 주세요.",
      profile,
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    message: "회원가입이 완료됐습니다. 같은 정보로 로그인해 주세요.",
    profile,
  });
}

export default withHandler(signupHandler, { methods: ["POST"] });
