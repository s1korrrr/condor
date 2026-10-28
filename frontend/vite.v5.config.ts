import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import { defineConfig, type Plugin } from "vite";

const frontendRoot = import.meta.dirname;
const workspaceRoot = process.env.V5_WORKSPACE_ROOT;
if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) throw new Error("V5_WORKSPACE_ROOT must point to the Razer package root containing dashboard/condor-workspace.");
const monitoringEntry = path.join(workspaceRoot, "dashboard/condor-workspace/src/index.ts");
const reportingRoot = path.join(workspaceRoot, "dashboard/hummingbot-reporting-next/app");
const reportingCss = path.join(workspaceRoot, "dashboard/hummingbot-reporting-next/app/globals.css");
if (!existsSync(monitoringEntry) || !existsSync(reportingRoot) || !existsSync(reportingCss)) throw new Error("The private V5 dashboard integration sources are incomplete under V5_WORKSPACE_ROOT.");

function v5ReadTransportAlias(): Plugin {
  const adapter = path.resolve(frontendRoot, "src/v5/auth-token.ts");
  return {
    name: "v5-read-transport-alias",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "@/lib/auth-token" || source === "@/lib/auth-token.ts") return adapter;
      if (source === "./auth-token" && importer && /\/frontend\/src\/lib\/(?:api|auth)\.ts$/.test(importer)) return adapter;
      return null;
    },
  };
}

const sharedScopeSource = readFileSync(path.join(workspaceRoot, "dashboard/condor-workspace/tooling/scope-reporting-css.ts"), "utf8");
const sharedScopeJavaScript = ts.transpileModule(sharedScopeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const sharedScopeModule: { exports: { scopeReportingCss?: (file: string) => Plugin } } = { exports: {} };
new Function("exports", "module", sharedScopeJavaScript)(sharedScopeModule.exports, sharedScopeModule);
const scopeReportingCss = sharedScopeModule.exports.scopeReportingCss;
if (!scopeReportingCss) throw new Error("The private reporting CSS scope helper did not export scopeReportingCss.");

export default defineConfig({
  root: frontendRoot,
  base: "/",
  plugins: [v5ReadTransportAlias(), react(), tailwindcss()],
  css: { postcss: { plugins: [scopeReportingCss(reportingCss)] } },
  resolve: {
    dedupe: ["react", "react-dom", "react-router-dom", "@tanstack/react-query", "@tanstack/query-core", "recharts", "lucide-react", "lightweight-charts"],
    alias: {
      "@": path.resolve(frontendRoot, "src"),
      "@workspace-monitoring": monitoringEntry,
      "@reporting": reportingRoot,
    },
  },
  build: {
    chunkSizeWarningLimit: 600,
    outDir: "dist-v5",
    emptyOutDir: true,
    rollupOptions: { input: path.resolve(frontendRoot, "v5.html") },
  },
  server: { proxy: { "/api": "http://localhost:8088" } },
});
