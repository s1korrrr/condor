import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";
import { workspaceIntegrationEntry } from "./tooling/workspace-integration.ts";

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  build: {
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        strictExecutionOrder: true,
        // Stable library chunks keep application edits from invalidating the
        // editor and framework downloads. Route imports still determine demand.
        codeSplitting: {
          groups: [
            { name: "vendor-react", test: /node_modules\/(?:react|react-dom|react-router|react-router-dom|scheduler)\//, priority: 30 },
            { name: "editor", test: /(?:node_modules\/(?:@codemirror|@lezer|codemirror|style-mod|w3c-keyname|crelt)\/|\/src\/components\/editor\/)/, priority: 20 },
            { name: "vendor-price-charts", test: /node_modules\/lightweight-charts\//, priority: 10 },
            { name: "vendor-charts", test: /node_modules\/(?:recharts|d3-[^/]+)\//, priority: 10 },
            { name: "vendor", test: /node_modules\//, priority: 0 },
          ],
        },
      },
    },
  },
  resolve: {
    dedupe: ["react", "react-dom", "lightweight-charts"],
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "@workspace-monitoring": workspaceIntegrationEntry(import.meta.dirname, process.env.CONDOR_WORKSPACE_ENTRY),
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
