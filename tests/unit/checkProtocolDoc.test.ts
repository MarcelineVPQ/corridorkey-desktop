import { describe, expect, it } from "vitest";
import { assignedKeys, checkAll, checkApp, checkDoc, replyObjects, withoutTests } from "../../tools/check_protocol_doc.mjs";

// The Rust engine's pong before 2026-10-27's doc: coreml_available and unavailable were sent, not documented.
const MAIN_RS = `json!({
    "type": "pong", "version": V, "device": match p { Some(_) => "cuda", _ => "cpu" },
    "coreml_available": rt.coreml_ep,
    "assets": p.map(|p| json!(a(p))).unwrap_or(json!({})), "config": {"x": 1}
})`;
const DOC = [
  '→ {"cmd":"ping"}',
  '→ {"cmd":"run","id":"j1"}',
  '← {"type":"pong","version":"1","device":"cuda","assets":{},"config":{}}',
  '← {"type":"error","id":"j1","code":"oom|engine","message":"..."}',
  "- `coreml_available`: the Core ML provider is there.",
].join("\n");

describe("the protocol gate", () => {
  it("passes on this repository", () => {
    expect(checkAll()).toEqual([]);
  });

  it("reads a reply's type and top-level keys, not nested ones or ones inside strings", () => {
    expect(replyObjects(MAIN_RS)).toEqual([{ type: "pong", keys: ["type", "version", "device", "coreml_available", "assets", "config"], at: 2 }]);
    expect(replyObjects(`send({"type": "log", "text": f"a {x} \\"b\\": c"})`)[0].keys).toEqual(["type", "text"]);
    expect(assignedKeys(`msg["cache_invalidated"] = json!(names); x["a"] == 1`)).toEqual(["cache_invalidated"]);
    expect(withoutTests('fn a() {}\n#[cfg(test)]\nmod tests {\n json!({"type": "x"}) }')).toBe("fn a() {}\n");
  });

  it("(a)-(c) an undocumented reply type, key or error code fails", () => {
    const src = (text: string) => [{ path: "main.rs", text }];
    expect(checkDoc(DOC, src(MAIN_RS), ["oom", "engine"])).toEqual([]);
    expect(checkDoc(DOC.replace("- `coreml_available`: the Core ML provider is there.", ""), src(MAIN_RS), ["oom"])).toEqual([expect.stringContaining('key "coreml_available"')]);
    expect(checkDoc(DOC, src(`json!({"type": "trt_built", "range": r})`), [])).toEqual([expect.stringContaining('reply type "trt_built"'), expect.stringContaining('key "range"')]);
    expect(checkDoc(DOC, src(`msg["retry_after_oom"] = json!(1);`), [])).toEqual([expect.stringContaining('"retry_after_oom" (assigned)')]);
    expect(checkDoc(DOC, [], ["oom", "no-gpu"])).toEqual([expect.stringContaining('misses "no-gpu"')]);
  });

  it("(d)-(f) the app: unknown cmds, reply types, pong fields; every pong field read or listed", () => {
    const queue = { path: "electron/main/queue.ts", text: 'send({ cmd: "run" }); switch (r.type) { case "progress": break; } v = pong.version; d = pong.device;' };
    const notRead = new Map([
      ["type", "kind"],
      ["coreml_available", "why"],
    ]);
    const keys = ["type", "version", "device", "coreml_available"];
    expect(checkApp([queue], DOC, ["run", "ping"], ["progress"], keys, notRead)).toEqual([]);
    expect(checkApp([{ ...queue, text: queue.text + ' send({ cmd: "warm" })' }], DOC, ["run"], ["progress"], keys, notRead)).toEqual([
      expect.stringContaining('cmd "warm", which ck-engine'),
      expect.stringContaining('cmd "warm" isn\'t in docs'),
    ]);
    expect(checkApp([{ ...queue, text: queue.text + ' if (m.type === "warmed") {}' }], DOC, ["run"], ["progress"], keys, notRead)).toEqual([expect.stringContaining('"warmed"')]);
    // the Pong type's gap: a new pong field nobody reads or lists
    expect(checkApp([queue], DOC, ["run"], ["progress"], [...keys, "unavailable"], notRead)).toEqual([expect.stringContaining('the pong\'s "unavailable"')]);
    expect(checkApp([{ ...queue, text: queue.text + " pong.coreml_available" }], DOC, ["run"], ["progress"], keys, notRead)).toEqual([
      expect.stringContaining('PONG_NOT_READ lists "coreml_available", which the app reads'),
    ]);
    expect(checkApp([{ ...queue, text: queue.text + " pong.gone" }], DOC, ["run"], ["progress"], keys, notRead)).toEqual([expect.stringContaining("reads pong.gone")]);
  });
});
