import { apiRequest } from "./firebase-client.js";

// 지점 코드와 표시 이름은 파일명 생성과 대시보드 표시에서 함께 사용합니다.
export const LOCATION_META = {
  aim: {
    docId: "Company",
    name: "회사",
    displayName: "AIM",
    siteCode: "A",
    chipLabel: "AIM",
  },
  hyocheon: {
    docId: "HyoCheon",
    name: "필라테스 이끌림 효천점",
    displayName: "이끌림(효천점)",
    siteCode: "H",
    chipLabel: "효천점",
  },
  jangdeok: {
    docId: "Jangdeok",
    name: "필라테스 이끌림 장덕점",
    displayName: "이끌림(장덕점)",
    siteCode: "J",
    chipLabel: "장덕점",
  },
};

// 촬영 부위 메타는 UI 라벨과 파일명용 코드 생성을 함께 관리합니다.
export const BODY_PART_OPTIONS = [
  { key: "Neck", label: "목", fileSegment: "neck" },
  { key: "Hip", label: "허리", fileSegment: "hip" },
  { key: "LeftShoulder", label: "왼쪽 어깨", fileSegment: "left-shoulder" },
  { key: "RightShoulder", label: "오른쪽 어깨", fileSegment: "right-shoulder" },
  { key: "LeftKnee", label: "왼쪽 무릎", fileSegment: "left-knee" },
  { key: "RightKnee", label: "오른쪽 무릎", fileSegment: "right-knee" },
];

export const POSTURE_TYPE_OPTIONS = [
  { key: "all", label: "총합", codeSuffix: "" },
  { key: "correct", label: "정답", codeSuffix: "" },
  { key: "incorrect", label: "오답", codeSuffix: "1" },
];

const BODY_PART_CODE_MAP = {
  Neck: "01",
  Hip: "02",
  LeftShoulder: "03",
  RightShoulder: "04",
  LeftKnee: "05",
  RightKnee: "06",
};

// 정답/오답 구분 없이 수집만 하므로 기록의 자세 구분은 서버가 항상 "correct"로 고정함.

function normalizePostureType(value) {
  return value === "incorrect" ? "incorrect" : "correct";
}

function getBodyPartCode(bodyPartKey) {
  return BODY_PART_CODE_MAP[bodyPartKey] || "00";
}

function getLocationMeta(locationKey) {
  return LOCATION_META[locationKey] || LOCATION_META.aim;
}

function formatMemberCode(value) {
  const parsedValue = Number(value || 0);

  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    return "00";
  }

  return String(parsedValue).padStart(2, "0");
}

function getLocationKey(session) {
  return LOCATION_META[session?.location] ? session.location : "aim";
}

// 같은 회원이 같은 지점에서 수집을 시작하면 참여 기록을 한 번만 만듭니다(서버가 처리).
export async function ensureCollectorConsentAtLocation(session) {
  const result = await apiRequest("/api/collect/consent", {
    body: { location: getLocationKey(session) },
  });

  if (!result.ok) {
    throw new Error(result.message || "지점 참여 기록 처리 중 오류가 발생했습니다.");
  }

  return {
    created: Boolean(result.created),
    id: result.id || "",
  };
}

// 실제 영상 1개의 메타데이터를 서버에 기록하고 지점 집계도 함께 올립니다(서버가 처리).
export async function saveCollectionRecording({
  session,
  bodyPartKey,
  fileName,
  mimeType,
  size,
  durationMs,
  sourceType = "browser",
  depth = null,
}) {
  const result = await apiRequest("/api/collect/session", {
    body: {
      location: getLocationKey(session),
      bodyPartKey,
      fileName,
      mimeType,
      size: Number(size || 0),
      durationMs: Number(durationMs || 0),
      sourceType,
      depth: depth
        ? {
            enabled: Boolean(depth.enabled),
            frameCount: Number(depth.frameCount || 0),
            rawFileName: depth.rawFileName || "",
            indexFileName: depth.indexFileName || "",
            metadataFileName: depth.metadataFileName || "",
            rawSize: Number(depth.rawSize || 0),
          }
        : null,
    },
  });

  if (!result.ok) {
    throw new Error(result.message || "녹화 기록 저장 중 오류가 발생했습니다.");
  }

  return {
    ok: true,
    sessionId: result.sessionId || "",
  };
}

// 파일명은 지점 코드 - 부위 코드 - 회원 코드 형식으로 고정합니다.
export function buildRecordingFileName(session, bodyPartKey) {
  const locationMeta = getLocationMeta(session?.location);
  const bodyPartCode = getBodyPartCode(bodyPartKey);
  const memberCode = session?.memberCode || formatMemberCode(session?.userNumber);

  return `${locationMeta.siteCode}-${bodyPartCode}-${memberCode}.webm`;
}

export function formatPostureLabel(postureType) {
  return normalizePostureType(postureType) === "incorrect" ? "오답" : "정답";
}

export function formatGenderLabel(gender) {
  return gender === "female" ? "여" : "남";
}

export function formatBirthDateChip(birthDate) {
  const digits = String(birthDate || "").replace(/\D/g, "");

  if (digits.length !== 8) {
    return birthDate || "-";
  }

  return `${digits.slice(2, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

export function getLocationChipLabel(location) {
  return getLocationMeta(location).chipLabel;
}
