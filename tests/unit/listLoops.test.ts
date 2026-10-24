import { describe, expect, it } from "vitest";
import { problems, scan, type Row } from "../../tools/list_loops.mjs";

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

  it("exempts plain Rust loops and chains, not waits, pixel loops or while", () => {
    const rs = "engine-rs/crates/ck-core/src/x.rs";
    const exempt = scan(["fn f(v: &[u8]) -> bool {", "    let a = v.iter().any(|&b| b == 0);", "    for b in v {", "        let _ = b;", "    }", "    a", "}"].join("\n"), rs);
    expect(exempt.map((r) => [r.line, r.required, r.verdict])).toEqual([
      [2, false, ""],
      [3, false, ""],
    ]);
    expect(problems(exempt)).toEqual([]);
    const required = scan(
      [
        "fn g(rx: Receiver<u8>, img: &mut [f32], w: usize, h: usize) {",
        "    let _ = rx.recv();",
        "    std::thread::sleep(d);",
        "    for y in 0..h {",
        "        for x in 0..w {",
        "            img[y * w + x] = 0.0;",
        "        }",
        "    }",
        "    while busy() {",
        "        poke();",
        "    }",
        "    loop {",
        "        break;",
        "    }",
        "    let s: Vec<String> = v.iter().map(|x| x.to_string()).collect();",
        "}",
      ].join("\n"),
      rs,
    );
    const at = (n: number) => required.find((r) => r.line === n)!;
    expect(at(5).flags).toContain("pixel");
    expect(at(4).required).toBe(false); // the outer row loop alone is a plain `for`
    expect(problems(required).map((p) => Number(p.split(":")[1]))).toEqual([2, 3, 5, 9, 12, 15]);
    // the exemption applied to every row would let all of these through; the line above pins that it isn't
    const everythingExempt = (rows: Row[]) => problems(rows.map((r) => ({ ...r, required: false })));
    expect(everythingExempt(required)).toEqual([]);
    // every other language: each row still needs a verdict
    expect(problems(scan("for (const a of xs) {}", "src/x.ts"))).toHaveLength(1);
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
