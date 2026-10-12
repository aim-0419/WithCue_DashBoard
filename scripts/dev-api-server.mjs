// 로컬 개발용 API 하네스. Vercel Serverless Functions(api/**)를 Node http 서버로 흉내 낸다.
// 사용: npm run emulators → npm run dev:api → npm run dev (VITE_USE_FIREBASE_EMULATORS=true)
import { existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = path.join(ROOT_DIR, "api");
const MAX_BODY_BYTES = 1024 * 1024;

const LOCAL_ENV_FILE = path.join(ROOT_DIR, ".env.server.local");

const handlerCache = new Map();

// .env.server.local이 있으면 먼저 읽는다(이미 셸에 있는 값은 덮어쓰지 않음). 이 파일은 .gitignore의 .env.*.local에 걸린다.
// 포트·호스트는 파일을 읽은 뒤에 정해야 파일의 API_PORT/API_HOST 가 반영된다.
if (existsSync(LOCAL_ENV_FILE) && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(LOCAL_ENV_FILE);
  console.log("[dev-api] .env.server.local 을 읽었습니다.");
}

const PORT = Number(process.env.API_PORT || 3000);
const HOST = process.env.API_HOST || "127.0.0.1";

function writeJson(res, status, body) {
  if (res.headersSent || res.writableEnded) {
    return;
  }

  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

// /api/auth/login → api/auth/login.js. 밑줄로 시작하는 경로(_lib)와 상위 경로 이동은 막는다(Vercel과 같음).
function resolveHandlerFile(pathname) {
  const relativePath = pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");

  if (!relativePath) {
    return null;
  }

  const segments = relativePath.split("/");

  if (segments.some((segment) => !segment || segment.startsWith("_") || segment.startsWith(".") || !/^[\w.-]+$/.test(segment))) {
    return null;
  }

  const candidates = [
    path.join(API_DIR, ...segments) + ".js",
    path.join(API_DIR, ...segments, "index.js"),
  ];

  return candidates.find((candidate) => {
    const resolved = path.resolve(candidate);
    return resolved.startsWith(API_DIR + path.sep) && existsSync(resolved) && statSync(resolved).isFile();
  }) || null;
}

async function loadHandler(filePath) {
  if (!handlerCache.has(filePath)) {
    handlerCache.set(
      filePath,
      import(pathToFileURL(filePath).href).then((module) => module.default),
    );
  }

  return handlerCache.get(filePath);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;

      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Vercel처럼 같은 키가 여러 번 오면 배열로 만든다.
function buildQuery(searchParams) {
  const query = {};

  for (const [key, value] of searchParams) {
    if (Object.prototype.hasOwnProperty.call(query, key)) {
      query[key] = Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
    } else {
      query[key] = value;
    }
  }

  return query;
}

function parseBody(rawBody, contentType) {
  if (!rawBody.trim()) {
    return {};
  }

  if (String(contentType || "").includes("application/json")) {
    return JSON.parse(rawBody);
  }

  return rawBody;
}

// 핸들러가 Vercel 헬퍼(res.status().json(), res.send())를 써도 동작하게 붙인다.
function attachVercelHelpers(res) {
  res.status = (statusCode) => {
    res.statusCode = statusCode;
    return res;
  };
  res.json = (body) => {
    if (!res.getHeader("Content-Type")) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    }

    res.end(JSON.stringify(body));
    return res;
  };
  res.send = (body) => {
    if (body !== null && typeof body === "object" && !Buffer.isBuffer(body)) {
      return res.json(body);
    }

    res.end(body);
    return res;
  };
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  res.on("finish", () => {
    // 본문·헤더는 개인정보·토큰이 섞일 수 있어 남기지 않는다.
    console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - startedAt}ms`);
  });

  if (!url.pathname.startsWith("/api/")) {
    writeJson(res, 404, { ok: false, code: "not_found", message: "API 경로가 아닙니다." });
    return;
  }

  const handlerFile = resolveHandlerFile(url.pathname);

  if (!handlerFile) {
    writeJson(res, 404, { ok: false, code: "not_found", message: "요청한 API를 찾을 수 없습니다." });
    return;
  }

  try {
    const rawBody = await readRawBody(req);

    try {
      req.body = parseBody(rawBody, req.headers["content-type"]);
    } catch {
      writeJson(res, 400, { ok: false, code: "invalid_json", message: "요청 본문 형식이 올바르지 않습니다." });
      return;
    }

    req.query = buildQuery(url.searchParams);
    attachVercelHelpers(res);

    const handler = await loadHandler(handlerFile);

    if (typeof handler !== "function") {
      throw new Error(`${path.relative(ROOT_DIR, handlerFile)}에 default export 핸들러가 없습니다.`);
    }

    await handler(req, res);

    if (!res.writableEnded) {
      writeJson(res, 500, { ok: false, code: "no_response", message: "핸들러가 응답을 보내지 않았습니다." });
    }
  } catch (error) {
    if (error?.status === 413) {
      writeJson(res, 413, { ok: false, code: "payload_too_large", message: "요청 본문이 너무 큽니다." });
      return;
    }

    console.error("[dev-api] 핸들러 오류", error?.stack || String(error));
    writeJson(res, 500, {
      ok: false,
      code: "server_error",
      message: "서버 처리 중 오류가 발생했습니다. 잠시 뒤 다시 시도해 주세요.",
    });
  }
});

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.warn(
    "[dev-api] 경고: FIRESTORE_EMULATOR_HOST 또는 FIREBASE_AUTH_EMULATOR_HOST가 없습니다. " +
      "에뮬레이터 대신 FIREBASE_SERVICE_ACCOUNT_JSON의 실제 프로젝트에 연결될 수 있습니다. " +
      "로컬 개발은 FIRESTORE_EMULATOR_HOST=127.0.0.1:8080, FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099를 지정하세요.",
  );
}

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`[dev-api] ${HOST}:${PORT} 포트를 이미 다른 프로세스가 쓰고 있습니다. API_PORT로 다른 포트를 지정하세요(프론트 dev proxy도 같이 바꿔야 함).`);
  } else {
    console.error("[dev-api] 서버 오류", error?.stack || String(error));
  }

  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[dev-api] http://${HOST}:${PORT}/api/* 대기 중 (api 폴더: ${API_DIR})`);
});
