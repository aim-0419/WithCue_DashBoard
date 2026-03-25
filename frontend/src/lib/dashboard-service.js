import { collection, getDocs } from "firebase/firestore";
import { getFirebaseDb } from "./firebase-client.js";

const mockDashboardData = {
  source: "mock",
  updatedAt: "2026-03-24 09:55",
  ConsentCount: 128,
  SessionCount: 346,
  Categories: ["장덕점", "효천점", "회사"],
  locations: [
    {
      Name: "장덕점",
      DisplayName: "이끌림(장덕)",
      ConsentCount: 41,
      SessionCount: 112,
      BodyParts: {
        Neck: 21,
        Hip: 30,
        LeftShoulder: 18,
        RightShoulder: 20,
        LeftKnee: 11,
        RightKnee: 12,
      },
    },
    {
      Name: "효천점",
      DisplayName: "이끌림(효천)",
      ConsentCount: 37,
      SessionCount: 104,
      BodyParts: {
        Neck: 17,
        Hip: 28,
        LeftShoulder: 15,
        RightShoulder: 16,
        LeftKnee: 13,
        RightKnee: 15,
      },
    },
    {
      Name: "회사",
      DisplayName: "AIM",
      ConsentCount: 50,
      SessionCount: 130,
      BodyParts: {
        Neck: 22,
        Hip: 34,
        LeftShoulder: 23,
        RightShoulder: 24,
        LeftKnee: 13,
        RightKnee: 14,
      },
    },
  ],
};

const emptyDashboardData = {
  source: "firebase-empty",
  updatedAt: "",
  ConsentCount: 0,
  SessionCount: 0,
  Categories: [],
  locations: [],
};

function aggregateDashboard(snapshotDocs) {
  const locations = snapshotDocs.map((snapshot) => {
    const data = snapshot.data();
    return {
      id: snapshot.id,
      Name: data.Name || "",
      DisplayName: data.DisplayName || data.Name || "",
      ConsentCount: Number(data.ConsentCount || 0),
      SessionCount: Number(data.SessionCount || 0),
      BodyParts: {
        Neck: Number(data.BodyParts?.Neck || 0),
        Hip: Number(data.BodyParts?.Hip || 0),
        LeftShoulder: Number(data.BodyParts?.LeftShoulder || 0),
        RightShoulder: Number(data.BodyParts?.RightShoulder || 0),
        LeftKnee: Number(data.BodyParts?.LeftKnee || 0),
        RightKnee: Number(data.BodyParts?.RightKnee || 0),
      },
    };
  });

  const consentCount = locations.reduce((total, location) => total + location.ConsentCount, 0);
  const sessionCount = locations.reduce((total, location) => total + location.SessionCount, 0);

  return {
    source: "firebase",
    updatedAt: new Date().toLocaleString("ko-KR"),
    ConsentCount: consentCount,
    SessionCount: sessionCount,
    Categories: locations.map((location) => location.DisplayName || location.Name),
    locations,
  };
}

export async function getDashboardData() {
  try {
    const db = getFirebaseDb();
    const snapshot = await getDocs(collection(db, "locations"));

    if (snapshot.empty) {
      return {
        ...emptyDashboardData,
        source: "firebase-empty",
      };
    }

    return aggregateDashboard(snapshot.docs);
  } catch (error) {
    return {
      ...emptyDashboardData,
      source: "mock-error",
      errorMessage: error.message,
      errorCode: error.code || "",
      fallback: mockDashboardData,
    };
  }
}
