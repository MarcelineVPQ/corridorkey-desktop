import { describe, expect, it } from "vitest";
import { keepAwakeWhile } from "../../electron/main/keepAwake";

describe("keepAwakeWhile", () => {
  const recorder = () => {
    const calls: string[] = [];
    let next = 7;
    const keep = keepAwakeWhile({
      start: (type) => (calls.push(`start ${type}`), next++),
      stop: (id) => calls.push(`stop ${id}`),
    });
    return { calls, keep };
  };

  it("holds one blocker while the queue runs and releases it when it stops", () => {
    const { calls, keep } = recorder();
    keep("queue", false);
    keep("queue", true);
    keep("queue", true);
    keep("queue", false);
    keep("queue", false);
    keep("queue", true);
    expect(calls).toEqual(["start prevent-app-suspension", "stop 7", "start prevent-app-suspension"]);
  });

  // review N5: a Console render held no blocker, so a long one could be cut by sleep
  it("one blocker for the queue and the Console together, released when neither runs", () => {
    const { calls, keep } = recorder();
    keep("console", true);
    expect(calls).toEqual(["start prevent-app-suspension"]);
    keep("queue", true);
    keep("console", false);
    expect(calls).toEqual(["start prevent-app-suspension"]);
    keep("queue", false);
    expect(calls).toEqual(["start prevent-app-suspension", "stop 7"]);
  });
});
