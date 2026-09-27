import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piServitors from "../src/index.ts";

type Handler = (event: any, ctx: any) => unknown;

test("failed link_send results do not leave a delegation widget behind", async (t) => {
  const handlers = new Map<string, Handler>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
      return () => {};
    },
    registerTool() {},
    registerCommand() {},
  } as unknown as ExtensionAPI;
  piServitors(pi);

  const statuses: Array<string | undefined> = [];
  const widgets: Array<unknown> = [];
  const ui = {
    setStatus(_key: string, value: string | undefined) {
      statuses.push(value);
    },
    setWidget(_key: string, value: unknown) {
      widgets.push(value);
    },
  };
  const ctx = { ui } as unknown as ExtensionContext;
  const toolResult = handlers.get("tool_result");
  const input = handlers.get("input");
  const shutdown = handlers.get("session_shutdown");
  assert.ok(toolResult);
  assert.ok(input);
  assert.ok(shutdown);
  t.after(async () => {
    await shutdown({}, ctx);
  });

  const packet = (taskId: string) =>
    `TASK_ID: ${taskId}\nREPLY_TO: lead@test\nROLE: coder\nGOAL: Implement the task`;

  await toolResult(
    {
      toolName: "link_send",
      isError: false,
      input: { to: "coder@test", message: packet("failed-send") },
      details: { error: "not_delivered" },
    },
    ctx,
  );
  assert.equal(widgets.length, 0);

  await toolResult(
    {
      toolName: "link_send",
      isError: false,
      input: { to: "coder@test", message: packet("successful-send") },
      details: { to: "coder@test" },
    },
    ctx,
  );
  assert.equal(typeof widgets.at(-1), "function");
  assert.match(statuses.at(-1) ?? "", /workers 1 active/);

  await input(
    {
      source: "extension",
      text: "[Link: 1 message(s) received]\nFrom coder@test:\nSTATUS: DONE\nTASK_ID: successful-send",
    },
    ctx,
  );
  assert.equal(widgets.at(-1), undefined);
  assert.equal(statuses.at(-1), undefined);
});
