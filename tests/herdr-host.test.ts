import assert from "node:assert/strict";
import test from "node:test";
import type { CommandOptions, CommandResult, CommandRunner } from "../src/command.ts";
import { HerdrHost, herdrInternals } from "../src/host/herdr-host.ts";
import type { HostContext, SlotRef } from "../src/types.ts";

class RecordingRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; options: CommandOptions }> = [];
  response: CommandResult = { code: 0, stdout: "{}", stderr: "" };

  async exec(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
    this.calls.push({ command, args, options });
    return this.response;
  }
}

const ctx: HostContext = {
  backend: "herdr",
  scopeId: "w5",
  leadSlotId: "w5:p2",
  cwd: "/tmp/test-swarm",
};
const slot: SlotRef = { id: "w5:p3", groupId: "w5:t1", cwd: "/tmp/test-swarm" };

test("Herdr backend detection is explicit and environment-scoped", async () => {
  const runner = new RecordingRunner();
  runner.response = { code: 0, stdout: "help", stderr: "" };
  const host = new HerdrHost(runner, { HERDR_WORKSPACE_ID: "w5", HERDR_PANE_ID: "w5:p2" });
  const detection = await host.detect("/tmp/test-swarm");
  assert.deepEqual(detection, { backend: "herdr", available: true, active: true });
});

test("Herdr backend reports unavailable when command execution throws", async () => {
  const runner: CommandRunner = {
    async exec(): Promise<CommandResult> {
      throw new Error("ENOENT");
    },
  };
  const host = new HerdrHost(runner, { HERDR_WORKSPACE_ID: "w5", HERDR_PANE_ID: "w5:p2" });
  const detection = await host.detect("/tmp/test-swarm");
  assert.equal(detection.available, false);
  assert.equal(detection.active, false);
});

test("Herdr worker launch uses pane run, never agent start", async () => {
  const runner = new RecordingRunner();
  const host = new HerdrHost(runner, { HERDR_WORKSPACE_ID: "w5", HERDR_PANE_ID: "w5:p2" });
  await host.run(ctx, slot, ["pi", "--link-name", "worker@team"]);
  assert.deepEqual(runner.calls[0]?.args.slice(0, 3), ["pane", "run", "w5:p3"]);
  assert.match(String(runner.calls[0]?.args[3]), /pi --link-name worker@team/);
  assert.equal(runner.calls.some((call) => call.args[0] === "agent" && call.args[1] === "start"), false);
});

test("shell quoting protects arguments with spaces and quotes", () => {
  assert.equal(herdrInternals.shellQuote("plain-value"), "plain-value");
  assert.equal(herdrInternals.shellQuote("two words"), "'two words'");
  assert.equal(herdrInternals.shellQuote("a'b"), "'a'\\''b'");
});
