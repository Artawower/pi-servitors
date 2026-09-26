import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { DelegationTracker } from "../src/delegation/tracker.ts";
import {
  buildDelegationCards,
  formatElapsed,
  renderDelegationGrid,
} from "../src/ui/delegation-grid.ts";
import { buildDelegationStatus, DelegationStatusView } from "../src/ui/delegation-status.ts";
import type { LinkSnapshot } from "../src/types.ts";

const plainTheme = {
  fg(_color: string, text: string) {
    return text;
  },
  bold(text: string) {
    return text;
  },
};

test("formatElapsed stays compact", () => {
  assert.equal(formatElapsed(18_900), "18s");
  assert.equal(formatElapsed(65_000), "1m 05s");
});

test("delegation cards merge live pi-link worker telemetry", () => {
  const cards = buildDelegationCards(
    [
      {
        taskId: "impl-1",
        target: "coder@test",
        role: "coder",
        startedAt: 0,
        elapsedMs: 18_000,
      },
    ],
    {
      supported: true,
      reachable: true,
      reason: null,
      terminals: [
        {
          name: "coder@test",
          status: "tool:bash",
          sinceSeconds: 3,
          context: { tokens: 27_200, window: 272_000 },
        },
      ],
    },
  );

  assert.equal(cards[0]?.telemetry.status, "tool:bash");
  assert.equal(cards[0]?.telemetry.contextTokens, 27_200);
  assert.equal(cards[0]?.telemetry.contextWindow, 272_000);
  assert.match(buildDelegationStatus(cards) ?? "", /workers 1 active.*coder 18s/);
});

test("grid renders concurrent workers as responsive tiles", () => {
  const cards = buildDelegationCards(
    [
      { taskId: "review-security", target: "review-a", role: "reviewer", startedAt: 0, elapsedMs: 8_000 },
      { taskId: "review-architecture", target: "review-b", role: "reviewer", startedAt: 0, elapsedMs: 12_000 },
    ],
    {
      supported: true,
      reachable: true,
      reason: null,
      terminals: [
        { name: "review-a", status: "thinking", context: { tokens: 12_000, window: 100_000 } },
        { name: "review-b", status: "tool:read", context: { tokens: 34_000, window: 100_000 } },
      ],
    },
  );

  const lines = renderDelegationGrid(cards, 80, plainTheme, 2);
  assert.equal(lines.length, 6);
  assert.match(lines[0] ?? "", /reviewer.*reviewer/);
  assert.match(lines.join("\n"), /thinking/);
  assert.match(lines.join("\n"), /read/);
  assert.match(lines.join("\n"), /12%/);
  assert.match(lines.join("\n"), /34%/);
  for (const line of lines) assert.ok(Array.from(line).length <= 80);
});

test("activity bar spans the full tile width", () => {
  const cards = buildDelegationCards(
    [{ taskId: "impl-1", target: "coder", role: "coder", startedAt: 0, elapsedMs: 1_000 }],
    {
      supported: true,
      reachable: true,
      reason: null,
      terminals: [{ name: "coder", status: "thinking", context: { tokens: 1, window: 10 } }],
    },
  );

  const lines = renderDelegationGrid(cards, 40, plainTheme, 4);
  const barLine = lines[2] ?? "";
  assert.equal(Array.from(barLine).length, 40);
  assert.match(barLine, /^│.{38}│$/u);
  assert.match(barLine, /█/u);
  assert.doesNotMatch(barLine, /active/u);
});

test("narrow grid falls back to one tile per row", () => {
  const cards = buildDelegationCards(
    [
      { taskId: "a", target: "a", role: "coder", startedAt: 0, elapsedMs: 1_000 },
      { taskId: "b", target: "b", role: "researcher-code", startedAt: 0, elapsedMs: 2_000 },
    ],
    null,
  );
  const lines = renderDelegationGrid(cards, 40, plainTheme, 0);
  assert.equal(lines.length, 12);
  for (const line of lines) assert.ok(Array.from(line).length <= 40);
});

test("DelegationStatusView mounts tile widget and clears after completion", async () => {
  const statuses: Array<string | undefined> = [];
  const widgets: Array<unknown> = [];
  let renderRequests = 0;
  const ui = {
    setStatus(_key: string, text: string | undefined) {
      statuses.push(text);
    },
    setWidget(_key: string, content: unknown) {
      widgets.push(content);
      if (typeof content === "function") {
        content(
          { requestRender: () => renderRequests++ },
          plainTheme,
        );
      }
    },
  } as unknown as ExtensionUIContext;

  const snapshot: LinkSnapshot = {
    supported: true,
    reachable: true,
    reason: null,
    terminals: [{ name: "coder", status: "thinking", context: { tokens: 1, window: 10 } }],
  };
  const link = { snapshot: async () => snapshot };

  const tracker = new DelegationTracker();
  const view = new DelegationStatusView(tracker, link, 60_000);
  tracker.start({ taskId: "impl-1", target: "coder", role: "coder" }, Date.now());

  view.render(ui);
  await Promise.resolve();
  assert.match(statuses.at(-1) ?? "", /workers 1 active.*coder/);
  assert.equal(typeof widgets.at(-1), "function");

  tracker.complete("impl-1");
  view.render(ui);
  assert.equal(statuses.at(-1), undefined);
  assert.equal(widgets.at(-1), undefined);
  assert.ok(renderRequests >= 0);

  view.clear(ui);
});
