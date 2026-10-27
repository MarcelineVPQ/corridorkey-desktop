// The Console's checked-in copy of the CLI (src/shared/console/cliSpec.json) is what the built binary prints: it can't
// drift. Without a built corridorkey (cargo build -p ck-cli) the comparison is skipped, saying so (and `npm run check`
// says it again at its end: tools/gen_cli_spec.mjs --status); a CK_CLI_BIN that isn't one fails.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostSpec, SPEC_FILE, specText } from "../../tools/gen_cli_spec.mjs";

const found = hostSpec();
if (!found) console.log("cliSpec.test: no corridorkey binary built (cargo build -p ck-cli, or CK_CLI_BIN): the drift check is skipped");

describe("the Console's copy of the CLI spec", () => {
  it.skipIf(!found)("equals what the built corridorkey prints (run node tools/gen_cli_spec.mjs)", () => {
    expect(readFileSync(SPEC_FILE, "utf8")).toBe(specText(found!.spec));
  });

  it("a CK_CLI_BIN that is set but missing, or doesn't answer __spec, is an error, never a skip (senior review 2026-10-26 N10)", () => {
    expect(() => hostSpec({ CK_CLI_BIN: join(tmpdir(), "no-such-corridorkey") })).toThrow(/no such file/);
    // a program that exists but isn't corridorkey (node, with "__spec" as its script)
    expect(() => hostSpec({ CK_CLI_BIN: process.execPath })).toThrow(/doesn't answer/);
  });

  it("has no version (a release bump never makes it stale)", () => {
    expect(JSON.parse(readFileSync(SPEC_FILE, "utf8"))).not.toHaveProperty("version");
  });
});
