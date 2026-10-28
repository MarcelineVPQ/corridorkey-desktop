// The React hooks lint (senior review S6): the Rules of Hooks and every effect's, memo's and callback's dependencies,
// over the renderer (src/). A dependency left out on purpose says why, with an eslint-disable on that line; a disable
// that no longer silences anything fails too. Run by the gates (tools/run_gates.mjs) and `npm run lint`.
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "error" },
  },
];
