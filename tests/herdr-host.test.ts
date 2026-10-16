import assert from "node:assert/strict";
import test from "node:test";
import type { CommandOptions, CommandResult, CommandRunner } from "../src/command.ts";
import { HerdrHost, herdrInternals } from "../src/host/herdr-host.ts";
import type { HostContext, SlotRef } from "../src/types.ts";

class RecordingRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; options: CommandOptions }> = [];
  response: CommandResult = { code: 0, stdout: "{}", stderr: "" };
  handler?: (args: readonly string[], options: CommandOptions) => CommandResult;

  async exec(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
    this.calls.push({ command, args, options });
    return this.handler?.(args, options) ?? this.response;
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

function jsonResult(value: object): CommandResult {
  return { code: 0, stdout: JSON.stringify({ result: value }), stderr: "" };
}

const noAgent: CommandResult = { code: 1, stdout: "", stderr: "agent not found" };
const shellProcess = { process_info: { shell_pid: 100, foreground_process_group_id: 100 } };

function shellRunner(): RecordingRunner {
  const runner = new RecordingRunner();
  runner.handler = (args) => {
    if (args[0] === "agent") return noAgent;
    if (args[1] === "process-info") return jsonResult(shellProcess);
    return { code: 0, stdout: "{}", stderr: "" };
  };
  return runner;
}

test("shell readiness requires execution, not just foreground shell ownership", async () => {
  const runner = shellRunner();
  await new HerdrHost(runner).waitUntilRunnable(ctx, slot);
  const probe = runner.calls.find((call) => call.args[1] === "run");
  const wait = runner.calls.find((call) => call.args[1] === "wait-output");
  assert.ok(probe);
  assert.ok(wait);
  assert.match(String(probe.args[3]), /^printf %s%s __psv_ready_ [\da-f-]+$/);
  assert.match(String(wait.args[4]), /^__psv_ready_/);
  assert.equal(String(probe.args[3]).includes(String(wait.args[4])), false);
  assert.equal(runner.calls.some((call) => String(call.args[3]).startsWith("pi ")), false);
});

test("readiness uses unwrapped output so narrow panes cannot split the acknowledgement", async () => {
  const runner = shellRunner();
  const original = runner.handler!;
  runner.handler = (args, options) => {
    if (args[1] === "wait-output") {
      assert.deepEqual(args.slice(-2), ["--source", "recent-unwrapped"]);
    }
    return original(args, options);
  };
  await new HerdrHost(runner).waitUntilRunnable(ctx, slot);
});

test("partially buffered probes cannot leave an unterminated quoted continuation", async () => {
  const runner = shellRunner();
  await new HerdrHost(runner).waitUntilRunnable(ctx, slot);
  const probe = String(runner.calls.find((call) => call.args[1] === "run")?.args[3]);
  // Even if startup consumes any prefix, no remaining suffix opens a quote,
  // escaped newline, or bracketed continuation in the shell line editor.
  assert.doesNotMatch(probe, /['"\\\\()[\]{}\n\r]/);
});

test("shell startup losing a probe retries only harmless commands with fresh tokens", async () => {
  const runner = shellRunner();
  const original = runner.handler!;
  const tokens: string[] = [];
  runner.handler = (args, options) => {
    if (args[1] === "wait-output") {
      tokens.push(String(args[4]));
      if (tokens.length === 1) return { code: 1, stdout: "", stderr: "timed out waiting for output" };
    }
    return original(args, options);
  };
  await new HerdrHost(runner).waitUntilRunnable(ctx, slot);
  assert.equal(tokens.length, 2);
  assert.notEqual(tokens[0], tokens[1]);
  const probes = runner.calls.filter((call) => call.args[1] === "run");
  assert.equal(probes.length, 2);
  assert.ok(probes.every((call) => String(call.args[3]).startsWith("printf ")));
});

test("PTY echo without probe execution cannot satisfy readiness", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const runner = shellRunner();
  const original = runner.handler!;
  let command = "";
  runner.handler = (args, options) => {
    if (args[1] === "run") command = String(args[3]);
    if (args[1] === "wait-output") {
      assert.equal(command.includes(String(args[4])), false);
      now = 20_000;
      return { code: 1, stdout: command, stderr: "timed out waiting for output" };
    }
    return original(args, options);
  };
  await assert.rejects(new HerdrHost(runner).waitUntilRunnable(ctx, slot), /did not reach an available interactive shell/);
});

test("busy and occupied panes are never sent a shell probe", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const runner = shellRunner();
  runner.handler = (args) => {
    if (args[0] === "agent") return noAgent;
    if (args[1] === "process-info") {
      now = 20_000;
      return jsonResult({ process_info: { shell_pid: 100, foreground_process_group_id: 200 } });
    }
    throw new Error("must not send input to busy pane");
  };
  await assert.rejects(new HerdrHost(runner).waitUntilRunnable(ctx, slot), /did not reach an available interactive shell/);
  now = 0;
  runner.handler = () => jsonResult({ agent: { pane_id: slot.id, name: "unrelated", agent_status: "idle" } });
  await assert.rejects(new HerdrHost(runner).waitUntilRunnable(ctx, slot), /occupied by a worker/);
  assert.equal(runner.calls.some((call) => call.args[1] === "run"), false);
});

test("shell probe fails immediately for non-timeout CLI errors", async () => {
  const runner = shellRunner();
  const original = runner.handler!;
  runner.handler = (args, options) => args[1] === "wait-output"
    ? { code: 1, stdout: "", stderr: "pane not found" }
    : original(args, options);
  await assert.rejects(new HerdrHost(runner).waitUntilRunnable(ctx, slot), /shell readiness probe failed.*pane not found/);
  assert.equal(runner.calls.filter((call) => call.args[1] === "run").length, 1);
});

test("probe budgets shrink to the remaining shell readiness deadline", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const runner = shellRunner();
  const original = runner.handler!;
  runner.handler = (args, options) => {
    if (args[1] === "process-info") now = 19_500;
    if (args[1] === "run") {
      assert.equal(options.timeout, 500);
      now = 19_750;
    }
    if (args[1] === "wait-output") {
      assert.equal(args[6], "250");
      now = 20_000;
      return { code: 1, stdout: "", stderr: "timed out waiting for output" };
    }
    return original(args, options);
  };
  await assert.rejects(new HerdrHost(runner).waitUntilRunnable(ctx, slot), /did not reach/);
});

