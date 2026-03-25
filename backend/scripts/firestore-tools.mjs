import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
} from "firebase/firestore";
import { firebaseConfig } from "./firebase-config.mjs";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

function printUsage() {
  console.log(`Usage:
  node scripts/firestore-tools.mjs list
  node scripts/firestore-tools.mjs get <DocumentId>
  node scripts/firestore-tools.mjs merge <DocumentId> '<JSON>'

Examples:
  node scripts/firestore-tools.mjs list
  node scripts/firestore-tools.mjs get Company
  node scripts/firestore-tools.mjs merge Company '{\"ConsentCount\":7,\"SessionCount\":15,\"BodyParts\":{\"Hip\":9}}'
`);
}

async function listLocations() {
  const snapshot = await getDocs(collection(db, "locations"));
  if (snapshot.empty) {
    console.log("locations 컬렉션이 비어 있습니다.");
    return;
  }

  console.log("locations 문서 목록:");
  snapshot.docs.forEach((item) => {
    console.log(`- ${item.id}`);
  });
}

async function getLocation(documentId) {
  const snapshot = await getDoc(doc(db, "locations", documentId));

  if (!snapshot.exists()) {
    console.log(`문서가 없습니다: locations/${documentId}`);
    return;
  }

  console.log(JSON.stringify({ id: snapshot.id, ...snapshot.data() }, null, 2));
}

async function mergeLocation(documentId, jsonString) {
  let payload;

  try {
    payload = JSON.parse(jsonString);
  } catch (error) {
    console.error("JSON 형식이 올바르지 않습니다.");
    console.error(error.message);
    process.exit(1);
  }

  await setDoc(doc(db, "locations", documentId), payload, { merge: true });
  console.log(`업데이트 완료: locations/${documentId}`);
  await getLocation(documentId);
}

async function main() {
  const [command, documentId, jsonString] = process.argv.slice(2);

  if (!command) {
    printUsage();
    return;
  }

  if (command === "list") {
    await listLocations();
    return;
  }

  if (command === "get") {
    if (!documentId) {
      printUsage();
      process.exit(1);
    }
    await getLocation(documentId);
    return;
  }

  if (command === "merge") {
    if (!documentId || !jsonString) {
      printUsage();
      process.exit(1);
    }
    await mergeLocation(documentId, jsonString);
    return;
  }

  printUsage();
  process.exit(1);
}

main().catch((error) => {
  console.error("Firestore 작업 실패:");
  console.error(error.code || error.message || error);
  process.exit(1);
});
