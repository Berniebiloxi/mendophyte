import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// The web app builds into ../public, which the node server serves as-is.
// During development `vite` runs on its own port and proxies /api and /ws
// to a running `mendophyte` server (npm run dev in another terminal).
export default defineConfig({
  root: here,
  plugins: [react()],
  build: {
    outDir: path.resolve(here, "../public"),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:4317", changeOrigin: true },
      "/ws": { target: "ws://localhost:4317", ws: true },
    },
  },
});
