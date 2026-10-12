import { FieldValue, Timestamp, getAdminAuth, getDb } from "./firebase-admin.js";
import { HttpError } from "./http.js";

// 지점 메타는 frontend/src/lib/collection-service.js의 LOCATION_META와 값이 같아야 한다.
export const LOCATION_META = {
  aim: {
    docId: "Company",
    name: "회사",
    displayName: "AIM",
    siteCode: "A",
  },
  hyocheon: {
    docId: "HyoCheon",
    name: "필라테스 이끌림 효천점",
    displayName: "이끌림(효천점)",
    siteCode: "H",
  },
  jangdeok: {
    docId: "Jangdeok",
    name: "필라테스 이끌림 장덕점",
    displayName: "이끌림(장덕점)",
    siteCode: "J",
  },
};

// 촬영 부위 라벨·코드는 프론트 BODY_PART_OPTIONS·BODY_PART_CODE_MAP과 같다.
export const BODY_PART_META = {
  Neck: { key: "Neck", label: "목", code: "01" },
  Hip: { key: "Hip", label: "허리", code: "02" },
  LeftShoulder: { key: "LeftShoulder", label: "왼쪽 어깨", code: "03" },
  RightShoulder: { key: "RightShoulder", label: "오른쪽 어깨", code: "04" },
  LeftKnee: { key: "LeftKnee", label: "왼쪽 무릎", code: "05" },
  RightKnee: { key: "RightKnee", label: "오른쪽 무릎", code: "06" },
};

const EMPTY_BODY_PARTS = {
  Hip: 0,
  LeftKnee: 0,
  LeftShoulder: 0,
  Neck: 0,
  RightKnee: 0,
  RightShoulder: 0,
};

// 정답/오답 구분 없이 수집하므로 참여·세션 기록은 항상 "correct" 고정값을 쓴다.
const FIXED_POSTURE_TYPE = "correct";
const FIXED_POSTURE_CODE = "0";
const NAME_MAX_LENGTH = 50;
const USERS_COLLECTION = "users";
const PARTICIPANTS_COLLECTION = "locationParticipants";
const SESSIONS_COLLECTION = "collectionSessions";
const LOCATIONS_COLLECTION = "locations";

export const COLLECTOR_ROLES = ["collector"];
export const LINKED_ADMIN_ROLES = ["admin", "collector"];

function hasOwn(target, key) {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(target, key);
}

// ---------- 입력 정규화 ----------

export function normalizeName(value) {
  return String(value ?? "").trim().normalize("NFC");
}

export function parseName(value) {
  const name = normalizeName(value);

  if (!name || name.length > NAME_MAX_LENGTH) {
    throw new HttpError(400, "invalid_name", "이름을 올바르게 입력해 주세요.");
  }

  return name;
}

export function parseBirthDate(value) {
  const digits = String(value ?? "").replace(/\D/g, "");

  if (digits.length !== 8) {
    throw new HttpError(400, "invalid_birth_date", "생년월일 형식이 올바르지 않습니다.");
  }

  const parsed = Number(digits);

  if (!Number.isInteger(parsed) || parsed < 19000101 || parsed > 20991231) {
    throw new HttpError(400, "invalid_birth_date", "생년월일 값이 올바르지 않습니다.");
  }

  return parsed;
}

export function parseGender(value) {
  if (value !== "male" && value !== "female") {
    throw new HttpError(400, "invalid_gender", "성별 값이 올바르지 않습니다.");
  }

  return value;
}

// 지점이 비어 있으면 프론트와 같이 aim으로 본다. 값이 있는데 모르는 키면 400.
export function parseLocationKey(value) {
  if (value === undefined || value === null || value === "") {
    return "aim";
  }

  if (!hasOwn(LOCATION_META, value)) {
    throw new HttpError(400, "invalid_location", "지점 값이 올바르지 않습니다.");
  }

  return value;
}

export function parseBodyPartKey(value) {
  if (!hasOwn(BODY_PART_META, value)) {
    throw new HttpError(400, "invalid_body_part", "촬영 부위 값이 올바르지 않습니다.");
  }

  return value;
}

export function formatMemberCode(userNumber) {
  const parsedUserNumber = Number(userNumber || 0);

  if (!Number.isInteger(parsedUserNumber) || parsedUserNumber < 0) {
    return "00";
  }

  return String(parsedUserNumber).padStart(2, "0");
}

// ---------- 사용자 조회·세션 ----------

function getCreatedAtMillis(snapshot) {
  const createdAt = snapshot.get("CreatedAt");
  return typeof createdAt?.toMillis === "function" ? createdAt.toMillis() : 0;
}

