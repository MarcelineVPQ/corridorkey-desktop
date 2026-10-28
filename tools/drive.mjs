// Drive an isolated copy (tools/isolated.sh) over CDP: run page-side steps,
// save screenshots, close the window (the app quits through its own path).
//   node tools/drive.mjs (--port P | --state DIR) --out DIR [--eval JS --wait MS --shot NAME]... [--close]
// --state: the isolated copy's state folder, whose `port` file tools/isolated.sh wrote. Steps run in order. Only a page
// titled CorridorKey is driven: another app on the port (Marcy's DS5 app holds 9333) is refused, never attached to.
// Node 22's built-in WebSocket only.
/* global WebSocket */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const opt = (k) => args[args.indexOf(k) + 1];
const port = Number(args.includes("--state") ? readFileSync(join(opt("--state"), "port"), "utf8").trim() : opt("--port"));
const out = opt("--out");
mkdirSync(out, { recursive: true });

// the app's page: index.html's and the window's title start with CorridorKey (another Electron app's page doesn't)
const ours = (t) => t.type === "page" && t.title.startsWith("CorridorKey");
let targets = [];
// loop: SERIAL-REQUIRED — waits for the app's page to appear (≤ 30 s)
for (let i = 0; i < 60 && !targets.some(ours); i++) {
  try {
    // loop: SERIAL-REQUIRED — asks the test copy's DevTools port for its pages, 2 s timeout per ask (this pass: had none)
    targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) })).json();
  } catch {
    // error: NOT-WORTH — the app is still starting; retried
  }
  await sleep(500);
}
// loop: NOT-WORTH — a few DevTools targets
const page = targets.find(ours);
if (!page) {
  // loop: NOT-WORTH — a few DevTools targets
  const other = targets.find((t) => t.type === "page");
  throw new Error(other ? `port ${port} serves another app's page ("${other.title}", ${other.url}), not CorridorKey's: refused` : "no page target");
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => (ws.addEventListener("open", r), ws.addEventListener("error", j)));
let id = 0;
const wait = new Map();
ws.addEventListener("message", (m) => {
  const d = JSON.parse(m.data);
  if (d.id && wait.has(d.id)) (wait.get(d.id)(d), wait.delete(d.id));
});
// every CDP call has a deadline: a page that hangs (or an app that died) fails the step instead of waiting forever
const send = (method, params = {}, ms = 30_000) =>
  new Promise((r, j) => {
    const n = ++id;
    // loop: SERIAL-REQUIRED — one CDP reply [bounded: ms, 30 s by default; unref'd, so it never holds the process]
    const t = setTimeout(() => (wait.delete(n), j(new Error(`CDP ${method}: no reply in ${ms / 1000} s`))), ms).unref();
    wait.set(n, (d) => (clearTimeout(t), r(d)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });

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
    // error: NOT-WORTH — the window closing ends the page, so its reply may never come
    send("Runtime.evaluate", { expression: "window.close()" }).catch(() => {});
    await sleep(500);
  }
}
ws.close();
