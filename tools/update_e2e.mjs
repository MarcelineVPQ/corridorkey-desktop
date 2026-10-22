// The page-side half of tools/update_e2e.sh, over CDP: check → available →
// download → ready → restart, then reconnect to the new copy and read its
// version. Every step's state is printed; any other outcome fails.
/* global WebSocket */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const opt = (k) => args[args.indexOf(k) + 1];
// --port-file: Chromium's DevToolsActivePort (the copies run with --remote-debugging-port=0, so the old copy, still
// quitting, and the new one never compete for one port); its first line is the port in use now
const portFile = opt("--port-file");
const portNow = () => Number(readFileSync(portFile, "utf8").split("\n")[0]);
const expect = opt("--expect");
const out = opt("--out");

async function page(timeoutMs) {
  const until = Date.now() + timeoutMs;
  // loop: SERIAL-REQUIRED — waits for the app's page (bounded by timeoutMs)
  while (Date.now() < until) {
    try {
      // loop: SERIAL-REQUIRED — polls the test copy's DevTools port, 2 s timeout per ask
      const t = (await (await fetch(`http://127.0.0.1:${portNow()}/json`, { signal: AbortSignal.timeout(2000) })).json()).find((x) => x.type === "page");
      if (t) return t;
    } catch {
      // error: NOT-WORTH — the app is still starting; retried until the timeout
    }
    await sleep(500);
  }
  throw new Error("no page target");
}

async function connect(timeoutMs) {
  const t = await page(timeoutMs);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => (ws.addEventListener("open", r), ws.addEventListener("error", j)));
  let id = 0;
  const wait = new Map();
  ws.addEventListener("message", (m) => {
    const d = JSON.parse(m.data);
    if (d.id && wait.has(d.id)) (wait.get(d.id)(d), wait.delete(d.id));
  });
  // loop: NOT-WORTH — pending DevTools calls when the socket closes
  ws.addEventListener("close", () => wait.forEach((r) => r({ error: "closed" })));
  const send = (method, params = {}) => new Promise((r) => (wait.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));
  // every evaluation gives up after 15 s (a page that is quitting never answers)
  const evaluate = async (expression) =>
    (await Promise.race([send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }), sleep(15_000).then(() => ({ error: "timeout" }))])).result?.result?.value;
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    if (r.result?.data) writeFileSync(join(out, `${name}.png`), Buffer.from(r.result.data, "base64"));
  };
  return { ws, evaluate, shot };
}

const update = (c) => c.evaluate("window.ck.getState().then(s => s.update)");
async function waitFor(c, statuses, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let u;
  // loop: SERIAL-REQUIRED — polls the app's update state every 500 ms (bounded by timeoutMs)
  while (Date.now() < until) {
    u = await update(c);
    if (statuses.includes(u?.status)) return u;
    if (u?.status === "error") throw new Error(`update error: ${u.error}`);
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${statuses.join("/")}; last: ${JSON.stringify(u)}`);
}

const old = await connect(60_000);
await sleep(1500);
console.log("old version:", await old.evaluate("window.ck.getState().then(s => s.version)"));
console.log("start:", JSON.stringify(await update(old)));
await old.evaluate("window.ck.checkForUpdates()");
console.log("after check:", JSON.stringify(await waitFor(old, ["available", "current"], 30_000)));
await old.evaluate("window.ck.installUpdate()");
const ready = await waitFor(old, ["ready"], 120_000);
console.log("after download:", JSON.stringify(ready));
await old.shot("update-ready");
const oldTarget = (await page(5000)).id;
// the new copy writes its own port file
rmSync(portFile, { force: true });
console.log("restarting at", new Date().toISOString());
old.evaluate("window.ck.restartToUpdate()");
// the old copy quits; the new one starts on the same flags (same DevTools port): wait for a different page target
const until = Date.now() + 60_000;
let moved = false;
// loop: SERIAL-REQUIRED — waits for the old page to go and a new one to come (≤ 60 s)
while (Date.now() < until && !moved) {
  await sleep(1000);
  try {
    // loop: SERIAL-REQUIRED — polls the test copy's DevTools port, 2 s timeout per ask
    const t = (await (await fetch(`http://127.0.0.1:${portNow()}/json`, { signal: AbortSignal.timeout(2000) })).json()).find((x) => x.type === "page");
    moved = Boolean(t && t.id !== oldTarget);
    console.log(new Date().toISOString(), t ? (t.id === oldTarget ? "old page still up" : "new page up") : "no page");
  } catch {
    // error: SHOWN — printed: nothing listening between the two copies
    console.log(new Date().toISOString(), "no answer on the DevTools port");
  }
}
old.ws.close();
if (!moved) {
  console.error("FAIL: no new copy came up within 60 s");
  process.exit(1);
}
const fresh = await connect(60_000);
await sleep(1500);
const v = await fresh.evaluate("window.ck.getState().then(s => s.version)");
console.log("new version:", v);
await fresh.shot("after-restart");
fresh.evaluate("window.close()");
await sleep(1500);
if (v !== expect) {
  console.error(`FAIL: expected ${expect}, got ${v}`);
  process.exit(1);
}
console.log("PASS: updated to", v);
