import { describe, expect, it } from "vitest";
import { keepAwakeWhile } from "../../electron/main/keepAwake";

describe("keepAwakeWhile", () => {
  it("holds one blocker while the queue runs and releases it when it stops", () => {
    const calls: string[] = [];
    let next = 7;
    const keep = keepAwakeWhile({
      start: (type) => (calls.push(`start ${type}`), next++),
      stop: (id) => calls.push(`stop ${id}`),
    });
    keep(false);
    keep(true);
    keep(true);
    keep(false);
    keep(false);
    keep(true);
    expect(calls).toEqual(["start prevent-app-suspension", "stop 7", "start prevent-app-suspension"]);
  });
});
