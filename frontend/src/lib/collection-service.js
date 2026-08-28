import {
  collection,
  doc,
  increment,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";
import { getFirebaseDb, waitForFirebaseAuthReady } from "./firebase-client.js";

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

const EMPTY_BODY_PARTS = {
  Hip: 0,
  LeftKnee: 0,
  LeftShoulder: 0,
  Neck: 0,
  RightKnee: 0,
  RightShoulder: 0,
};

// 정답/오답 구분 없이 수집만 하므로 파일명·기록은 항상 "correct" 고정값을 씀.
const FIXED_POSTURE_TYPE = "correct";

function normalizePostureType(value) {
  return value === "incorrect" ? "incorrect" : "correct";
}

function getBodyPartCode(bodyPartKey) {
  return BODY_PART_CODE_MAP[bodyPartKey] || "00";
}

function getLocationMeta(locationKey) {
  return LOCATION_META[locationKey] || LOCATION_META.aim;
}

function createLocationSummary(meta) {
  return {
    Name: meta.name,
    DisplayName: meta.displayName,
    SiteCode: meta.siteCode,
    BodyParts: { ...EMPTY_BODY_PARTS },
    ConsentCount: 0,
    SessionCount: 0,
    UpdatedAt: serverTimestamp(),
  };
}

function normalizeBodyParts(value) {
  return {
    ...EMPTY_BODY_PARTS,
    ...(value && typeof value === "object" ? value : {}),
  };
}

// locations 문서는 보기 좋은 요약판 역할이라서 수집 성공 후 숫자만 같이 올립니다.
function formatMemberCode(value) {
  const parsedValue = Number(value || 0);

  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    return "00";
  }

  return String(parsedValue).padStart(2, "0");
}

function toFriendlyCollectionError(error, fallbackMessage) {
  const code = error?.code || "";

  if (code.includes("unauthenticated")) {
    return "인증 상태를 확인할 수 없습니다. 다시 로그인해 주세요.";
  }

  if (code.includes("permission-denied")) {
    return "수집 처리 권한이 없습니다. Firestore 규칙을 확인해 주세요.";
  }

  if (code.includes("deadline-exceeded") || code.includes("timeout")) {
    return "수집 요청 응답이 지연되고 있습니다. 잠시 뒤 다시 시도해 주세요.";
  }

  return error?.message || fallbackMessage;
}

// 같은 회원이 같은 지점에서 수집을 시작하면 참여 기록을 한 번만 만듭니다.
export async function ensureCollectorConsentAtLocation(session) {
  try {
    await waitForFirebaseAuthReady();

    const db = getFirebaseDb();
    const locationMeta = getLocationMeta(session?.location);
    const participantRef = doc(
      db,
      "locationParticipants",
      `${session?.userId || "unknown"}_${locationMeta.docId}_${FIXED_POSTURE_TYPE}`,
    );

    const result = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(participantRef);

      if (snapshot.exists()) {
        return {
          created: false,
          id: participantRef.id,
        };
      }

      const locationRef = doc(db, "locations", locationMeta.docId);
      transaction.set(participantRef, {
        UserId: session?.userId || "",
        UserNumber: Number(session?.userNumber || 0),
        MemberCode: session?.memberCode || formatMemberCode(session?.userNumber),
        Name: session?.name || "",
        BirthDate: Number(session?.birthDate || 0),
        Gender: session?.gender || "",
        Location: session?.location || "aim",
        LocationDocId: locationMeta.docId,
        SiteCode: locationMeta.siteCode,
        PostureType: FIXED_POSTURE_TYPE,
        PostureCode: "0",
        CreatedAt: serverTimestamp(),
        UpdatedAt: serverTimestamp(),
      });

      transaction.set(
        locationRef,
        {
          Name: locationMeta.name,
          DisplayName: locationMeta.displayName,
          SiteCode: locationMeta.siteCode,
          ConsentCount: increment(1),
          UpdatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      return {
        created: true,
        id: participantRef.id,
      };
    });

    return result;
  } catch (error) {
    throw new Error(
      toFriendlyCollectionError(error, "지점 참여 기록 처리 중 오류가 발생했습니다."),
    );
  }
}

// 실제 영상 1개를 collectionSessions에 저장하고 지점 보조 집계도 함께 올립니다.
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
  try {
    await waitForFirebaseAuthReady();

    const db = getFirebaseDb();
    const locationMeta = getLocationMeta(session?.location);
    const bodyPartOption =
      BODY_PART_OPTIONS.find((option) => option.key === bodyPartKey) || BODY_PART_OPTIONS[0];
    const bodyPartCode = getBodyPartCode(bodyPartKey);

    const sessionRef = doc(collection(db, "collectionSessions"));
    const locationRef = doc(db, "locations", locationMeta.docId);
    const sessionPayload = {
      UserId: session?.userId || "",
      UserNumber: Number(session?.userNumber || 0),
      MemberCode: session?.memberCode || formatMemberCode(session?.userNumber),
      Name: session?.name || "",
      BirthDate: Number(session?.birthDate || 0),
      Gender: session?.gender || "",
      Location: session?.location || "aim",
      LocationDocId: locationMeta.docId,
      SiteCode: locationMeta.siteCode,
      BodyPart: bodyPartKey,
      BodyPartCode: bodyPartCode,
      BodyPartLabel: bodyPartOption.label,
      PostureType: FIXED_POSTURE_TYPE,
      PostureCode: "0",
      FileName: fileName,
      MimeType: mimeType,
      FileSize: Number(size || 0),
      DurationMs: Number(durationMs || 0),
      SourceType: sourceType,
      DepthEnabled: Boolean(depth?.enabled),
      DepthFrameCount: Number(depth?.frameCount || 0),
      DepthRawFileName: depth?.rawFileName || "",
      DepthIndexFileName: depth?.indexFileName || "",
      DepthMetadataFileName: depth?.metadataFileName || "",
      DepthRawSize: Number(depth?.rawSize || 0),
      CreatedAt: serverTimestamp(),
    };

    await runTransaction(db, async (transaction) => {
      transaction.set(sessionRef, sessionPayload);
      transaction.update(locationRef, {
        SessionCount: increment(1),
        [`BodyParts.${bodyPartKey}`]: increment(1),
        UpdatedAt: serverTimestamp(),
      });
    });

    return {
      ok: true,
      sessionId: sessionRef.id,
    };
  } catch (error) {
    throw new Error(
      toFriendlyCollectionError(error, "녹화 기록 저장 중 오류가 발생했습니다."),
    );
  }
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
