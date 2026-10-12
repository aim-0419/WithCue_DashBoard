// locationParticipants · collectionSessions 문서에 복사돼 있던 Name / BirthDate / Gender 를 제거하는 백필.
// 서버 검증 구조로 바뀐 뒤에는 이 필드를 더 이상 쓰지 않으며, 대시보드 집계도 이 필드를 읽지 않는다.
//
// 기본은 dry-run(아무것도 바꾸지 않고 대상 문서 수만 출력). 실제 적용은 --apply.
//   node scripts/strip-pii-backfill.mjs            # 대상 개수만 확인
//   node scripts/strip-pii-backfill.mjs --apply    # 실제 삭제
//
// 자격증명: FIREBASE_SERVICE_ACCOUNT_JSON(서비스 계정 JSON 문자열) 또는
//           GOOGLE_APPLICATION_CREDENTIALS(키 파일 경로) 또는 에뮬레이터(FIRESTORE_EMULATOR_HOST).
import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const PII_FIELDS = ["Name", "BirthDate", "Gender"];
const TARGET_COLLECTIONS = ["locationParticipants", "collectionSessions"];
const BATCH_LIMIT = 400;

function initAdmin() {
  if (getApps().length) {
    return;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || "withcuedashboard";
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson);
    initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id || projectId });
    return;
  }

  if (process.env.FIRESTORE_EMULATOR_HOST) {
    initializeApp({ projectId });
    return;
  }

  initializeApp({ credential: applicationDefault(), projectId });
}

async function stripCollection(db, collectionName, apply) {
  const snapshot = await db.collection(collectionName).get();
  let targetCount = 0;
  let batch = db.batch();
  let batchSize = 0;

  for (const documentSnapshot of snapshot.docs) {
    const data = documentSnapshot.data();
    const presentFields = PII_FIELDS.filter((field) => field in data);

    if (presentFields.length === 0) {
      continue;
    }

    targetCount += 1;

    if (!apply) {
      continue;
    }

    const update = Object.fromEntries(presentFields.map((field) => [field, FieldValue.delete()]));
    update.UpdatedAt = FieldValue.serverTimestamp();
    batch.update(documentSnapshot.ref, update);
    batchSize += 1;

    if (batchSize >= BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      batchSize = 0;
    }
  }

  if (apply && batchSize > 0) {
    await batch.commit();
  }

  return { total: snapshot.size, targetCount };
}

async function main() {
  const apply = process.argv.includes("--apply");
  initAdmin();
  const db = getFirestore();

  console.log(apply ? "[apply] 개인정보 필드를 실제로 삭제합니다." : "[dry-run] 대상만 집계합니다. 적용하려면 --apply");

  for (const collectionName of TARGET_COLLECTIONS) {
    const { total, targetCount } = await stripCollection(db, collectionName, apply);
    console.log(`${collectionName}: 전체 ${total}건 중 개인정보 필드가 있는 문서 ${targetCount}건${apply ? " 처리 완료" : ""}`);
  }
}

main().catch((error) => {
  console.error("백필 실패:", error.message);
  process.exitCode = 1;
});
