import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";
import { workspaceIntegrationEntry } from "./tooling/workspace-integration";

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  build: {
    chunkSizeWarningLimit: 600,
  },
  resolve: {
    dedupe: ["react", "react-dom", "lightweight-charts"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@workspace-monitoring": workspaceIntegrationEntry(__dirname, process.env.CONDOR_WORKSPACE_ENTRY),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8088",
      "/ws": {
        target: "ws://localhost:8088",
        ws: true,
      },
    },
  },
}));
