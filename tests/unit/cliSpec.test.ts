// The Console's checked-in copy of the CLI (src/shared/console/cliSpec.json) is what the built binary prints: it can't
// drift. Without a built corridorkey (cargo build -p ck-cli, or CK_CLI_BIN) the comparison is skipped, saying so.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hostSpec, SPEC_FILE, specText } from "../../tools/gen_cli_spec.mjs";

const found = hostSpec();
if (!found) console.log("cliSpec.test: no corridorkey binary built (cargo build -p ck-cli, or CK_CLI_BIN): the drift check is skipped");

describe("the Console's copy of the CLI spec", () => {
  it.skipIf(!found)("equals what the built corridorkey prints (run node tools/gen_cli_spec.mjs)", () => {
    expect(readFileSync(SPEC_FILE, "utf8")).toBe(specText(found!.spec));
  });

  it("has no version (a release bump never makes it stale)", () => {
    expect(JSON.parse(readFileSync(SPEC_FILE, "utf8"))).not.toHaveProperty("version");
  });
});
