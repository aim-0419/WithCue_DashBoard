// Firestore 보안 규칙 테스트.
// 실행: npm run test:rules  (firebase-tools 에뮬레이터가 firestore.rules 를 읽어 띄우고 이 파일을 돌림)
// 전제: Java 11+ 설치. FIRESTORE_EMULATOR_HOST 가 있으면 그 주소를 쓰고 없으면 127.0.0.1:8080.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  assertFails,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";

const PROJECT_ID = "demo-withcue-rules";
const [EMULATOR_HOST, EMULATOR_PORT] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");

const ADMIN_UID = "admin-uid";
const COLLECTOR_UID = "collector-uid";
const COLLECTOR_DOC_ID = "user-doc-1";

const adminClaims = { role: "admin", roles: ["admin"], email: "admin@example.com" };
const collectorClaims = { role: "collector", roles: ["collector"], userDocId: COLLECTOR_DOC_ID };
// 예전 클라이언트가 쓰던 익명 로그인: claim 이 전혀 없음.
const anonymousClaims = { firebase: { sign_in_provider: "anonymous" } };
// 서버 허용 목록 판정에 쓰는 조건(Google 로그인·이메일 인증·role=admin)을 모두 갖춘 토큰.
const verifiedAdminClaims = {
  role: "admin",
  roles: ["admin", "collector"],
  userDocId: COLLECTOR_DOC_ID,
  email: "admin@example.com",
  email_verified: true,
  firebase: { sign_in_provider: "google.com" },
};

const ALL_KINDS = ["unauth", "anonymous", "collector", "admin", "verifiedAdmin"];

const PROTECTED_COLLECTIONS = [
  "users",
  "locationParticipants",
  "collectionSessions",
  "systemCounters",
  "locations",
  "rateLimits",
];

function validAdjustment(createdByUserId) {
  return {
    Location: "aim",
    LocationDocId: "Company",
    SiteCode: "A",
    BodyPart: "Neck",
    BodyPartCode: "01",
    BodyPartLabel: "목",
    PostureType: "correct",
    PostureCode: "0",
    PostureLabel: "정답",
    SessionDelta: 2,
    ConsentDelta: 0,
    Note: "",
    TargetUserId: COLLECTOR_DOC_ID,
    TargetUserName: "홍길동",
    TargetUserNumber: 1,
    TargetMemberCode: "01",
    CreatedByName: "관리자",
    CreatedByUserId: createdByUserId,
    CreatedAt: serverTimestamp(),
    UpdatedAt: serverTimestamp(),
  };
}

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"),
      host: EMULATOR_HOST,
      port: Number(EMULATOR_PORT),
    },
  });
});

after(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  // 규칙을 끄고 시드 데이터를 넣음.
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "users", COLLECTOR_DOC_ID), {
      Name: "홍길동",
      BirthDate: 19900101,
      Gender: "male",
      Roles: ["collector"],
      UserNumber: 1,
    });
    await setDoc(doc(db, "users", "user-doc-2"), { Name: "김철수", BirthDate: 19850505, Gender: "male" });
    await setDoc(doc(db, "locationParticipants", `${COLLECTOR_DOC_ID}_Company_correct`), {
      UserId: COLLECTOR_DOC_ID,
      Location: "aim",
    });
    await setDoc(doc(db, "collectionSessions", "session-1"), { UserId: COLLECTOR_DOC_ID, Location: "aim", BodyPart: "Neck" });
    await setDoc(doc(db, "systemCounters", "users"), { NextUserNumber: 3 });
    await setDoc(doc(db, "locations", "Company"), { SessionCount: 1, ConsentCount: 1 });
    await setDoc(doc(db, "rateLimits", "abc"), { count: 1 });
    await setDoc(doc(db, "legacyAdjustments", "adj-1"), validAdjustment(ADMIN_UID));
  });
});

function dbFor(kind) {
  if (kind === "unauth") return testEnv.unauthenticatedContext().firestore();
  if (kind === "anonymous") return testEnv.authenticatedContext("anon-uid", anonymousClaims).firestore();
  if (kind === "collector") return testEnv.authenticatedContext(COLLECTOR_UID, collectorClaims).firestore();
  if (kind === "admin") return testEnv.authenticatedContext(ADMIN_UID, adminClaims).firestore();
  if (kind === "verifiedAdmin") return testEnv.authenticatedContext(ADMIN_UID, verifiedAdminClaims).firestore();
  throw new Error(`unknown kind ${kind}`);
}

