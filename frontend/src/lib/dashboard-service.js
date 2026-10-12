import { BODY_PART_OPTIONS, LOCATION_META } from "./collection-service.js";
import { apiRequest } from "./firebase-client.js";

const LOCATION_ORDER = ["jangdeok", "hyocheon", "aim"];
const POSTURE_TYPES = ["all", "correct", "incorrect"];

function createEmptyBodyParts() {
  return BODY_PART_OPTIONS.reduce((accumulator, bodyPart) => {
    accumulator[bodyPart.key] = 0;
    return accumulator;
  }, {});
}

function createLocationBucket(locationKey) {
  const locationMeta = LOCATION_META[locationKey];

  return {
    id: locationMeta.docId,
    Name: locationMeta.name,
    DisplayName: locationMeta.displayName,
    ConsentCount: 0,
    ConsentUserIds: [],
    SessionCount: 0,
    BodyParts: createEmptyBodyParts(),
    Variants: POSTURE_TYPES.reduce((accumulator, postureType) => {
      accumulator[postureType] = {
        ConsentCount: 0,
        SessionCount: 0,
        BodyParts: createEmptyBodyParts(),
      };
      return accumulator;
    }, {}),
  };
}

function createEmptyDashboardData() {
  const locations = LOCATION_ORDER.map((locationKey) => createLocationBucket(locationKey));

  return {
    source: "firebase-empty",
    updatedAt: "",
    ConsentCount: 0,
    ConsentUserIds: [],
    SessionCount: 0,
    Categories: locations.map((location) => location.DisplayName),
    locations,
    recentAdjustments: [],
  };
}

function normalizePostureType(value) {
  return value === "incorrect" ? "incorrect" : "correct";
}

function incrementSession(locationBucket, postureType, bodyPartKey, amount) {
  locationBucket.SessionCount += amount;
  locationBucket.Variants.all.SessionCount += amount;
  locationBucket.Variants[postureType].SessionCount += amount;

  if (Object.prototype.hasOwnProperty.call(locationBucket.BodyParts, bodyPartKey)) {
    locationBucket.BodyParts[bodyPartKey] += amount;
    locationBucket.Variants.all.BodyParts[bodyPartKey] += amount;
    locationBucket.Variants[postureType].BodyParts[bodyPartKey] += amount;
  }
}

function sortAdjustmentDocs(adjustmentDocs) {
  return [...adjustmentDocs].sort((leftDoc, rightDoc) => {
    const leftDate = leftDoc.data().CreatedAt?.toMillis?.() || 0;
    const rightDate = rightDoc.data().CreatedAt?.toMillis?.() || 0;
    return rightDate - leftDate;
  });
}

function addConsentUserId(locationBucket, userId) {
  if (!userId) {
    return;
  }

  if (!locationBucket._consentUserIds) {
    locationBucket._consentUserIds = new Set();
  }

  locationBucket._consentUserIds.add(userId);
}

