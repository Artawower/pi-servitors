import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piServitors from "../src/index.ts";
import { JOURNAL_ENTRY_TYPE } from "../src/diagnostics/journal.ts";

type Handler = (event: any, ctx: any) => unknown;

function harness() {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const entries: any[] = [];
  const notices: string[] = [];
  const sentUserMessages: any[] = [];
  let activeTools: string[] = [];
  const pi = {
    on(event: string, handler: Handler) { handlers.set(event, handler); return () => {}; },
    registerTool(tool: any) { tools.set(tool.name, tool); activeTools.push(tool.name); },
    getActiveTools() { return [...activeTools]; },
    setActiveTools(names: string[]) { activeTools = [...names]; },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    sendUserMessage(content: unknown, options: unknown) { sentUserMessages.push({ content, options }); },
    async exec() { return { code: 1, stdout: "", stderr: "host unavailable in fixture" }; },
  } as unknown as ExtensionAPI;
  piServitors(pi);
  const ctx = {
    cwd: "/missing-project", isIdle: () => true, sessionManager: {
      getBranch: () => entries,
      getSessionFile: () => "/fixture/lead-session.jsonl",
      getSessionId: () => "fixture-session",
    },
    ui: { setStatus() {}, setWidget() {}, notify(text: string) { notices.push(text); } },
  } as unknown as ExtensionContext;
  return { handlers, tools, commands, entries, ctx, notices, sentUserMessages, get activeTools() { return activeTools; } };
}

function sendEvent(taskId: string, failed = false) {
  return {
    toolName: "link_send", isError: failed,
    input: { to: "coder@test", message: `TASK_ID: ${taskId}\nREPLY_TO: lead@test\nROLE: coder\nGOAL: PRIVATE_TASK_BODY` },
    details: failed ? { error: "PRIVATE_RAW_ERROR" } : { to: "coder@test" },
  };
}

test("existing status tool exposes event-driven delegation state and callback completion", async (t) => {
  const app = harness();
  t.after(async () => { await app.handlers.get("session_shutdown")!({}, app.ctx); });
  await app.handlers.get("tool_result")!(sendEvent("observe"), app.ctx);
  const status = await app.tools.get("team_runtime_status").execute("test", {}, undefined, undefined, app.ctx);
  assert.equal(status.details.diagnostics.runs[0]?.phase, "wait_callback");
  assert.equal(status.details.diagnostics.session.file, "/fixture/lead-session.jsonl");
  assert.match(status.content[0].text, /execution is unconfirmed/);
  assert.doesNotMatch(JSON.stringify(app.entries), /PRIVATE_TASK_BODY/);
  await app.handlers.get("context")!({ messages: [
    { role: "custom", content: "[Link: 1 message(s) received]\nFrom coder@test:\nTASK_ID: observe\nSTATUS: DONE" },
  ] }, app.ctx);
  const completed = await app.tools.get("team_runtime_status").execute("test", {}, undefined, undefined, app.ctx);
  assert.equal(completed.details.diagnostics.runs[0]?.phase, "callback_received");
  assert.equal(completed.details.diagnostics.runs[0]?.state, "succeeded");
});

test("failed link_send is diagnosed without creating a pending callback", async (t) => {
  const app = harness();
  t.after(async () => { await app.handlers.get("session_shutdown")!({}, app.ctx); });
  await app.handlers.get("tool_result")!(sendEvent("failed", true), app.ctx);
  const status = await app.tools.get("team_runtime_status").execute("test", {}, undefined, undefined, app.ctx);
  assert.equal(status.details.diagnostics.runs[0]?.phase, "send_task");
  assert.equal(status.details.diagnostics.runs[0]?.state, "failed");
  assert.doesNotMatch(JSON.stringify(app.entries), /PRIVATE_RAW_ERROR|PRIVATE_TASK_BODY/);
  assert.equal(app.entries.some((entry) => entry.data.phase === "wait_callback"), false);
});

