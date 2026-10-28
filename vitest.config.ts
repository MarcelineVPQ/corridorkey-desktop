import { defineConfig } from "vitest/config";

export default defineConfig({
  // .tsx: the renderer's components, rendered under jsdom (each such file says `// @vitest-environment jsdom`)
  test: { include: ["tests/**/*.test.{ts,tsx}"], environment: "node" },
  esbuild: { jsx: "automatic" },
});
