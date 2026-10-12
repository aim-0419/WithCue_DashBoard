// 에뮬레이터 + dev-api-server 대상 API 종단 검증. 실행: npm run test:api (tests/run-api-e2e.mjs 가 띄움)
const API = process.env.API_BASE || "http://127.0.0.1:3100";
const AUTH = "http://127.0.0.1:9099";
const FS = "http://127.0.0.1:8080";
const PROJECT = "withcuedashboard";
const FS_DOCS = `${FS}/v1/projects/${PROJECT}/databases/(default)/documents`;

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
}

async function api(path, { method = "POST", body, token, ip = "198.51.100.1", rawBody } = {}) {
  const headers = { "x-forwarded-for": ip };
  if (body !== undefined || rawBody !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  return { status: response.status, json };
}

async function exchangeCustomToken(customToken) {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=any`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  return r.json();
}

async function signInWithGoogle({ sub, email, emailVerified = true }) {
  const idTokenJson = JSON.stringify({ sub, email, email_verified: emailVerified, name: "관리자테스트" });
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=any`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      postBody: `id_token=${encodeURIComponent(idTokenJson)}&providerId=google.com`,
      requestUri: "http://localhost",
      returnIdpCredential: true,
      returnSecureToken: true,
    }),
  });
  return r.json();
}

async function refreshIdToken(refreshToken) {
  const r = await fetch(`${AUTH}/securetoken.googleapis.com/v1/token?key=any`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  });
  const json = await r.json();
  return json.id_token;
}

