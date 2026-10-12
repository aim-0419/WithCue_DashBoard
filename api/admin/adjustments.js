import { FieldValue, getDb } from "../_lib/firebase-admin.js";
import { HttpError, readJsonBody, requireAdmin, sendJson, withHandler } from "../_lib/http.js";
import {
  BODY_PART_META,
  LOCATION_META,
  formatMemberCode,
  getUsersCollection,
  parseBodyPartKey,
  parseLocationKey,
} from "../_lib/users.js";

const ADJUSTMENTS_COLLECTION = "legacyAdjustments";
const NOTE_MAX_LENGTH = 500;
const DOC_ID_MAX_LENGTH = 128;

// 예전 Firestore 규칙(legacyAdjustments create)과 같은 수준으로 검증한다.
// 브라우저는 더 이상 Firestore에 직접 쓰지 않고, 이 API가 관리자 허용 목록을 매번 확인한 뒤 Admin SDK로 쓴다.

// 지점은 보정 기록에서 반드시 명시해야 하므로 빈 값을 aim으로 보지 않고 400으로 막는다.
function parseRequiredLocation(value) {
  if (value === undefined || value === null || value === "") {
    throw new HttpError(400, "invalid_location", "지점 값이 올바르지 않습니다.");
  }

  return parseLocationKey(value);
}

function parsePostureType(value) {
  if (value !== "correct" && value !== "incorrect") {
    throw new HttpError(400, "invalid_posture_type", "유형 값이 올바르지 않습니다.");
  }

  return value;
}

// 0 이상의 정수만 받는다(문자열 숫자·소수·음수는 거부).
function parseDelta(value, code, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, code, `${label}는 0 이상의 정수로 입력해 주세요.`);
  }

  return value;
}

function parseNote(value) {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_note", "메모 형식이 올바르지 않습니다.");
  }

  const note = value.trim();

  if (note.length > NOTE_MAX_LENGTH) {
    throw new HttpError(400, "invalid_note", `메모는 ${NOTE_MAX_LENGTH}자 이하로 입력해 주세요.`);
  }

  return note;
}

// Firestore 문서 ID로 쓸 수 있는 값만 받는다. 슬래시(하위 경로)·"."·".."·"__이름__"(예약 ID)은 거부한다.
function isValidDocId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= DOC_ID_MAX_LENGTH &&
    !value.includes("/") &&
    value !== "." &&
    value !== ".." &&
    !/^__.*__$/.test(value)
  );
}

function parseTargetUserId(value) {
  const text = typeof value === "string" ? value.trim() : "";

  if (!isValidDocId(text)) {
    throw new HttpError(400, "invalid_target_user", "반영할 회원번호를 먼저 검색해 주세요.");
  }

  return text;
}

// 대상 회원의 이름·회원번호·회원코드는 클라이언트 값을 믿지 않고 서버가 users 문서에서 채운다.
async function loadTargetUser(targetUserId) {
  const snapshot = await getUsersCollection().doc(targetUserId).get();

  if (!snapshot.exists) {
    throw new HttpError(404, "target_user_not_found", "반영할 회원을 찾을 수 없습니다. 회원번호를 다시 검색해 주세요.");
  }

  const data = snapshot.data() || {};
  const userNumber = data.UserNumber;
  const name = typeof data.Name === "string" ? data.Name.trim() : "";

  if (!Number.isSafeInteger(userNumber) || userNumber < 1) {
    throw new HttpError(400, "invalid_target_user", "회원번호가 없는 회원에게는 보정 데이터를 반영할 수 없습니다.");
  }

  if (!name) {
    throw new HttpError(400, "invalid_target_user", "이름이 없는 회원에게는 보정 데이터를 반영할 수 없습니다.");
  }

  return {
    id: snapshot.id,
    name,
    userNumber,
    memberCode: typeof data.MemberCode === "string" && data.MemberCode ? data.MemberCode : formatMemberCode(userNumber),
  };
}

// POST /api/admin/adjustments — 보정 기록 추가. 필드 이름·형식은 대시보드 집계(aggregateDashboard)가 읽는 것과 같다.
async function createAdjustment(req, res, admin) {
  const body = readJsonBody(req);

  const location = parseRequiredLocation(body.location);
  const bodyPartKey = parseBodyPartKey(body.bodyPartKey);
  const postureType = parsePostureType(body.postureType);
  const sessionDelta = parseDelta(body.sessionDelta, "invalid_session_delta", "추가 건수");
  const consentDelta = parseDelta(body.consentDelta, "invalid_consent_delta", "추가 인원 수");

  if (sessionDelta <= 0 && consentDelta <= 0) {
    throw new HttpError(400, "empty_adjustment", "추가 건수 또는 인원 수를 1 이상 입력해 주세요.");
  }

  const note = parseNote(body.note);
  const targetUser = await loadTargetUser(parseTargetUserId(body.targetUserId));

  const locationMeta = LOCATION_META[location];
  const bodyPartMeta = BODY_PART_META[bodyPartKey];
  const createdByName = String(admin.name || admin.email || "").trim() || "관리자";

  const ref = await getDb().collection(ADJUSTMENTS_COLLECTION).add({
    Location: location,
    LocationDocId: locationMeta.docId,
    SiteCode: locationMeta.siteCode,
    BodyPart: bodyPartKey,
    BodyPartCode: bodyPartMeta.code,
    BodyPartLabel: bodyPartMeta.label,
    PostureType: postureType,
    PostureCode: postureType === "incorrect" ? "1" : "0",
    PostureLabel: postureType === "incorrect" ? "오답" : "정답",
    SessionDelta: sessionDelta,
    ConsentDelta: consentDelta,
    Note: note,
    TargetUserId: targetUser.id,
    TargetUserName: targetUser.name,
    TargetUserNumber: targetUser.userNumber,
    TargetMemberCode: targetUser.memberCode,
    CreatedByName: createdByName,
    CreatedByUserId: admin.uid,
    CreatedAt: FieldValue.serverTimestamp(),
    UpdatedAt: FieldValue.serverTimestamp(),
  });

  sendJson(res, 200, { ok: true, id: ref.id });
}

// DELETE /api/admin/adjustments?id=<docId> (또는 본문 { id }) — 보정 기록 삭제. 수정 API는 두지 않는다.
async function deleteAdjustment(req, res) {
  const queryId = req.query?.id;
  let id = queryId;

  if (id === undefined || id === null || id === "") {
    id = readJsonBody(req).id;
  }

  if (!isValidDocId(id)) {
    throw new HttpError(400, "invalid_id", "삭제할 보정 데이터가 올바르지 않습니다.");
  }

  const ref = getDb().collection(ADJUSTMENTS_COLLECTION).doc(id);
  const snapshot = await ref.get();

  if (!snapshot.exists) {
    throw new HttpError(404, "adjustment_not_found", "삭제할 보정 데이터를 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.");
  }

  await ref.delete();
  sendJson(res, 200, { ok: true });
}

async function adjustmentsHandler(req, res) {
  // 매 호출마다 허용 목록(ADMIN_EMAILS)까지 확인한다. 목록에서 빠진 계정은 claim이 남아 있어도 403.
  const admin = await requireAdmin(req);

  if (req.method === "DELETE") {
    await deleteAdjustment(req, res);
    return;
  }

  await createAdjustment(req, res, admin);
}

export default withHandler(adjustmentsHandler, { methods: ["POST", "DELETE"] });
