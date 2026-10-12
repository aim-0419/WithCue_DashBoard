import { Timestamp, getDb } from "../_lib/firebase-admin.js";
import { requireAdmin, sendJson, withHandler } from "../_lib/http.js";

// Timestamp는 JSON으로 못 보내므로 `<필드>Ms` 숫자로 바꾸고 원래 필드는 뺀다.
function serializeAdjustment(snapshot) {
  const serialized = { id: snapshot.id };

  Object.entries(snapshot.data() || {}).forEach(([key, value]) => {
    if (value instanceof Timestamp || typeof value?.toMillis === "function") {
      serialized[`${key}Ms`] = value.toMillis();
      return;
    }

    serialized[key] = value;
  });

  return serialized;
}

// 대시보드 집계에 필요한 필드만 읽는다(개인정보 필드는 select로 아예 가져오지 않음).
// 데이터가 커지면 이 함수만 집계 캐시 읽기로 바꾸면 된다.
export async function loadDashboardData(db = getDb()) {
  const [usersSnapshot, participantsSnapshot, sessionsSnapshot, adjustmentsSnapshot] =
    await Promise.all([
      db.collection("users").select("ConsentAgreed").get(),
      db.collection("locationParticipants").select("UserId", "Location").get(),
      db.collection("collectionSessions").select("Location", "BodyPart", "PostureType").get(),
      db.collection("legacyAdjustments").get(),
    ]);

  return {
    users: usersSnapshot.docs.map((snapshot) => ({
      id: snapshot.id,
      ConsentAgreed: snapshot.get("ConsentAgreed") === true,
    })),
    participants: participantsSnapshot.docs.map((snapshot) => ({
      id: snapshot.id,
      UserId: snapshot.get("UserId") ?? null,
      Location: snapshot.get("Location") ?? null,
    })),
    sessions: sessionsSnapshot.docs.map((snapshot) => ({
      id: snapshot.id,
      Location: snapshot.get("Location") ?? null,
      BodyPart: snapshot.get("BodyPart") ?? null,
      PostureType: snapshot.get("PostureType") ?? null,
    })),
    adjustments: adjustmentsSnapshot.docs.map(serializeAdjustment),
  };
}

// GET /api/admin/dashboard-data — 관리자 대시보드 원자료.
async function dashboardDataHandler(req, res) {
  await requireAdmin(req);
  const data = await loadDashboardData();
  sendJson(res, 200, { ok: true, ...data });
}

export default withHandler(dashboardDataHandler, { methods: ["GET"] });