test("reload and tree restoration read only diagnostic entries on the selected branch", async (t) => {
  const original = harness();
  const restored = harness();
  t.after(async () => {
    await original.handlers.get("session_shutdown")!({}, original.ctx);
    await restored.handlers.get("session_shutdown")!({}, restored.ctx);
  });
  await original.handlers.get("tool_result")!(sendEvent("restore"), original.ctx);
  restored.entries.push(...original.entries, { type: "custom", customType: "unrelated", data: { secret: "PRIVATE_OTHER_EXTENSION" } });
  assert.ok(restored.entries.some((entry) => entry.customType === JOURNAL_ENTRY_TYPE));
  restored.entries.push({ type: "custom", customType: "pi-servitors:mode-v1", data: { enabled: true } });
  await restored.handlers.get("session_start")!({}, restored.ctx);
  assert.ok(restored.activeTools.includes("team_ensure_role"), "session mode restores independently of task completion");
  const status = await restored.tools.get("team_runtime_status").execute("test", {}, undefined, undefined, restored.ctx);
  assert.equal(status.details.diagnostics.runs[0]?.state, "unconfirmed");
  assert.doesNotMatch(JSON.stringify(status.details.diagnostics), /PRIVATE_OTHER_EXTENSION/);
  await restored.handlers.get("input")!({ source: "extension", text:
    "[Link: 1 message(s) received]\nFrom coder@test:\nTASK_ID: restore\nSTATUS: DONE" }, restored.ctx);
  const completed = await restored.tools.get("team_runtime_status").execute("test", {}, undefined, undefined, restored.ctx);
  assert.equal(completed.details.diagnostics.runs[0]?.state, "succeeded");
  restored.entries.splice(0);
  await restored.handlers.get("session_tree")!({}, restored.ctx);
  const branched = await restored.tools.get("team_runtime_status").execute("test", {}, undefined, undefined, restored.ctx);
  assert.equal(branched.details.diagnostics.runs.length, 0);
});

test("/servitors opts the session into team mode until /solo", async () => {
  const app = harness();
  const command = app.commands.get("servitors");
  assert.ok(command);
  assert.ok(!app.activeTools.includes("team_ensure_role"), "ordinary prompts cannot access provisioning");
  command.handler("  implement the requested feature  ", app.ctx);
  assert.deepEqual(app.sentUserMessages, [{
    content: "/skill:pi-servitors\n\nimplement the requested feature",
    options: { expandPromptTemplates: true },
  }]);
  assert.ok(app.activeTools.includes("team_ensure_role"));
  await app.handlers.get("tool_result")!(sendEvent("explicit-task"), app.ctx);
  assert.ok(app.activeTools.includes("team_ensure_role"), "mode is session-scoped, not callback-scoped");
  await app.handlers.get("context")!({ messages: [
    { role: "custom", content: "[Link: 1 message(s) received]\nFrom coder@test:\nTASK_ID: explicit-task\nSTATUS: DONE"},
  ] }, app.ctx);
  assert.ok(app.activeTools.includes("team_ensure_role"), "do not silently leave team mode after a callback");
  const guidelines: string[] = [];
  await app.handlers.get("before_agent_start")!({ systemPromptOptions: { promptGuidelines: guidelines } }, app.ctx);
  assert.match(guidelines.join(" "), /Servitors mode is active/);
  await app.commands.get("solo").handler("", app.ctx);
  assert.ok(!app.activeTools.includes("team_ensure_role"), "solo mode hides worker provisioning");
  const restored = harness();
  restored.entries.push(...app.entries.filter((entry) => entry.customType === "pi-servitors:mode-v1"));
  await restored.handlers.get("session_start")!({}, restored.ctx);
  assert.ok(!restored.activeTools.includes("team_ensure_role"), "solo mode persists through reload");
  await restored.handlers.get("session_shutdown")!({}, restored.ctx);
  command.handler("   ", app.ctx);
  assert.equal(app.sentUserMessages.length, 1);
  assert.match(app.notices.at(-1)!, /Usage: \/servitors <prompt>/);
});

test("/servitors refuses to queue an explicit team task while Pi is busy", () => {
  const app = harness();
  app.ctx.isIdle = () => false;
  app.commands.get("servitors").handler("implement this", app.ctx);
  assert.equal(app.sentUserMessages.length, 0);
  assert.match(app.notices.at(-1)!, /Pi is busy/);
});

test("doctor retains the existing tool/command names and exports only when explicitly requested", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "servitor-export-"));
  const originalDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const app = harness();
  t.after(async () => {
    await app.handlers.get("session_shutdown")!({}, app.ctx);
    if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalDir;
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(app.tools.size, 3);
  assert.equal(app.commands.size, 5);
  const doctor = app.tools.get("team_runtime_doctor");
  const plain = await doctor.execute("test", {}, undefined, undefined, app.ctx);
  assert.equal(plain.details.report_file, undefined);
  assert.match(plain.content[0].text, /Environment: unhealthy/);
  const exported = await doctor.execute("test", { report: true }, undefined, undefined, app.ctx);
  assert.equal(typeof exported.details.report_file, "string");
  const report = JSON.parse(await readFile(exported.details.report_file, "utf8"));
  assert.equal(report.schema_version, 1);
  assert.ok(report.diagnostics.provenance.package_root);
  await app.commands.get("team-doctor").handler("--invalid", app.ctx);
  assert.match(app.notices.at(-1)!, /Usage: \/team-doctor \[--report\]/);
});
