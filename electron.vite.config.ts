import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Strict CSP for the renderer: no remote scripts, no eval. Thumbnails and
// result stills come from the main process over ck-media: (cache folder only).
// Production only: the Vite dev server needs inline scripts for HMR.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' ck-media:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function csp(): Plugin {
  return {
    name: "ck-csp",
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      handler: (html: string) => html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
    },
  };
}

export default defineConfig({
  main: { build: { outDir: "out/main", rollupOptions: { input: resolve("electron/main/index.ts") } } },
  preload: {
    build: {
      outDir: "out/preload",
      rollupOptions: {
        input: resolve("electron/preload/index.ts"),
        // Sandboxed preloads must be CommonJS.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: ".",
    plugins: [react(), csp()],
    build: { outDir: "out/renderer", assetsInlineLimit: 0, rollupOptions: { input: resolve("index.html") } },
  },
});