test("missing Pi and detected-but-unready Pi have distinct timeout diagnostics", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const runner = new RecordingRunner();
  runner.handler = () => {
    now = 120_000;
    return noAgent;
  };
  await assert.rejects(new HerdrHost(runner).waitForWorker(ctx, slot), /No Pi worker was detected/);
  now = 0;
  runner.handler = () => {
    now = 120_000;
    return jsonResult({ agent: { pane_id: slot.id, agent_status: "unknown" } });
  };
  await assert.rejects(new HerdrHost(runner).waitForWorker(ctx, slot), /Pi was detected.*last_worker=/);
});

test("ready Pi is returned without resubmitting a launch command", async () => {
  const runner = new RecordingRunner();
  runner.response = jsonResult({ agent: { pane_id: slot.id, agent_status: "idle" } });
  assert.deepEqual(await new HerdrHost(runner).waitForWorker(ctx, slot), { slotId: slot.id, state: "idle" });
  assert.equal(runner.calls.length, 1);
});

test("aborted startup never sends commands or reports readiness", async () => {
  const runner = shellRunner();
  const controller = new AbortController();
  controller.abort(new Error("cancelled startup"));
  const host = new HerdrHost(runner);
  await assert.rejects(host.waitUntilRunnable(ctx, slot, controller.signal), /cancelled startup/);
  await assert.rejects(host.waitForWorker(ctx, slot, controller.signal), /cancelled startup/);
  assert.equal(runner.calls.length, 0);
});

test("abort during a shell probe is not treated as a timeout or successful startup", async () => {
  const runner = shellRunner();
  const original = runner.handler!;
  const controller = new AbortController();
  runner.handler = (args, options) => {
    assert.equal(options.signal, controller.signal);
    if (args[1] === "wait-output") controller.abort(new Error("cancelled probe"));
    return original(args, options);
  };
  await assert.rejects(new HerdrHost(runner).waitUntilRunnable(ctx, slot, controller.signal), /cancelled probe/);
  assert.equal(runner.calls.filter((call) => call.args[1] === "run").length, 1);
});
