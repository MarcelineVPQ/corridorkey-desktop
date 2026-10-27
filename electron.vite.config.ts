import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Strict CSP for the renderer: no remote or inline scripts, no eval, no plugins, frames, forms or network.
// Thumbnails and result stills come from the main process over ck-media: (cache folder only); data: images are
// the liquid glass's displacement maps (liquidGlass.ts, an SVG feImage, made in the page); fonts are the
// system's (tokens.css). Delivered as a <meta> because the page loads from file://, which has no response
// headers (Electron's security guide); so frame-ancestors (header-only, ignored in a meta) can't be set: the
// window denies every new window and navigation instead (index.ts setWindowOpenHandler, will-navigate).
// Production only: the Vite dev server needs inline scripts for HMR. Gate: .hooks/check_electron_security.sh.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' ck-media: data:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
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
