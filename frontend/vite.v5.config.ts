import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

/** Standalone build for RSI V5. It deliberately has no default dashboard integration. */
export default defineConfig({
  root: import.meta.dirname,
  base: "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: { "@": path.resolve(import.meta.dirname, "./src/v5") },
  },
  build: {
    outDir: "dist-v5",
    emptyOutDir: true,
    rollupOptions: { input: path.resolve(import.meta.dirname, "v5.html") },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8088",
    },
  },
});
