import { HttpError, readJsonBody, requireCollector, sendJson, withHandler } from "../_lib/http.js";
import {
  ensureUserNumber,
  getUsersCollection,
  parseBodyPartKey,
  parseLocationKey,
  recordCollectionSession,
} from "../_lib/users.js";

const SOURCE_TYPES = ["browser", "realsense"];
const FILE_NAME_MAX_LENGTH = 255;
const MIME_TYPE_MAX_LENGTH = 100;

function parseRequiredText(value, maxLength, code, message) {
  const text = typeof value === "string" ? value.trim() : "";

  if (!text || text.length > maxLength) {
    throw new HttpError(400, code, message);
  }

  return text;
}

// 0 이상 유한한 숫자만 받는다. 값이 없으면 0으로 본다(기존 프론트의 Number(x || 0)과 같은 처리).
function parseNonNegativeNumber(value, code, message) {
  if (value === undefined || value === null) {
    return 0;
  }

  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new HttpError(400, code, message);
  }

  return parsed;
}

function parseSourceType(value) {
  if (value === undefined || value === null || value === "") {
    return "browser";
  }

  if (!SOURCE_TYPES.includes(value)) {
    throw new HttpError(400, "invalid_source_type", "녹화 장치 유형이 올바르지 않습니다.");
  }

  return value;
}

function sanitizeOptionalText(value) {
  return typeof value === "string" ? value.trim().slice(0, FILE_NAME_MAX_LENGTH) : "";
}

function parseDepth(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_depth", "깊이 데이터 정보가 올바르지 않습니다.");
  }

  const depthMessage = "깊이 데이터 정보가 올바르지 않습니다.";

  return {
    enabled: value.enabled === true,
    frameCount: parseNonNegativeNumber(value.frameCount, "invalid_depth", depthMessage),
    rawFileName: sanitizeOptionalText(value.rawFileName),
    indexFileName: sanitizeOptionalText(value.indexFileName),
    metadataFileName: sanitizeOptionalText(value.metadataFileName),
    rawSize: parseNonNegativeNumber(value.rawSize, "invalid_depth", depthMessage),
  };
}

// POST /api/collect/session — 녹화 1건의 메타데이터를 저장한다(영상 파일 자체는 로컬에 남는다).
async function sessionHandler(req, res) {
  const decoded = await requireCollector(req);
  const body = readJsonBody(req);

  const locationKey = parseLocationKey(body.location);
  const bodyPartKey = parseBodyPartKey(body.bodyPartKey);
  const fileName = parseRequiredText(
    body.fileName,
    FILE_NAME_MAX_LENGTH,
    "invalid_file_name",
    "녹화 파일 이름이 비어 있거나 너무 깁니다.",
  );
  const mimeType = parseRequiredText(
    body.mimeType,
    MIME_TYPE_MAX_LENGTH,
    "invalid_mime_type",
    "녹화 파일 형식이 비어 있거나 올바르지 않습니다.",
  );
  const fileSize = parseNonNegativeNumber(body.size, "invalid_size", "파일 크기가 올바르지 않습니다.");
  const durationMs = parseNonNegativeNumber(
    body.durationMs,
    "invalid_duration",
    "녹화 시간이 올바르지 않습니다.",
  );
  const sourceType = parseSourceType(body.sourceType);
  const depth = parseDepth(body.depth);

  const userRef = getUsersCollection().doc(decoded.userDocId);
  const { userNumber, memberCode } = await ensureUserNumber(userRef);
  const { sessionId } = await recordCollectionSession({
    userDocId: userRef.id,
    userNumber,
    memberCode,
    locationKey,
    bodyPartKey,
    fileName,
    mimeType,
    fileSize,
    durationMs,
    sourceType,
    depth,
  });

  sendJson(res, 200, { ok: true, sessionId });
}

export default withHandler(sessionHandler, { methods: ["POST"] });
