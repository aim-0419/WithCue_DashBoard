import {
  addDoc,
  collection,
  getDocs,
  limit,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { getFirebaseDb } from "./firebase-client.js";

function normalizeName(name) {
  return name.trim();
}

export async function signUpUser({ name, birthDate, gender, consentAgreed }) {
  const db = getFirebaseDb();
  const normalizedName = normalizeName(name);
  const normalizedBirthDate = Number(birthDate);
  const usersRef = collection(db, "users");
  const duplicateQuery = query(
    usersRef,
    where("Name", "==", normalizedName),
    where("BirthDate", "==", normalizedBirthDate),
    where("Gender", "==", gender),
    limit(1),
  );
  const duplicateSnapshot = await getDocs(duplicateQuery);

  if (!duplicateSnapshot.empty) {
    const existingUser = duplicateSnapshot.docs[0];
    const existingData = existingUser.data();

    return {
      ok: true,
      profile: {
        id: existingUser.id,
        name: existingData.Name,
        birthDate: existingData.BirthDate,
        gender: existingData.Gender,
        role: existingData.Role || "collector",
      },
      message: "이미 가입된 사용자입니다. 같은 정보로 로그인해 주세요.",
    };
  }

  const createdUser = await addDoc(usersRef, {
    Name: normalizedName,
    BirthDate: normalizedBirthDate,
    Gender: gender,
    ConsentAgreed: Boolean(consentAgreed),
    ConsentAt: serverTimestamp(),
    Role: "collector",
    CreatedAt: serverTimestamp(),
    UpdatedAt: serverTimestamp(),
  });

  return {
    ok: true,
    profile: {
      id: createdUser.id,
      name: normalizedName,
      birthDate: normalizedBirthDate,
      gender,
      role: "collector",
    },
    message: "회원가입이 완료되었습니다. 같은 정보로 로그인해 주세요.",
  };
}

export async function loginUser({ name, birthDate, gender, location }) {
  const db = getFirebaseDb();
  const normalizedName = normalizeName(name);
  const normalizedBirthDate = Number(birthDate);
  const usersRef = collection(db, "users");
  const usersQuery = query(
    usersRef,
    where("Name", "==", normalizedName),
    where("BirthDate", "==", normalizedBirthDate),
    where("Gender", "==", gender),
    limit(1),
  );
  const snapshot = await getDocs(usersQuery);

  if (snapshot.empty) {
    return {
      ok: false,
      message: "회원가입한 정보와 일치하는 사용자를 찾을 수 없습니다.",
    };
  }

  const user = snapshot.docs[0];
  const userData = user.data();

  return {
    ok: true,
    session: {
      id: user.id,
      name: userData.Name,
      birthDate: userData.BirthDate,
      gender: userData.Gender,
      role: userData.Role || "collector",
      location,
      signedInAt: new Date().toISOString(),
    },
  };
}
