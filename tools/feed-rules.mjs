// The app's own feed rules (electron/main/updateFeed.ts) for the release
// tools, so CI and the app can never disagree on a feed. The .ts file is
// bundled in memory with esbuild (already installed with Vite): Node's own
// type stripping isn't in every Node build (the distro Node 22 here has none).
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../electron/main/updateFeed.ts", import.meta.url));
const { outputFiles } = buildSync({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", target: "node22", write: false, logLevel: "error" });
const rules = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
export const { FEED_BRANCH, FEED_URLS, REPO, TRUSTED_KEYS, feedSignedBy, feedText, parseFeed, selectRelease } = rules;