describe("개인정보·서버 전용 컬렉션은 누구도 클라이언트에서 접근할 수 없다", () => {
  for (const kind of ALL_KINDS) {
    for (const name of PROTECTED_COLLECTIONS) {
      it(`${kind}: ${name} 목록 조회 거부`, async () => {
        await assertFails(getDocs(collection(dbFor(kind), name)));
      });

      it(`${kind}: ${name} 문서 쓰기 거부`, async () => {
        await assertFails(setDoc(doc(dbFor(kind), name, "any-doc"), { x: 1 }));
      });
    }
  }

  it("collector: 본인 users 문서도 직접 읽을 수 없다(서버 API 로만 받음)", async () => {
    await assertFails(getDoc(doc(dbFor("collector"), "users", COLLECTOR_DOC_ID)));
  });

  it("collector: 본인 users 문서의 Roles 를 admin 으로 바꿀 수 없다", async () => {
    await assertFails(
      updateDoc(doc(dbFor("collector"), "users", COLLECTOR_DOC_ID), { Roles: ["collector", "admin"] }),
    );
  });

  it("anonymous: 참여·세션 문서를 만들 수 없다(옛 클라이언트 경로 차단)", async () => {
    await assertFails(
      setDoc(doc(dbFor("anonymous"), "locationParticipants", "x_Company_correct"), {
        UserId: "x",
        Location: "aim",
      }),
    );
    await assertFails(setDoc(doc(dbFor("anonymous"), "collectionSessions", "s"), { UserId: "x" }));
  });
});

describe("legacyAdjustments 도 클라이언트 접근은 전부 거부(추가·삭제는 /api/admin/adjustments 로만)", () => {
  for (const kind of ALL_KINDS) {
    it(`${kind}: 목록·단건 조회 거부`, async () => {
      await assertFails(getDocs(collection(dbFor(kind), "legacyAdjustments")));
      await assertFails(getDoc(doc(dbFor(kind), "legacyAdjustments", "adj-1")));
    });

    it(`${kind}: 올바른 형식의 문서 추가 거부`, async () => {
      await assertFails(setDoc(doc(dbFor(kind), "legacyAdjustments", "new-1"), validAdjustment(ADMIN_UID)));
    });

    it(`${kind}: 수정 거부`, async () => {
      await assertFails(updateDoc(doc(dbFor(kind), "legacyAdjustments", "adj-1"), { Note: "변경" }));
    });

    it(`${kind}: 삭제 거부`, async () => {
      await assertFails(deleteDoc(doc(dbFor(kind), "legacyAdjustments", "adj-1")));
    });
  }

  it("Google·이메일 인증·role=admin claim 을 모두 갖춘 관리자도 직접 추가할 수 없다", async () => {
    await assertFails(
      setDoc(doc(dbFor("verifiedAdmin"), "legacyAdjustments", "new-2"), validAdjustment(ADMIN_UID)),
    );
  });

  it("거부된 뒤에도 기존 문서는 그대로 남아 있다(삭제가 실제로 막혔는지)", async () => {
    await assertFails(deleteDoc(doc(dbFor("verifiedAdmin"), "legacyAdjustments", "adj-1")));
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const snapshot = await getDoc(doc(context.firestore(), "legacyAdjustments", "adj-1"));
      assert.equal(snapshot.exists(), true);
    });
  });
});

describe("규칙에 없는 경로도 전부 거부", () => {
  for (const kind of ALL_KINDS) {
    it(`${kind}: 임의 컬렉션 읽기·쓰기 거부`, async () => {
      await assertFails(getDocs(collection(dbFor(kind), "anything")));
      await assertFails(setDoc(doc(dbFor(kind), "anything", "x"), { x: 1 }));
      await assertFails(setDoc(doc(dbFor(kind), "users", COLLECTOR_DOC_ID, "sub", "x"), { x: 1 }));
    });
  }
});
