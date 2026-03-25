import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initializeApp } from "firebase/app";
import { doc, getFirestore, serverTimestamp, setDoc } from "firebase/firestore";

import { firebaseConfig } from "./firebase-config.mjs";

const SAVE_ROOT = path.join(os.homedir(), "Desktop", "Data_Auto");
const PARTICIPANTS_CSV = path.join(SAVE_ROOT, "participants.csv");

const LOCATION_CONFIG = {
  Company: {
    siteCode: "A",
    name: "회사",
    displayName: "AIM",
  },
  HyoCheon: {
    siteCode: "H",
    name: "효천점",
    displayName: "이끌림(효천)",
  },
  Jangdeok: {
    siteCode: "J",
    name: "장덕점",
    displayName: "이끌림(장덕)",
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

function countVideoFiles(directoryPath, siteCode) {
  if (!fs.existsSync(directoryPath)) {
    return 0;
  }

  return fs
    .readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => entry.name.toLowerCase().endsWith(".mp4"))
    .filter((entry) => entry.name.startsWith(`${siteCode}_`)).length;
}

function buildLocationPayload(documentId, participantRows) {
  const config = LOCATION_CONFIG[documentId];
  const bodyParts = Object.entries(BODY_PART_FOLDERS).reduce((accumulator, [fieldKey, folderName]) => {
    const folderPath = path.join(SAVE_ROOT, folderName);
    accumulator[fieldKey] = countVideoFiles(folderPath, config.siteCode);
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