function buildProfileQuery(birthDate, gender) {
  return getDb()
    .collection(USERS_COLLECTION)
    .where("BirthDate", "==", birthDate)
    .where("Gender", "==", gender);
}

function pickProfileMatch(docs, name) {
  const normalizedName = normalizeName(name);
  const matches = docs.filter((snapshot) => {
    const data = snapshot.data() || {};
    return normalizeName(data.Name) === normalizedName || data.NameNormalized === normalizedName;
  });

  // 같은 정보로 여러 문서가 있으면 가장 먼저 만든 문서를 쓴다(CreatedAt 오름차순, 같으면 문서 ID 순).
  matches.sort((left, right) => {
    const diff = getCreatedAtMillis(left) - getCreatedAtMillis(right);
    return diff !== 0 ? diff : left.id.localeCompare(right.id);
  });

  return matches[0] || null;
}

// 이름·생년월일·성별이 모두 맞는 users 문서 하나(없으면 null). 트랜잭션 안에서도 쓸 수 있다.
export async function findUserByProfile({ name, birthDate, gender }, { transaction } = {}) {
  const profileQuery = buildProfileQuery(birthDate, gender);
  const snapshot = transaction ? await transaction.get(profileQuery) : await profileQuery.get();
  return pickProfileMatch(snapshot.docs, name);
}

export function getUserRoles(userData) {
  if (Array.isArray(userData?.Roles) && userData.Roles.length > 0) {
    return userData.Roles.filter((role) => role === "collector" || role === "admin");
  }

  if (userData?.Role === "admin") {
    return ["admin"];
  }

  return ["collector"];
}

// 세션 프로필은 본인 정보만 담는다. 관리자 권한은 users 문서 값으로 주지 않고 roles를 직접 넘겨받는다.
export function buildSession({
  userId,
  userData,
  location = "",
  userNumber,
  memberCode,
  role = "collector",
  roles = COLLECTOR_ROLES,
}) {
  const resolvedUserNumber = Number(userNumber ?? userData?.UserNumber ?? 0) || 0;

  return {
    userId,
    name: userData?.Name || "",
    birthDate: Number(userData?.BirthDate || 0),
    gender: userData?.Gender || "",
    role,
    roles: [...roles],
    location,
    userNumber: resolvedUserNumber,
    memberCode: memberCode || userData?.MemberCode || formatMemberCode(resolvedUserNumber),
  };
}

// ---------- 회원번호 ----------

export async function ensureUserNumber(userRef) {
  const db = getDb();
  const counterRef = db.collection("systemCounters").doc("users");

  // 번호가 이미 있으면 트랜잭션 없이 바로 돌려준다. 같은 사용자의 동시 요청이 서로를 기다리지 않게 하기 위함.
  const existingSnapshot = await userRef.get();

  if (!existingSnapshot.exists) {
    throw new HttpError(403, "user_missing", "회원 정보를 찾을 수 없습니다. 다시 로그인해 주세요.");
  }

  const existingData = existingSnapshot.data() || {};
  const knownUserNumber = Number(existingData.UserNumber || 0);

  if (Number.isInteger(knownUserNumber) && knownUserNumber > 0) {
    return {
      userNumber: knownUserNumber,
      memberCode: existingData.MemberCode || formatMemberCode(knownUserNumber),
    };
  }

  return db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);

    if (!userSnapshot.exists) {
      throw new HttpError(403, "user_missing", "회원 정보를 찾을 수 없습니다. 다시 로그인해 주세요.");
    }

    const userData = userSnapshot.data() || {};
    const existingUserNumber = Number(userData.UserNumber || 0);

    if (Number.isInteger(existingUserNumber) && existingUserNumber > 0) {
      return {
        userNumber: existingUserNumber,
        memberCode: userData.MemberCode || formatMemberCode(existingUserNumber),
      };
    }

    const counterSnapshot = await transaction.get(counterRef);
    const nextUserNumber = Number(counterSnapshot.data()?.NextUserNumber || 1);
    const assignedUserNumber =
      Number.isInteger(nextUserNumber) && nextUserNumber > 0 ? nextUserNumber : 1;
    const memberCode = formatMemberCode(assignedUserNumber);

    transaction.set(
      counterRef,
      {
        NextUserNumber: assignedUserNumber + 1,
        UpdatedAt: Timestamp.now(),
      },
      { merge: true },
    );

    transaction.set(
      userRef,
      {
        UserNumber: assignedUserNumber,
        MemberCode: memberCode,
        UpdatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      userNumber: assignedUserNumber,
      memberCode,
    };
  });
}

// ---------- Auth 계정 (수집자) ----------

