import { describe, expect, it } from "vitest";
import { problems, scan } from "../../tools/list_loops.mjs";

describe("loop pass lister", () => {
  it("lists Rust loops, chains, waits and threads, not the test module", () => {
    const src = [
      "fn f(v: &[f32], rx: std::sync::mpsc::Receiver<u8>) -> Vec<f32> {",
      "    // loop: HOT-PATH-OK — one frame",
      "    for x in v.iter() {",
      "        let _ = x;",
      "    }",
      "    let _ = rx.recv();",
      "    std::thread::spawn(move || {});",
      "    v.iter().map(|x| x * 2.0).collect()",
      "}",
      "#[cfg(test)]",
      "mod tests {",
      "    fn t() { for _ in 0..3 {} }",
      "}",
    ].join("\n");
    const rows = scan(src, "engine-rs/crates/ck-core/src/x.rs");
    expect(rows.map((r) => [r.line, r.kind, r.verdict])).toEqual([
      [3, "loop+iter", "HOT-PATH-OK"],
      [6, "wait", ""],
      [7, "thread", ""],
      [8, "iter", ""],
    ]);
    expect(rows[1].flags).toContain("no-timeout");
    expect(rows[3].flags).toContain("alloc");
  });

  it("asks waits without a deadline what bounds them", () => {
    const bare = scan("// loop: SERIAL-REQUIRED — in order\nlet a = rx.recv();", "engine-rs/crates/ck-core/src/x.rs");
    expect(problems(bare)).toHaveLength(1);
    const bounded = scan("// loop: SERIAL-REQUIRED — in order [bounded: the producer ends]\nlet a = rx.recv();", "engine-rs/crates/ck-core/src/x.rs");
    expect(problems(bounded)).toEqual([]);
    const timed = scan("let a = rx.recv_timeout(d);", "engine-rs/crates/ck-core/src/x.rs");
    expect(timed[0].flags).not.toContain("no-timeout");
  });

  it("finds TS timers, callbacks, nesting, JSX verdicts and wrapped chains", () => {
    const src = [
      "// loop: NOT-WORTH — a few",
      "for (const a of xs) {",
      "  ys.forEach((y) => y);",
      "}",
      "setTimeout(() => {}, 10);",
      "const out = (",
      "  <ul>",
      "    {/* loop: HOT-PATH-OK — rows per render */}",
      "    {rows.map((r) => <li key={r}>{r}</li>)}",
      "  </ul>",
      ");",
      "// loop: NOT-WORTH — one line",
      "const b = text",
      '  .split("\\n")',
      "  .map((l) => l.trim());",
    ].join("\n");
    const rows = scan(src, "src/ui/X.tsx");
    const at = (n: number) => rows.find((r) => r.line === n)!;
    expect(at(2).verdict).toBe("NOT-WORTH");
    expect(at(3).flags).toContain("nested");
    expect(at(5).kind).toBe("timer");
    expect(at(9).verdict).toBe("HOT-PATH-OK");
    expect(at(15).verdict).toBe("NOT-WORTH");
    expect(problems(rows).map((p) => p.split(":")[1])).toEqual(["3", "5"]);
  });

  it("flags blocking calls on the Electron main process only", () => {
    expect(scan("const s = readFileSync(f);", "electron/main/x.ts")[0].flags).toContain("main-blocking");
    expect(scan("const s = readFileSync(f);", "tools/x.mjs")).toEqual([]);
  });
});
