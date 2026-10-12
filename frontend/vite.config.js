import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: ".",
  envDir: ".",
  publicDir: "public",
  plugins: [react()],
  server: {
    // 로컬 개발 시 /api 요청을 서버 하네스(scripts/dev-api-server.mjs)로 넘긴다.
    proxy: {
      "/api": { target: `http://127.0.0.1:${process.env.API_PORT || 3000}`, changeOrigin: true },
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
