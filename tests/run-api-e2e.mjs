// API 종단 테스트 러너. Auth·Firestore 에뮬레이터가 떠 있는 상태(emulators:exec)에서
// dev-api-server 를 띄우고 tests/api/*.mjs 를 차례로 실행한 뒤 종료 코드를 합친다.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = process.env.API_PORT || "3100";
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const SCRIPTS = ["tests/api/core.mjs", "tests/api/extra.mjs"];

const env = {
  ...process.env,
  API_PORT,
  API_BASE,
  FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080",
  FIREBASE_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099",
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || "withcuedashboard",
  ADMIN_EMAILS: process.env.ADMIN_EMAILS || "admin@example.com,boss@example.com",
};

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${API_BASE}/api/auth/login`);
      if (response.status === 405) return;
    } catch {
      // 아직 안 떴음
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`API 서버가 ${API_BASE} 에서 응답하지 않습니다.`);
}

async function runScript(script) {
  const child = spawn(process.execPath, [script], { cwd: ROOT, env, stdio: "inherit" });
  const [code] = await once(child, "exit");
  return code;
}

const server = spawn(process.execPath, ["scripts/dev-api-server.mjs"], { cwd: ROOT, env, stdio: ["ignore", "ignore", "inherit"] });
let exitCode = 0;

try {
  await waitForServer();

  for (const script of SCRIPTS) {
    console.log(`\n=== ${script} ===`);
    const code = await runScript(script);
    if (code !== 0) exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  exitCode = 2;
} finally {
  server.kill();
}

process.exit(exitCode);