function decodeJwt(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

async function getDoc(path) {
  const r = await fetch(`${FS_DOCS}/${path}`, { headers: { authorization: "Bearer owner" } });
  return { status: r.status, json: await r.json() };
}

async function main() {
  // 초기화
  await fetch(`${FS}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });

  const profile = { name: "테스트사용자", birthDate: "19900101", gender: "male" };

  // 1. signup
  const s1 = await api("/api/auth/signup", { body: { ...profile, consentAgreed: true } });
  check("1 signup ok", s1.status === 200 && s1.json?.ok === true && !s1.json.alreadyRegistered, JSON.stringify({ status: s1.status, msg: s1.json?.message }));
  check("1 signup profile.userNumber=1", s1.json?.profile?.userNumber === 1 && s1.json?.profile?.memberCode === "01", `userNumber=${s1.json?.profile?.userNumber} memberCode=${s1.json?.profile?.memberCode}`);
  check("1 signup no token", !("customToken" in (s1.json || {})));
  const userDocId = s1.json?.profile?.userId;

  // 2. signup again
  const s2 = await api("/api/auth/signup", { body: { ...profile, consentAgreed: true } });
  check("2 signup again alreadyRegistered", s2.status === 200 && s2.json?.ok === true && s2.json?.alreadyRegistered === true && s2.json?.profile?.userId === userDocId, `status=${s2.status}`);
  // NFC/공백 차이도 같은 사용자로
  const s2b = await api("/api/auth/signup", { body: { ...profile, name: "  테스트사용자 ".normalize("NFD"), consentAgreed: true } });
  check("2b signup NFD+공백 이름도 alreadyRegistered", s2b.json?.alreadyRegistered === true);

  // 3. login
  const l1 = await api("/api/auth/login", { body: { ...profile, location: "hyocheon" } });
  check("3 login ok + customToken", l1.status === 200 && l1.json?.ok === true && typeof l1.json?.customToken === "string");
  const session = l1.json?.session || {};
  check("3 login session 형식", session.userId === userDocId && session.role === "collector" && JSON.stringify(session.roles) === '["collector"]' && session.location === "hyocheon" && session.userNumber === 1 && session.memberCode === "01" && session.birthDate === 19900101 && session.gender === "male", JSON.stringify(session));
  const exchanged = await exchangeCustomToken(l1.json?.customToken);
  const collectorIdToken = exchanged.idToken;
  check("3 customToken → idToken 교환", typeof collectorIdToken === "string", exchanged.error?.message || "");
  const collectorClaims = decodeJwt(collectorIdToken);
  check("3 idToken claims", collectorClaims.role === "collector" && collectorClaims.userDocId === userDocId && JSON.stringify(collectorClaims.roles) === '["collector"]', JSON.stringify({ role: collectorClaims.role, roles: collectorClaims.roles, userDocId: collectorClaims.userDocId }));
  // 두 번째 로그인은 같은 Auth uid 재사용
  const l2 = await api("/api/auth/login", { body: { ...profile, location: "aim" } });
  const exchanged2 = await exchangeCustomToken(l2.json?.customToken);
  const uid1 = decodeJwt(exchanged.idToken).sub; const uid2 = decodeJwt(exchanged2.idToken).sub; check("3b 재로그인 시 Auth uid 재사용", Boolean(uid1) && uid1 === uid2, `${uid1} / ${uid2}`);
  const userDoc = await getDoc(`users/${userDocId}`);
  check("3c users.AuthUid 기록", Boolean(uid1) && userDoc.json?.fields?.AuthUid?.stringValue === uid1, userDoc.json?.fields?.AuthUid?.stringValue);

  // 4. consent
  const c1 = await api("/api/collect/consent", { body: { location: "hyocheon" }, token: collectorIdToken });
  check("4 consent created true", c1.status === 200 && c1.json?.ok === true && c1.json?.created === true && c1.json?.id === `${userDocId}_HyoCheon_correct`, JSON.stringify(c1.json));
  const c2 = await api("/api/collect/consent", { body: { location: "hyocheon" }, token: collectorIdToken });
  check("4 consent again created false", c2.status === 200 && c2.json?.created === false, JSON.stringify(c2.json));
  const participant = await getDoc(`locationParticipants/${userDocId}_HyoCheon_correct`);
  const pFields = Object.keys(participant.json?.fields || {});
  check("4 participant 문서에 Name/BirthDate/Gender 없음", !pFields.some((k) => ["Name", "BirthDate", "Gender"].includes(k)), pFields.join(","));
  check("4 participant Location=키, UserId=docId", participant.json?.fields?.Location?.stringValue === "hyocheon" && participant.json?.fields?.UserId?.stringValue === userDocId && participant.json?.fields?.LocationDocId?.stringValue === "HyoCheon");

  // 5. session (참여 기록이 없는 jangdeok 지점에서 바로 녹화 → 참여 자동 생성)
  const sessionBody = {
    location: "jangdeok", bodyPartKey: "LeftKnee", fileName: "J-05-01.webm", mimeType: "video/webm",
    size: 12345, durationMs: 5000, sourceType: "realsense",
    depth: { enabled: true, frameCount: 150, rawFileName: "a.raw", indexFileName: "a.idx", metadataFileName: "a.json", rawSize: 999 },
  };
  const ss = await api("/api/collect/session", { body: sessionBody, token: collectorIdToken });
  check("5 session sessionId", ss.status === 200 && ss.json?.ok === true && typeof ss.json?.sessionId === "string", JSON.stringify(ss.json));
  const sessDoc = await getDoc(`collectionSessions/${ss.json?.sessionId}`);
  const sFields = sessDoc.json?.fields || {};
  check("5 session 문서에 Name/BirthDate/Gender 없음", !["Name", "BirthDate", "Gender"].some((k) => k in sFields), Object.keys(sFields).sort().join(","));
  check("5 session 필드값", sFields.Location?.stringValue === "jangdeok" && sFields.BodyPartCode?.stringValue === "05" && sFields.BodyPartLabel?.stringValue === "왼쪽 무릎" && sFields.SourceType?.stringValue === "realsense" && sFields.DepthFrameCount?.integerValue === "150" && sFields.UserId?.stringValue === userDocId && sFields.MemberCode?.stringValue === "01");
  const loc = await getDoc("locations/Jangdeok");
  const lf = loc.json?.fields || {};
  check("5 locations/Jangdeok 집계", lf.SessionCount?.integerValue === "1" && lf.ConsentCount?.integerValue === "1" && lf.BodyParts?.mapValue?.fields?.LeftKnee?.integerValue === "1" && lf.BodyParts?.mapValue?.fields?.Neck?.integerValue === "0" && !("BodyParts.LeftKnee" in lf), JSON.stringify({ SessionCount: lf.SessionCount, ConsentCount: lf.ConsentCount, Name: lf.Name?.stringValue }));
  const autoParticipant = await getDoc(`locationParticipants/${userDocId}_Jangdeok_correct`);
  check("5 녹화 시 참여 기록 자동 생성", autoParticipant.status === 200);
  const ss2 = await api("/api/collect/session", { body: { ...sessionBody, bodyPartKey: "Neck" }, token: collectorIdToken });
  const loc2 = await getDoc("locations/Jangdeok");
  check("5b 두 번째 녹화: SessionCount 2, ConsentCount 그대로 1", ss2.json?.ok && loc2.json?.fields?.SessionCount?.integerValue === "2" && loc2.json?.fields?.ConsentCount?.integerValue === "1" && loc2.json?.fields?.BodyParts?.mapValue?.fields?.Neck?.integerValue === "1");

  // 6. collector → dashboard-data 403
  const d403 = await api("/api/admin/dashboard-data", { method: "GET", token: collectorIdToken });
  check("6 수집자 dashboard-data 403", d403.status === 403 && d403.json?.ok === false, JSON.stringify(d403.json));
  const lu403 = await api("/api/admin/lookup-user?userNumber=1", { method: "GET", token: collectorIdToken });
  check("6 수집자 lookup-user 403", lu403.status === 403);
  const as403c = await api("/api/auth/admin-session", { token: collectorIdToken });
  check("6 수집자 admin-session 403 not_admin", as403c.status === 403 && as403c.json?.code === "not_admin");

  // 7. 관리자 (Auth 에뮬레이터 signInWithIdp 가짜 Google 사용자)
  const g = await signInWithGoogle({ sub: "google-admin-1", email: "Admin@Example.com" });
  check("7 가짜 Google 사용자 생성", typeof g.idToken === "string", g.error?.message || "");
  const gClaims = decodeJwt(g.idToken);
  check("7 Google idToken provider", gClaims.firebase?.sign_in_provider === "google.com" && gClaims.email_verified === true, JSON.stringify({ p: gClaims.firebase?.sign_in_provider, ev: gClaims.email_verified, email: gClaims.email }));
  const preAdmin = await api("/api/admin/dashboard-data", { method: "GET", token: g.idToken });
  check("7 claim 붙기 전 Google 토큰 dashboard-data 403", preAdmin.status === 403);
  const as1 = await api("/api/auth/admin-session", { token: g.idToken });
  check("7 admin-session ok (미연결)", as1.status === 200 && as1.json?.session?.role === "admin" && JSON.stringify(as1.json?.session?.roles) === '["admin"]' && as1.json?.session?.userId === "" && as1.json?.session?.email === "admin@example.com", JSON.stringify(as1.json));
  let adminToken = await refreshIdToken(g.refreshToken);
  const aClaims = decodeJwt(adminToken);
  check("7 갱신 토큰 claims role=admin, userDocId 없음", aClaims.role === "admin" && !("userDocId" in aClaims), JSON.stringify({ role: aClaims.role, roles: aClaims.roles, userDocId: aClaims.userDocId }));

  // legacyAdjustments 문서 하나를 owner로 직접 넣어 Timestamp 직렬화 확인
  await fetch(`${FS_DOCS}/legacyAdjustments?documentId=adj1`, {
    method: "POST",
    headers: { authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify({ fields: {
      TargetUserId: { stringValue: userDocId }, Location: { stringValue: "aim" }, BodyPart: { stringValue: "Neck" },
      SessionDelta: { integerValue: "2" }, ConsentDelta: { integerValue: "1" },
      CreatedAt: { timestampValue: "2026-10-01T00:00:00Z" }, UpdatedAt: { timestampValue: "2026-10-02T00:00:00Z" },
    } }),
  });
  const dd = await api("/api/admin/dashboard-data", { method: "GET", token: adminToken });
  check("7 관리자 dashboard-data 200", dd.status === 200 && dd.json?.ok === true, `status=${dd.status}`);
  const ddText = JSON.stringify(dd.json || {});
  check("7 dashboard-data에 개인정보 없음", !ddText.includes("테스트사용자") && !ddText.includes("19900101") && !ddText.includes("BirthDate") && !ddText.includes("\"Gender\"") && !ddText.includes("\"Name\""));
  check("7 dashboard-data 형식", dd.json?.users?.length === 1 && dd.json.users[0].ConsentAgreed === true && Object.keys(dd.json.users[0]).sort().join() === "ConsentAgreed,id" && dd.json?.participants?.length === 2 && dd.json?.sessions?.length === 2 && Object.keys(dd.json.sessions[0]).sort().join() === "BodyPart,Location,PostureType,id", JSON.stringify({ users: dd.json?.users, p: dd.json?.participants, s: dd.json?.sessions }));
  const adj = dd.json?.adjustments?.[0] || {};
  check("7 adjustments Timestamp → Ms", adj.CreatedAtMs === Date.parse("2026-10-01T00:00:00Z") && adj.UpdatedAtMs === Date.parse("2026-10-02T00:00:00Z") && !("CreatedAt" in adj) && !("UpdatedAt" in adj) && adj.SessionDelta === 2, JSON.stringify(adj));
  const lu = await api("/api/admin/lookup-user?userNumber=1", { method: "GET", token: adminToken });
  check("7 lookup-user", lu.status === 200 && lu.json?.user?.id === userDocId && lu.json?.user?.name === "테스트사용자" && lu.json?.user?.memberCode === "01" && !("birthDate" in lu.json.user) && !("gender" in lu.json.user), JSON.stringify(lu.json));
  const luNone = await api("/api/admin/lookup-user?userNumber=99", { method: "GET", token: adminToken });
  check("7 lookup-user 없는 번호 → user null", luNone.status === 200 && luNone.json?.user === null);
  const luBad = await api("/api/admin/lookup-user?userNumber=abc", { method: "GET", token: adminToken });
  check("7 lookup-user 잘못된 번호 400", luBad.status === 400);

  // 허용 목록 밖 / 이메일 미인증
  const gOther = await signInWithGoogle({ sub: "google-other-1", email: "other@example.com" });
  const asOther = await api("/api/auth/admin-session", { token: gOther.idToken });
  check("7 허용 목록 밖 이메일 403 not_admin", asOther.status === 403 && asOther.json?.code === "not_admin" && asOther.json?.message === "관리자로 등록되지 않은 계정입니다.", JSON.stringify(asOther.json));
  const gUnverified = await signInWithGoogle({ sub: "google-admin-unverified", email: "admin2@example.com", emailVerified: false });
  const unvClaims = gUnverified.idToken ? decodeJwt(gUnverified.idToken) : {};
  const asUnv = await api("/api/auth/admin-session", { token: gUnverified.idToken });
  check("7 email_verified=false 403", asUnv.status === 403, `email_verified=${unvClaims.email_verified} email=${unvClaims.email} status=${asUnv.status}`);
  const noAuth = await api("/api/auth/admin-session", {});
  check("7 admin-session 토큰 없음 401", noAuth.status === 401);
  const badAuth = await api("/api/auth/admin-session", { token: "not-a-token" });
  check("7 admin-session 잘못된 토큰 401", badAuth.status === 401 && badAuth.json?.code === "invalid_token");

  // 10. 관리자 보정 API (/api/admin/adjustments) — 브라우저 대신 서버가 허용 목록 확인 후 Admin SDK로 쓴다
  const adjBody = {
    location: "hyocheon", bodyPartKey: "LeftShoulder", postureType: "incorrect",
    sessionDelta: 3, consentDelta: 1, note: "  메모  ", targetUserId: userDocId,
    // 클라이언트가 보낸 이름·작성자는 무시되어야 한다
    targetUserName: "가짜이름", CreatedByUserId: "someone-else",
  };
  const adjCreate = await api("/api/admin/adjustments", { body: adjBody, token: adminToken });
  const adjId = adjCreate.json?.id;
  check("10 보정 생성 200 + id", adjCreate.status === 200 && adjCreate.json?.ok === true && typeof adjId === "string" && adjId.length > 0, JSON.stringify(adjCreate.json));
  const adjDoc = await getDoc(`legacyAdjustments/${adjId}`);
  const af = adjDoc.json?.fields || {};
  check("10 TargetUserName·번호·코드는 서버 users 값", af.TargetUserName?.stringValue === "테스트사용자" && af.TargetUserNumber?.integerValue === "1" && af.TargetMemberCode?.stringValue === "01" && af.TargetUserId?.stringValue === userDocId, JSON.stringify({ n: af.TargetUserName, u: af.TargetUserNumber, m: af.TargetMemberCode }));
  check("10 CreatedByUserId = 관리자 uid, CreatedByName = 토큰 name", af.CreatedByUserId?.stringValue === aClaims.sub && af.CreatedByName?.stringValue === "관리자테스트", JSON.stringify({ by: af.CreatedByUserId, name: af.CreatedByName, uid: aClaims.sub }));
  check("10 저장 필드값(지점·부위·유형·메모)", af.Location?.stringValue === "hyocheon" && af.LocationDocId?.stringValue === "HyoCheon" && af.SiteCode?.stringValue === "H" && af.BodyPart?.stringValue === "LeftShoulder" && af.BodyPartCode?.stringValue === "03" && af.BodyPartLabel?.stringValue === "왼쪽 어깨" && af.PostureType?.stringValue === "incorrect" && af.PostureCode?.stringValue === "1" && af.PostureLabel?.stringValue === "오답" && af.SessionDelta?.integerValue === "3" && af.ConsentDelta?.integerValue === "1" && af.Note?.stringValue === "메모" && typeof af.CreatedAt?.timestampValue === "string" && typeof af.UpdatedAt?.timestampValue === "string");
  const expectedAdjKeys = "BodyPart,BodyPartCode,BodyPartLabel,ConsentDelta,CreatedAt,CreatedByName,CreatedByUserId,Location,LocationDocId,Note,PostureCode,PostureLabel,PostureType,SessionDelta,SiteCode,TargetMemberCode,TargetUserId,TargetUserName,TargetUserNumber,UpdatedAt";
  check("10 저장 필드 목록이 예전 클라이언트 쓰기와 같다", Object.keys(af).sort().join() === expectedAdjKeys, Object.keys(af).sort().join());
  const ddAdj = await api("/api/admin/dashboard-data", { method: "GET", token: adminToken });
  const ddAdjItem = (ddAdj.json?.adjustments || []).find((item) => item.id === adjId) || {};
  check("10 생성한 보정이 dashboard-data adjustments 에 포함", ddAdj.status === 200 && ddAdjItem.SessionDelta === 3 && ddAdjItem.ConsentDelta === 1 && ddAdjItem.TargetUserId === userDocId && typeof ddAdjItem.CreatedAtMs === "number" && !("CreatedAt" in ddAdjItem), JSON.stringify(ddAdjItem));

  const adjZero = await api("/api/admin/adjustments", { body: { ...adjBody, sessionDelta: 0, consentDelta: 0 }, token: adminToken });
  check("10 건수·인원 둘 다 0 → 400", adjZero.status === 400 && adjZero.json?.code === "empty_adjustment", JSON.stringify(adjZero.json));
  const adjNoUser = await api("/api/admin/adjustments", { body: { ...adjBody, targetUserId: "no-such-user" }, token: adminToken });
  check("10 없는 targetUserId → 404 target_user_not_found", adjNoUser.status === 404 && adjNoUser.json?.code === "target_user_not_found", JSON.stringify(adjNoUser.json));
  const adjLongNote = await api("/api/admin/adjustments", { body: { ...adjBody, note: "가".repeat(501) }, token: adminToken });
  check("10 note 501자 → 400", adjLongNote.status === 400 && adjLongNote.json?.code === "invalid_note", JSON.stringify(adjLongNote.json));
  const adjNoLoc = await api("/api/admin/adjustments", { body: { ...adjBody, location: "" }, token: adminToken });
  check("10 빈 location → 400", adjNoLoc.status === 400 && adjNoLoc.json?.code === "invalid_location");
  const adjStrDelta = await api("/api/admin/adjustments", { body: { ...adjBody, sessionDelta: "2" }, token: adminToken });
  const adjNegDelta = await api("/api/admin/adjustments", { body: { ...adjBody, consentDelta: -1 }, token: adminToken });
  const adjFloatDelta = await api("/api/admin/adjustments", { body: { ...adjBody, sessionDelta: 1.5 }, token: adminToken });
  check("10 문자열·음수·소수 delta → 400", adjStrDelta.status === 400 && adjNegDelta.status === 400 && adjFloatDelta.status === 400, [adjStrDelta.status, adjNegDelta.status, adjFloatDelta.status].join(","));
  const adjBadPosture = await api("/api/admin/adjustments", { body: { ...adjBody, postureType: "x" }, token: adminToken });
  const adjBadPart = await api("/api/admin/adjustments", { body: { ...adjBody, bodyPartKey: "__proto__" }, token: adminToken });
  const adjSlashUser = await api("/api/admin/adjustments", { body: { ...adjBody, targetUserId: "a/b" }, token: adminToken });
  const adjEmptyUser = await api("/api/admin/adjustments", { body: { ...adjBody, targetUserId: "" }, token: adminToken });
  check("10 잘못된 유형·부위·대상 ID → 400", adjBadPosture.status === 400 && adjBadPart.status === 400 && adjSlashUser.status === 400 && adjEmptyUser.status === 400, [adjBadPosture.status, adjBadPart.status, adjSlashUser.status, adjEmptyUser.status].join(","));
  const adjCollector = await api("/api/admin/adjustments", { body: adjBody, token: collectorIdToken });
  check("10 수집자 토큰 생성 403", adjCollector.status === 403 && adjCollector.json?.code === "forbidden", JSON.stringify(adjCollector.json));
  const adjCollectorDel = await api(`/api/admin/adjustments?id=${encodeURIComponent(adjId)}`, { method: "DELETE", token: collectorIdToken });
  check("10 수집자 토큰 삭제 403", adjCollectorDel.status === 403);
  const adjNoToken = await api("/api/admin/adjustments", { body: adjBody });
  check("10 토큰 없음 401", adjNoToken.status === 401);
  const adjGet = await api("/api/admin/adjustments", { method: "GET", token: adminToken });
  check("10 GET → 405", adjGet.status === 405);

  // 허용 목록에서 빠진 계정에 role=admin claim 이 남아 있어도 거부되어야 한다(이번 작업의 핵심)
  const staleClaim = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, {
    method: "POST",
    headers: { authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify({ localId: decodeJwt(gOther.idToken).sub, customAttributes: JSON.stringify({ role: "admin", roles: ["admin"] }) }),
  });
  const staleToken = await refreshIdToken(gOther.refreshToken);
  const staleClaims = staleToken ? decodeJwt(staleToken) : {};
  check("10 (준비) 목록 밖 계정에 admin claim 부여", staleClaim.ok && staleClaims.role === "admin", `status=${staleClaim.status} role=${staleClaims.role}`);
  const adjStale = await api("/api/admin/adjustments", { body: adjBody, token: staleToken });
  const adjStaleDel = await api(`/api/admin/adjustments?id=${encodeURIComponent(adjId)}`, { method: "DELETE", token: staleToken });
  check("10 목록 밖 계정은 claim 이 남아 있어도 생성·삭제 403", adjStale.status === 403 && adjStaleDel.status === 403, `${adjStale.status}/${adjStaleDel.status}`);

  const adjDel = await api(`/api/admin/adjustments?id=${encodeURIComponent(adjId)}`, { method: "DELETE", token: adminToken });
  const adjDocAfter = await getDoc(`legacyAdjustments/${adjId}`);
  check("10 삭제 200 + 문서 사라짐", adjDel.status === 200 && adjDel.json?.ok === true && adjDocAfter.status === 404, `${adjDel.status} / doc ${adjDocAfter.status}`);
  const adjDelAgain = await api(`/api/admin/adjustments?id=${encodeURIComponent(adjId)}`, { method: "DELETE", token: adminToken });
  check("10 재삭제 404", adjDelAgain.status === 404 && adjDelAgain.json?.code === "adjustment_not_found", JSON.stringify(adjDelAgain.json));
  const adjDelBody = await api("/api/admin/adjustments", { method: "DELETE", body: { id: "adj1" }, token: adminToken });
  const adj1After = await getDoc("legacyAdjustments/adj1");
  check("10 본문 { id } 로 삭제", adjDelBody.status === 200 && adj1After.status === 404, `${adjDelBody.status} / doc ${adj1After.status}`);
  const adjDelNoId = await api("/api/admin/adjustments", { method: "DELETE", token: adminToken });
  check("10 id 없는 삭제 400", adjDelNoId.status === 400 && adjDelNoId.json?.code === "invalid_id");

  // 관리자 연결 모드
  const link = await api("/api/auth/login", { body: { ...profile, location: "aim" }, token: adminToken, ip: "198.51.100.2" });
  check("7 관리자 연결 모드 linked", link.status === 200 && link.json?.linked === true && !("customToken" in link.json) && link.json?.session?.role === "collector" && JSON.stringify(link.json?.session?.roles) === '["admin","collector"]' && link.json?.session?.userId === userDocId, JSON.stringify(link.json));
  const linkedUser = await getDoc(`users/${userDocId}`);
  check("7 users.AdminEmail 기록(소문자)", linkedUser.json?.fields?.AdminEmail?.stringValue === "admin@example.com");
  adminToken = await refreshIdToken(g.refreshToken);
  const lClaims = decodeJwt(adminToken);
  check("7 연결 후 claims", lClaims.role === "admin" && lClaims.userDocId === userDocId && JSON.stringify(lClaims.roles) === '["admin","collector"]' && lClaims.email === "admin@example.com", JSON.stringify({ role: lClaims.role, roles: lClaims.roles, userDocId: lClaims.userDocId, email: lClaims.email }));
  const as2 = await api("/api/auth/admin-session", { token: adminToken });
  check("7 연결 후 admin-session", as2.json?.session?.userId === userDocId && JSON.stringify(as2.json?.session?.roles) === '["admin","collector"]' && as2.json?.session?.userNumber === 1 && as2.json?.session?.memberCode === "01" && as2.json?.session?.name === "테스트사용자", JSON.stringify(as2.json));
  const adminConsent = await api("/api/collect/consent", { body: { location: "aim" }, token: adminToken });
  check("7 연결된 관리자 토큰으로 consent 가능", adminConsent.status === 200 && adminConsent.json?.ok === true, JSON.stringify(adminConsent.json));
  // 다른 사용자로 재연결 → 예전 연결 해제
  await api("/api/auth/signup", { body: { name: "둘째사용자", birthDate: "20000202", gender: "female", consentAgreed: true }, ip: "198.51.100.2" });
  const relink = await api("/api/auth/login", { body: { name: "둘째사용자", birthDate: "20000202", gender: "female" }, token: adminToken, ip: "198.51.100.2" });
  const oldUser = await getDoc(`users/${userDocId}`);
  const newUser = await getDoc(`users/${relink.json?.session?.userId}`);
  check("7 재연결 시 예전 AdminEmail 해제", relink.json?.linked === true && !oldUser.json?.fields?.AdminEmail && newUser.json?.fields?.AdminEmail?.stringValue === "admin@example.com" && relink.json?.session?.userNumber === 2);
  // 수집자 토큰을 Bearer로 붙여 login 해도 연결 모드가 아니라 일반 로그인
  const collectorBearerLogin = await api("/api/auth/login", { body: { ...profile }, token: collectorIdToken, ip: "198.51.100.2" });
  check("7 수집자 Bearer login은 일반 로그인(customToken)", typeof collectorBearerLogin.json?.customToken === "string" && !collectorBearerLogin.json?.linked);

  // 9. 잘못된 입력 / 메서드
  const ip9 = "198.51.100.9";
  const bad1 = await api("/api/auth/signup", { body: { ...profile, birthDate: "1990010", consentAgreed: true }, ip: ip9 });
  check("9 생년월일 7자리 400", bad1.status === 400 && bad1.json?.code === "invalid_birth_date", JSON.stringify(bad1.json));
  const bad2 = await api("/api/auth/login", { body: { ...profile, gender: "x" }, ip: ip9 });
  check("9 gender x 400", bad2.status === 400 && bad2.json?.code === "invalid_gender");
  const bad3 = await api("/api/auth/login", { body: { ...profile, location: "busan" }, ip: ip9 });
  check("9 잘못된 location(login) 400", bad3.status === 400 && bad3.json?.code === "invalid_location");
  const bad3b = await api("/api/collect/consent", { body: { location: "__proto__" }, token: collectorIdToken });
  check("9 잘못된 location(consent __proto__) 400", bad3b.status === 400 && bad3b.json?.code === "invalid_location");
  const bad4 = await api("/api/auth/login", { method: "GET", ip: ip9 });
  check("9 GET /api/auth/login 405", bad4.status === 405 && bad4.json?.code === "method_not_allowed");
  const bad5 = await api("/api/admin/dashboard-data", { method: "POST", token: adminToken });
  check("9 POST dashboard-data 405", bad5.status === 405);
  const bad6 = await api("/api/auth/signup", { body: { ...profile, consentAgreed: false }, ip: ip9 });
  check("9 consentAgreed false 400 consent_required", bad6.status === 400 && bad6.json?.code === "consent_required");
  const bad7 = await api("/api/collect/session", { body: { ...sessionBody, bodyPartKey: "Elbow" }, token: collectorIdToken });
  check("9 잘못된 bodyPartKey 400", bad7.status === 400 && bad7.json?.code === "invalid_body_part");
  const bad8 = await api("/api/collect/session", { body: { ...sessionBody, fileName: "" }, token: collectorIdToken });
  check("9 빈 fileName 400", bad8.status === 400);
  const bad9 = await api("/api/collect/session", { body: { ...sessionBody, size: -1 }, token: collectorIdToken });
  check("9 음수 size 400", bad9.status === 400);
  const bad10 = await api("/api/collect/session", { body: { ...sessionBody, sourceType: "phone" }, token: collectorIdToken });
  check("9 잘못된 sourceType 400", bad10.status === 400);
  const bad11 = await api("/api/collect/consent", { body: { location: "aim" } });
  check("9 consent 토큰 없음 401", bad11.status === 401);
  const bad12 = await api("/api/auth/login", { rawBody: "{not json", ip: ip9 });
  check("9 잘못된 JSON 400", bad12.status === 400 && bad12.json?.code === "invalid_json");
  const bad13 = await api("/api/_lib/http", {});
  check("9 /api/_lib/* 404", bad13.status === 404);
  const bad14 = await api("/api/collect/session", { body: { ...sessionBody, size: "abc" }, token: collectorIdToken });
  check("9 숫자 아닌 size 400", bad14.status === 400);
  const notFound = await api("/api/auth/login", { body: { name: "없는사람", birthDate: "19800101", gender: "female" }, ip: ip9 });
  check("9 없는 사용자 200 user_not_found", notFound.status === 200 && notFound.json?.ok === false && notFound.json?.code === "user_not_found" && notFound.json?.message === "회원가입한 정보와 일치하는 사용자를 찾을 수 없습니다.");

  // 8. 시도 제한: 새 IP로 31회
  const ip8 = "203.0.113.77";
  const statuses = [];
  for (let i = 0; i < 31; i += 1) {
    const r = await api("/api/auth/login", { body: { name: "없는사람", birthDate: "19800101", gender: "female" }, ip: ip8 });
    statuses.push(r.status);
    if (i === 30) check("8 31번째 429 too_many_attempts", r.status === 429 && r.json?.code === "too_many_attempts" && r.json?.message === "요청이 너무 많습니다. 10분 뒤 다시 시도해 주세요.", JSON.stringify(r.json));
  }
  check("8 1~30번째는 200", statuses.slice(0, 30).every((s) => s === 200), statuses.join(","));
  const otherIp = await api("/api/auth/signup", { body: { ...profile, consentAgreed: true }, ip: "203.0.113.78" });
  check("8 다른 IP는 영향 없음", otherIp.status === 200);
  const sameIpSignup = await api("/api/auth/signup", { body: { ...profile, consentAgreed: true }, ip: ip8 });
  check("8 같은 IP는 signup도 합산되어 429", sameIpSignup.status === 429);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n총 ${results.length}건, 통과 ${results.length - failed.length}, 실패 ${failed.length}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error("테스트 스크립트 오류", error);
  process.exitCode = 2;
});
