// Drive an isolated copy (tools/isolated.sh) over CDP: run page-side steps,
// save screenshots, close the window (the app quits through its own path).
//   node tools/drive.mjs --port P --out DIR [--eval JS --wait MS --shot NAME]... [--close]
// Steps run in order. Node 22's built-in WebSocket only.
/* global WebSocket */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const opt = (k) => args[args.indexOf(k) + 1];
const port = Number(opt("--port"));
const out = opt("--out");
mkdirSync(out, { recursive: true });

let targets = [];
// loop: SERIAL-REQUIRED — waits for the app's page to appear (≤ 30 s)
for (let i = 0; i < 60 && !targets.some((t) => t.type === "page"); i++) {
  try {
    // loop: SERIAL-REQUIRED — asks the test copy's DevTools port for its pages, 2 s timeout per ask (this pass: had none)
    targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) })).json();
  } catch {
    // error: NOT-WORTH — the app is still starting; retried
  }
  await sleep(500);
}
// loop: NOT-WORTH — a few DevTools targets
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => (ws.addEventListener("open", r), ws.addEventListener("error", j)));
let id = 0;
const wait = new Map();
ws.addEventListener("message", (m) => {
  const d = JSON.parse(m.data);
  if (d.id && wait.has(d.id)) (wait.get(d.id)(d), wait.delete(d.id));
});
const send = (method, params = {}) => new Promise((r) => (wait.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));

// loop: SERIAL-REQUIRED — the steps are an ordered script
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--eval") {
    const r = await send("Runtime.evaluate", { expression: args[++i], awaitPromise: true, returnByValue: true });
    console.log("eval:", JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.text ?? null).slice(0, 400));
  } else if (a === "--wait") await sleep(Number(args[++i]));
  else if (a === "--shot") {
    const r = await send("Page.captureScreenshot", { format: "png" });
    const f = join(out, `${args[++i]}.png`);
    writeFileSync(f, Buffer.from(r.result.data, "base64"));
    console.log("shot:", f);
  } else if (a === "--close") {
    send("Runtime.evaluate", { expression: "window.close()" });
    await sleep(500);
  }
}
ws.close();
