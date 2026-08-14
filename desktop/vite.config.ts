import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      "@aitest/ide-protocol": path.resolve(__dirname, "../packages/ide-protocol/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Windows native fs.watch often throws UV UNKNOWN (-4094) under Node 23 / AV / D: sync.
    // Polling is slower but stable; ignore src-tauri (Tauri + Vite template).
    watch: {
      usePolling: process.platform === "win32",
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "esnext",
  },
});
