import assert from "node:assert/strict";
import test from "node:test";
import { DelegationTracker } from "../src/delegation/tracker.ts";

test("tracker keeps independent parallel delegations", () => {
  const tracker = new DelegationTracker();
  tracker.start({ taskId: "impl-1", target: "coder", role: "coder" }, 1_000);
  tracker.start({ taskId: "research-1", target: "researcher", role: "researcher-code" }, 2_000);

  assert.deepEqual(
    tracker.snapshot(5_000).map(({ taskId, elapsedMs }) => ({ taskId, elapsedMs })),
    [
      { taskId: "impl-1", elapsedMs: 4_000 },
      { taskId: "research-1", elapsedMs: 3_000 },
    ],
  );

  const completed = tracker.complete("research-1", 6_000);
  assert.equal(completed?.elapsedMs, 4_000);
  assert.deepEqual(tracker.snapshot(6_000).map((item) => item.taskId), ["impl-1"]);
});

test("re-observing the same TASK_ID does not reset elapsed time", () => {
  const tracker = new DelegationTracker();
  tracker.start({ taskId: "impl-1", target: "coder-a", role: "coder" }, 1_000);
  tracker.start({ taskId: "impl-1", target: "coder-b", role: "coder" }, 4_000);

  const [active] = tracker.snapshot(5_000);
  assert.equal(active?.startedAt, 1_000);
  assert.equal(active?.target, "coder-b");
  assert.equal(active?.elapsedMs, 4_000);
});
