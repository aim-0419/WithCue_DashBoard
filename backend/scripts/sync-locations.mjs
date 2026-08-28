import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initializeApp } from "firebase/app";
import { doc, getFirestore, serverTimestamp, setDoc } from "firebase/firestore";

import { firebaseConfig } from "./firebase-config.mjs";

// 로컬 촬영 결과를 어느 Firestore 문서에 반영할지 매핑해 둔다.
// 지점은 이제 AIM(Company) 하나뿐 — HyoCheon/Jangdeok은 과거 기록이라 이 스크립트로는 더 이상 갱신하지 않는다.
const SAVE_ROOT = path.join(os.homedir(), "Desktop", "Data_Auto");
const DATASET_ROOT = path.join(SAVE_ROOT, "dataset");
const PARTICIPANTS_CSV = path.join(SAVE_ROOT, "participants.csv");

const LOCATION_CONFIG = {
  Company: {
    siteCode: "A",
    name: "회사",
    displayName: "AIM",
  },
};

const BODY_PART_FOLDERS = {
  Neck: "Neck",
  Hip: "Hip",
  LeftShoulder: "L_Shoulder",
  RightShoulder: "R_Shoulder",
  LeftKnee: "L_Knee",
  RightKnee: "R_Knee",
};

function readCsvRows(filePath) {
  // participants.csv를 최소한의 파서로 읽어 집계 계산에 쓸 행 배열로 바꾼다.
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length <= 1) {
    return [];
  }

  const [headerLine, ...rowLines] = lines;
  const headers = headerLine.split(",");

  return rowLines.map((line) => {
    const values = line.split(",");
    return headers.reduce((accumulator, header, index) => {
      accumulator[header] = values[index] ?? "";
      return accumulator;
    }, {});
  });
}

function countVideoFiles(bodyPartDir) {
  // dataset/{부위}/{참여자ID}/{회차}/color.mp4 구조를 순회하며 회차(rep) 개수를 센다.
  if (!fs.existsSync(bodyPartDir)) {
    return 0;
  }

  let count = 0;
  for (const participantEntry of fs.readdirSync(bodyPartDir, { withFileTypes: true })) {
    if (!participantEntry.isDirectory()) {
      continue;
    }

    const participantDir = path.join(bodyPartDir, participantEntry.name);
    for (const takeEntry of fs.readdirSync(participantDir, { withFileTypes: true })) {
      if (takeEntry.isDirectory() && fs.existsSync(path.join(participantDir, takeEntry.name, "color.mp4"))) {
        count += 1;
      }
    }
  }

  return count;
}

function buildLocationPayload(documentId, participantRows) {
  // CSV 동의 수와 부위별 로컬 파일 수를 Firestore locations 문서 형태로 합친다.
  const config = LOCATION_CONFIG[documentId];
  const bodyParts = Object.entries(BODY_PART_FOLDERS).reduce((accumulator, [fieldKey, folderName]) => {
    accumulator[fieldKey] = countVideoFiles(path.join(DATASET_ROOT, folderName));
    return accumulator;
  }, {});

  const consentCount = participantRows.filter((row) => row.site_code === config.siteCode && row.consent === "agree").length;
  const sessionCount = Object.values(bodyParts).reduce((total, value) => total + value, 0);

  return {
    SiteCode: config.siteCode,
    Name: config.name,
    DisplayName: config.displayName,
    ConsentCount: consentCount,
    SessionCount: sessionCount,
    BodyParts: bodyParts,
    UpdatedAt: serverTimestamp(),
  };
}

async function main() {
  // 모든 지점 문서를 순회하며 최신 집계를 merge 방식으로 반영한다.
  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);
  const participantRows = readCsvRows(PARTICIPANTS_CSV);

  for (const documentId of Object.keys(LOCATION_CONFIG)) {
    const payload = buildLocationPayload(documentId, participantRows);
    await setDoc(doc(db, "locations", documentId), payload, { merge: true });
  }

  console.log("locations sync completed");
}

main().catch((error) => {
  console.error("locations sync failed");
  console.error(error.code || error.message || error);
  process.exit(1);
});