function aggregateDashboard(userDocs, participantDocs, sessionDocs, adjustmentDocs) {
  const locationMap = new Map(
    LOCATION_ORDER.map((locationKey) => [locationKey, createLocationBucket(locationKey)]),
  );
  const consentedUserIds = new Set();

  userDocs.forEach((snapshotDoc) => {
    const data = snapshotDoc.data();

    if (data.ConsentAgreed === true) {
      consentedUserIds.add(snapshotDoc.id);
    }
  });

  participantDocs.forEach((snapshotDoc) => {
    const data = snapshotDoc.data();
    const locationKey = data.Location;

    if (!locationMap.has(locationKey)) {
      return;
    }

    if (consentedUserIds.has(data.UserId)) {
      addConsentUserId(locationMap.get(locationKey), data.UserId);
    }
  });

  sessionDocs.forEach((snapshotDoc) => {
    const data = snapshotDoc.data();
    const locationKey = data.Location;
    const bodyPartKey = data.BodyPart;
    const postureType = normalizePostureType(data.PostureType);

    if (!locationMap.has(locationKey)) {
      return;
    }

    const locationBucket = locationMap.get(locationKey);
    incrementSession(locationBucket, postureType, bodyPartKey, 1);
  });

  adjustmentDocs.forEach((snapshotDoc) => {
    const data = snapshotDoc.data();
    const locationKey = data.Location;
    const bodyPartKey = data.BodyPart;
    const postureType = normalizePostureType(data.PostureType);
    const sessionDelta = Number(data.SessionDelta || 0);

    if (!locationMap.has(locationKey)) {
      return;
    }

    const locationBucket = locationMap.get(locationKey);
    incrementSession(locationBucket, postureType, bodyPartKey, sessionDelta);

    if (Number(data.ConsentDelta || 0) > 0 && data.TargetUserId) {
      consentedUserIds.add(data.TargetUserId);
      addConsentUserId(locationBucket, data.TargetUserId);
    }
  });

  const locations = LOCATION_ORDER.map((locationKey) => {
    const locationBucket = locationMap.get(locationKey);
    const consentUserIds = [...(locationBucket._consentUserIds || new Set())];
    const consentCount = consentUserIds.length;

    locationBucket.ConsentUserIds = consentUserIds;
    locationBucket.ConsentCount = consentCount;
    locationBucket.Variants.all.ConsentCount = consentCount;
    locationBucket.Variants.correct.ConsentCount = consentCount;
    locationBucket.Variants.incorrect.ConsentCount = consentCount;
    delete locationBucket._consentUserIds;

    return locationBucket;
  });

  const consentCount = consentedUserIds.size;
  const sessionCount = locations.reduce((total, location) => total + location.SessionCount, 0);
  const recentAdjustments = sortAdjustmentDocs(adjustmentDocs).slice(0, 5).map((snapshotDoc) => ({
    id: snapshotDoc.id,
    ...snapshotDoc.data(),
  }));

  return {
    source: sessionCount || consentCount ? "firebase" : "firebase-empty",
    updatedAt: new Date().toLocaleString("ko-KR"),
    ConsentCount: consentCount,
    ConsentUserIds: [...consentedUserIds],
    SessionCount: sessionCount,
    Categories: locations.map((location) => location.DisplayName),
    locations,
    recentAdjustments,
  };
}

function toMillisLike(value) {
  return Number.isFinite(value) ? { toMillis: () => value } : undefined;
}

// 서버 응답 객체를 Firestore 스냅샷 문서처럼({ id, data() }) 감싸 aggregateDashboard를 그대로 쓴다.
// adjustments의 CreatedAtMs/UpdatedAtMs는 CreatedAt/UpdatedAt.toMillis()로 다시 노출해 정렬을 유지한다.
function toSnapshotLikeDocs(items, { withTimestamps = false } = {}) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const { id, ...fields } = item || {};

    if (withTimestamps) {
      const createdAt = toMillisLike(fields.CreatedAtMs);
      const updatedAt = toMillisLike(fields.UpdatedAtMs);

      if (createdAt) {
        fields.CreatedAt = createdAt;
      }

      if (updatedAt) {
        fields.UpdatedAt = updatedAt;
      }
    }

    return {
      id: String(id || ""),
      data: () => fields,
    };
  });
}

export async function getDashboardData() {
  try {
    const result = await apiRequest("/api/admin/dashboard-data", { method: "GET" });

    if (!result.ok) {
      return {
        ...createEmptyDashboardData(),
        source: "firebase-error",
        errorMessage: result.message || "대시보드 데이터를 불러오지 못했습니다.",
        errorCode: result.code || "",
      };
    }

    const userDocs = toSnapshotLikeDocs(result.users);
    const participantDocs = toSnapshotLikeDocs(result.participants);
    const sessionDocs = toSnapshotLikeDocs(result.sessions);
    const adjustmentDocs = toSnapshotLikeDocs(result.adjustments, { withTimestamps: true });

    if (
      userDocs.length === 0 &&
      participantDocs.length === 0 &&
      sessionDocs.length === 0 &&
      adjustmentDocs.length === 0
    ) {
      return createEmptyDashboardData();
    }

    return aggregateDashboard(userDocs, participantDocs, sessionDocs, adjustmentDocs);
  } catch (error) {
    return {
      ...createEmptyDashboardData(),
      source: "firebase-error",
      errorMessage: error?.message || "",
      errorCode: error?.code || "",
    };
  }
}
