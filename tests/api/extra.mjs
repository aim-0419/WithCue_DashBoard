const API = process.env.API_BASE || "http://127.0.0.1:3100", AUTH = "http://127.0.0.1:9099", FS = "http://127.0.0.1:8080", P = "withcuedashboard";
const DOCS = `${FS}/v1/projects/${P}/databases/(default)/documents`;
let fails = 0;
const check = (n, c, d = "") => { if (!c) fails++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  -- " + d : ""}`); };
const jwt = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
async function api(path, { method = "POST", body, token, ip = "192.0.2.10" } = {}) {
  const h = { "x-forwarded-for": ip, "content-type": "application/json" }; if (token) h.authorization = `Bearer ${token}`;
  const r = await fetch(API + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const post = (url, body, headers = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then((r) => r.json());
const refresh = (rt) => fetch(`${AUTH}/securetoken.googleapis.com/v1/token?key=any`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `grant_type=refresh_token&refresh_token=${rt}` }).then((r) => r.json()).then((j) => j.id_token);

await fetch(`${FS}/emulator/v1/projects/${P}/databases/(default)/documents`, { method: "DELETE" });
await fetch(`${AUTH}/emulator/v1/projects/${P}/accounts`, { method: "DELETE" });

// A. 익명 시절 AuthUid → 로그인 시 새 Auth 사용자로 교체
const prof = { name: "익명시절", birthDate: "19850505", gender: "female" };
const su = await api("/api/auth/signup", { body: { ...prof, consentAgreed: true } });
const docId = su.json.profile.userId;
const anon = await post(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`, { returnSecureToken: true });
await fetch(`${DOCS}/users/${docId}?updateMask.fieldPaths=AuthUid`, { method: "PATCH", headers: { authorization: "Bearer owner", "content-type": "application/json" }, body: JSON.stringify({ fields: { AuthUid: { stringValue: anon.localId } } }) });
const li = await api("/api/auth/login", { body: prof });
const ex = await post(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=any`, { token: li.json.customToken, returnSecureToken: true });
const newUid = jwt(ex.idToken).sub;
const ud = await fetch(`${DOCS}/users/${docId}`, { headers: { authorization: "Bearer owner" } }).then((r) => r.json());
check("A 익명 uid는 재사용하지 않고 새 uid 발급", newUid !== anon.localId && ud.fields.AuthUid.stringValue === newUid, `${anon.localId} -> ${newUid}`);
// 다른 users 문서 소유 uid를 가리키는 경우도 교체
const su2 = await api("/api/auth/signup", { body: { name: "다른사람", birthDate: "19950101", gender: "male", consentAgreed: true } });
await fetch(`${DOCS}/users/${su2.json.profile.userId}?updateMask.fieldPaths=AuthUid`, { method: "PATCH", headers: { authorization: "Bearer owner", "content-type": "application/json" }, body: JSON.stringify({ fields: { AuthUid: { stringValue: newUid } } }) });
const li2 = await api("/api/auth/login", { body: { name: "다른사람", birthDate: "19950101", gender: "male" } });
const ex2 = await post(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=any`, { token: li2.json.customToken, returnSecureToken: true });
check("A2 다른 문서 소유 uid는 가로채지 않음", jwt(ex2.idToken).sub !== newUid && jwt(ex2.idToken).userDocId === su2.json.profile.userId);

// B. 허용 목록에서 빠진 계정의 남은 admin claim
const g = await post(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=any`, { postBody: `id_token=${encodeURIComponent(JSON.stringify({ sub: "g-removed", email: "removed@example.com", email_verified: true }))}&providerId=google.com`, requestUri: "http://localhost", returnSecureToken: true });
await post(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${P}/accounts:update`, { localId: g.localId, customAttributes: JSON.stringify({ role: "admin", roles: ["admin"], email: "removed@example.com" }) }, { authorization: "Bearer owner" });
const stale = await refresh(g.refreshToken);
check("B 남은 claim 확인(role=admin)", jwt(stale).role === "admin");
const dd = await api("/api/admin/dashboard-data", { method: "GET", token: stale });
check("B 허용 목록 밖 admin claim으로 dashboard-data 403", dd.status === 403);
const as = await api("/api/auth/admin-session", { token: stale });
const after = await refresh(g.refreshToken);
check("B admin-session 403 + claim 제거", as.status === 403 && jwt(after).role === undefined, `role after=${jwt(after).role}`);

// C. 동시 회원가입: 같은 정보 6건 → 문서 1개, 다른 정보 5건 → 회원번호 중복 없음
const same = { name: "동시가입", birthDate: "20010101", gender: "male", consentAgreed: true };
const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => api("/api/auth/signup", { body: same, ip: `192.0.2.${50 + i}` })));
const ids = new Set(rs.map((r) => r.json?.profile?.userId));
check("C 같은 정보 동시 가입 → users 문서 1개", ids.size === 1 && rs.every((r) => r.status === 200), `statuses=${rs.map((r) => r.status)} ids=${[...ids]}`);
const diff = await Promise.all(Array.from({ length: 5 }, (_, i) => api("/api/auth/signup", { body: { name: `번호${i}`, birthDate: "20020202", gender: "female", consentAgreed: true }, ip: `192.0.2.${70 + i}` })));
const nums = diff.map((r) => r.json?.profile?.userNumber);
check("C 동시 가입 회원번호 중복 없음", new Set(nums).size === 5 && nums.every((n) => n > 0), nums.join(","));
console.log(fails ? `실패 ${fails}` : "추가 검증 전부 통과");
process.exitCode = fails ? 1 : 0;