export function claimsEqual(left, right) {
  const leftKeys = Object.keys(left || {}).sort();
  const rightKeys = Object.keys(right || {}).sort();

  if (leftKeys.join(" ") !== rightKeys.join(" ")) {
    return false;
  }

  return leftKeys.every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

export function buildCollectorClaims(userDocId) {
  return {
    role: "collector",
    roles: [...COLLECTOR_ROLES],
    userDocId,
  };
}

// users 문서마다 Auth 사용자 1개. 기존 AuthUid가 살아 있고 그 claims.userDocId가 이 문서면 재사용,
// 아니면(없음·삭제됨·익명 시절 값·다른 문서 소유) 새로 만들어 AuthUid를 덮어쓴다.
export async function ensureAuthIdentity(userRef, userData) {
  const auth = getAdminAuth();
  const claims = buildCollectorClaims(userRef.id);
  let authUid = "";

  if (userData?.AuthUid) {
    try {
      const existingUser = await auth.getUser(userData.AuthUid);

      if (existingUser.customClaims?.userDocId === userRef.id) {
        authUid = existingUser.uid;

        // claims가 이미 같으면 Auth 쓰기를 건너뛴다(로그인마다 불필요한 쓰기 방지).
        if (claimsEqual(existingUser.customClaims, claims)) {
          return authUid;
        }
      }
    } catch (error) {
      if (error?.code !== "auth/user-not-found") {
        throw error;
      }
    }
  }

  if (!authUid) {
    const displayName = normalizeName(userData?.Name);
    const createdUser = await auth.createUser(displayName ? { displayName } : {});
    authUid = createdUser.uid;

    await userRef.set(
      {
        AuthUid: authUid,
        UpdatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  await auth.setCustomUserClaims(authUid, claims);
  return authUid;
}

// ---------- 지점·참여·세션 ----------

function getLocationRef(locationMeta) {
  return getDb().collection(LOCATIONS_COLLECTION).doc(locationMeta.docId);
}

function getParticipantRef(userDocId, locationMeta) {
  return getDb()
    .collection(PARTICIPANTS_COLLECTION)
    .doc(`${userDocId}_${locationMeta.docId}_${FIXED_POSTURE_TYPE}`);
}

// locations 요약 문서를 트랜잭션 안에서 merge로 갱신한다. 문서가 없으면 0 값으로 초기화하면서 증가분을 반영한다.
export function ensureLocationDocument(
  transaction,
  { locationMeta, locationSnapshot, consentDelta = 0, sessionBodyPartKey = "" },
) {
  const update = {
    Name: locationMeta.name,
    DisplayName: locationMeta.displayName,
    SiteCode: locationMeta.siteCode,
    UpdatedAt: FieldValue.serverTimestamp(),
  };

  if (!locationSnapshot?.exists) {
    update.ConsentCount = 0;
    update.SessionCount = 0;
    update.BodyParts = { ...EMPTY_BODY_PARTS };
  }

  if (consentDelta > 0) {
    update.ConsentCount = FieldValue.increment(consentDelta);
  }

  if (sessionBodyPartKey) {
    // set(merge)에서는 "BodyParts.Neck" 같은 점 경로가 필드 이름이 되므로 중첩 객체로 증가시킨다.
    update.SessionCount = FieldValue.increment(1);
    update.BodyParts = {
      ...(update.BodyParts || {}),
      [sessionBodyPartKey]: FieldValue.increment(1),
    };
  }

  transaction.set(getLocationRef(locationMeta), update, { merge: true });
}

function buildParticipantPayload({ userDocId, userNumber, memberCode, locationKey, locationMeta }) {
  // 개인정보(Name·BirthDate·Gender)는 참여 문서에 쓰지 않는다.
  return {
    UserId: userDocId,
    UserNumber: Number(userNumber || 0),
    MemberCode: memberCode || formatMemberCode(userNumber),
    Location: locationKey,
    LocationDocId: locationMeta.docId,
    SiteCode: locationMeta.siteCode,
    PostureType: FIXED_POSTURE_TYPE,
    PostureCode: FIXED_POSTURE_CODE,
    CreatedAt: FieldValue.serverTimestamp(),
    UpdatedAt: FieldValue.serverTimestamp(),
  };
}

// 같은 회원·같은 지점의 참여 기록은 한 번만 만든다.
export async function ensureParticipantDocument({ userDocId, userNumber, memberCode, locationKey }) {
  const db = getDb();
  const locationMeta = LOCATION_META[locationKey];
  const participantRef = getParticipantRef(userDocId, locationMeta);
  const locationRef = getLocationRef(locationMeta);

  // 이미 참여 기록이 있으면(대부분의 호출) 트랜잭션을 열지 않는다.
  const existingParticipant = await participantRef.get();

  if (existingParticipant.exists) {
    return { created: false, id: participantRef.id };
  }

  return db.runTransaction(async (transaction) => {
    const participantSnapshot = await transaction.get(participantRef);

    if (participantSnapshot.exists) {
      return { created: false, id: participantRef.id };
    }

    const locationSnapshot = await transaction.get(locationRef);

    transaction.set(
      participantRef,
      buildParticipantPayload({ userDocId, userNumber, memberCode, locationKey, locationMeta }),
    );
    ensureLocationDocument(transaction, { locationMeta, locationSnapshot, consentDelta: 1 });

    return { created: true, id: participantRef.id };
  });
}

// 녹화 1건을 collectionSessions에 저장하고, 참여 기록이 없으면 같은 트랜잭션에서 먼저 만든다.
export async function recordCollectionSession({
  userDocId,
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
}) {
  const db = getDb();
  const locationMeta = LOCATION_META[locationKey];
  const bodyPart = BODY_PART_META[bodyPartKey];
  const participantRef = getParticipantRef(userDocId, locationMeta);
  const locationRef = getLocationRef(locationMeta);
  const sessionRef = db.collection(SESSIONS_COLLECTION).doc();

  await db.runTransaction(async (transaction) => {
    const participantSnapshot = await transaction.get(participantRef);
    const locationSnapshot = await transaction.get(locationRef);
    const participantCreated = !participantSnapshot.exists;

    if (participantCreated) {
      transaction.set(
        participantRef,
        buildParticipantPayload({ userDocId, userNumber, memberCode, locationKey, locationMeta }),
      );
    }

    // 개인정보(Name·BirthDate·Gender)는 세션 문서에 쓰지 않는다. 나머지 필드명은 기존 프론트와 같다.
    transaction.set(sessionRef, {
      UserId: userDocId,
      UserNumber: Number(userNumber || 0),
      MemberCode: memberCode || formatMemberCode(userNumber),
      Location: locationKey,
      LocationDocId: locationMeta.docId,
      SiteCode: locationMeta.siteCode,
      BodyPart: bodyPart.key,
      BodyPartCode: bodyPart.code,
      BodyPartLabel: bodyPart.label,
      PostureType: FIXED_POSTURE_TYPE,
      PostureCode: FIXED_POSTURE_CODE,
      FileName: fileName,
      MimeType: mimeType,
      FileSize: fileSize,
      DurationMs: durationMs,
      SourceType: sourceType,
      DepthEnabled: Boolean(depth?.enabled),
      DepthFrameCount: depth?.frameCount || 0,
      DepthRawFileName: depth?.rawFileName || "",
      DepthIndexFileName: depth?.indexFileName || "",
      DepthMetadataFileName: depth?.metadataFileName || "",
      DepthRawSize: depth?.rawSize || 0,
      CreatedAt: FieldValue.serverTimestamp(),
    });

    ensureLocationDocument(transaction, {
      locationMeta,
      locationSnapshot,
      consentDelta: participantCreated ? 1 : 0,
      sessionBodyPartKey: bodyPart.key,
    });
  });

  return { sessionId: sessionRef.id };
}

// ---------- 관리자 연결 ----------

export async function findLinkedAdminUser(email) {
  const snapshot = await getDb()
    .collection(USERS_COLLECTION)
    .where("AdminEmail", "==", email)
    .limit(1)
    .get();

  return snapshot.empty ? null : snapshot.docs[0];
}

// 관리자 이메일은 users 문서 하나에만 연결한다. 다른 문서에 걸려 있던 연결은 해제하고 새 문서로 옮긴다.
export async function linkAdminEmailToUser(userRef, email) {
  const db = getDb();
  const linkedQuery = db.collection(USERS_COLLECTION).where("AdminEmail", "==", email);

  await db.runTransaction(async (transaction) => {
    const linkedSnapshot = await transaction.get(linkedQuery);

    linkedSnapshot.docs
      .filter((snapshot) => snapshot.id !== userRef.id)
      .forEach((snapshot) => {
        transaction.update(snapshot.ref, {
          AdminEmail: FieldValue.delete(),
          UpdatedAt: FieldValue.serverTimestamp(),
        });
      });

    transaction.set(
      userRef,
      {
        AdminEmail: email,
        UpdatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
}

// 허용 목록에서 빠진 관리자의 users 연결(AdminEmail)을 끊는다.
export async function unlinkAdminEmail(email) {
  const snapshot = await getDb().collection(USERS_COLLECTION).where("AdminEmail", "==", email).get();
  const batch = getDb().batch();

  snapshot.docs.forEach((doc) => {
    batch.update(doc.ref, { AdminEmail: FieldValue.delete(), UpdatedAt: FieldValue.serverTimestamp() });
  });

  if (!snapshot.empty) {
    await batch.commit();
  }
}

export function getUsersCollection() {
  return getDb().collection(USERS_COLLECTION);
}
