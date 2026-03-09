import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy /api/agent -> agent_runtime:8787
// Proxy /api/memory -> memory service:5001
// This avoids CORS issues entirely — all requests go through Vite dev server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      "/api/agent": {
        target: process.env.VITE_AGENT_BASE_URL || "http://localhost:8787",
        rewrite: (path) => path.replace(/^\/api\/agent/, ""),
        changeOrigin: true,
      },
      "/api/memory": {
        target: process.env.VITE_MEMORY_BASE_URL || "http://localhost:5001",
        rewrite: (path) => path.replace(/^\/api\/memory/, ""),
        changeOrigin: true,
      },
    },
  },
});
