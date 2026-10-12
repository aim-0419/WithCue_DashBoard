import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";

// Admin SDK 초기화는 함수 인스턴스마다 한 번만 한다. 자격증명이 없을 때는 import 시점이 아니라
// 실제 호출 시점에 에러를 던져서, 핸들러 래퍼가 500 JSON으로 정리할 수 있게 한다.
const DEFAULT_PROJECT_ID = "withcuedashboard";

let cachedApp = null;
let cachedDb = null;
let cachedAuth = null;

function parseServiceAccount(rawValue) {
  let serviceAccount;

  try {
    serviceAccount = JSON.parse(rawValue);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON 값이 올바른 JSON이 아닙니다.");
  }

  // 환경변수에 넣으면서 개행이 \\n 문자열로 남는 경우를 복구한다.
  if (typeof serviceAccount.private_key === "string") {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  return serviceAccount;
}

function assertNoEmulatorInProduction() {
  // 운영 배포에 에뮬레이터 주소가 섞이면 서명 없는 토큰을 받아들이게 되므로 막는다.
  const usesEmulator =
    Boolean(process.env.FIRESTORE_EMULATOR_HOST) || Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);

  if (usesEmulator && process.env.VERCEL_ENV === "production") {
    throw new Error("운영 환경에서는 Firebase 에뮬레이터 환경변수를 사용할 수 없습니다.");
  }
}

export function getFirebaseAdminApp() {
  if (cachedApp) {
    return cachedApp;
  }

  const existingApps = getApps();

  if (existingApps.length > 0) {
    cachedApp = existingApps[0];
    return cachedApp;
  }

  assertNoEmulatorInProduction();

  const rawServiceAccount = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();

  if (rawServiceAccount) {
    const serviceAccount = parseServiceAccount(rawServiceAccount);
    const projectId =
      process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id || DEFAULT_PROJECT_ID;

    cachedApp = initializeApp({
      credential: cert(serviceAccount),
      projectId,
    });
    return cachedApp;
  }

  if (process.env.FIRESTORE_EMULATOR_HOST) {
    if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
      console.warn(
        "[firebase-admin] FIREBASE_AUTH_EMULATOR_HOST가 없어 Auth 호출이 실제 프로젝트로 나갈 수 있습니다.",
      );
    }

    cachedApp = initializeApp({
      projectId: process.env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID,
    });
    return cachedApp;
  }

  throw new Error(
    "Firebase Admin 자격증명이 없습니다. FIREBASE_SERVICE_ACCOUNT_JSON을 설정하거나, 로컬에서는 FIRESTORE_EMULATOR_HOST로 에뮬레이터를 지정하세요.",
  );
}

export function getDb() {
  if (!cachedDb) {
    cachedDb = getFirestore(getFirebaseAdminApp());
    // undefined 값이 섞여도 쓰기가 실패하지 않도록 한다(선택 필드 생략용).
    cachedDb.settings({ ignoreUndefinedProperties: true });
  }

  return cachedDb;
}

export function getAdminAuth() {
  if (!cachedAuth) {
    cachedAuth = getAuth(getFirebaseAdminApp());
  }

  return cachedAuth;
}

export { FieldValue, Timestamp };
