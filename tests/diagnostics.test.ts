import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FlowJournal, JOURNAL_LIMIT, type FlowEvent } from "../src/diagnostics/journal.ts";
import { assessProgress, currentProgress } from "../src/diagnostics/assessment.ts";
import { captureProvenance } from "../src/diagnostics/provenance.ts";
import { inspectWorkerConfiguration } from "../src/diagnostics/configuration.ts";
import { formatRuntimeResult } from "../src/diagnostics/format.ts";
import { saveDoctorReport } from "../src/diagnostics/report.ts";
import type { DoctorResult } from "../src/types.ts";

const context = { cwd: "/missing-project", role: "coder" as const, kind: "provision" as const };

test("journal records phase duration and distinguishes launch submission from worker readiness", async () => {
  let now = 1000;
  const journal = new FlowJournal(undefined, () => now);
  const id = journal.start(context);
  await journal.stage(id, context, "launch_command", async () => {});
  journal.record(id, context, "wait_worker", "started");
  now = 9000;
  const progress = journal.progress()[0]!;
  assert.equal(progress.phase, "wait_worker");
  assert.equal(progress.state, "running");
  assert.equal(progress.phase_elapsed_ms, 8000);
  assert.equal(progress.last_confirmed?.phase, "launch_command");
  assert.match(assessProgress([progress])[0]!.evidence, /does not prove a stall/);
});

test("journal failure preserves the failed phase without persisting raw error secrets", async () => {
  const persisted: FlowEvent[] = [];
  const journal = new FlowJournal((event) => persisted.push(event));
  const id = journal.start(context);
  await assert.rejects(journal.stage(id, context, "wait_shell", async () => {
    throw new Error("password=VERY_SECRET");
  }), /VERY_SECRET/);
  assert.equal(journal.progress()[0]?.state, "failed");
  assert.equal(journal.progress()[0]?.phase, "wait_shell");
  assert.equal(JSON.stringify(persisted).includes("VERY_SECRET"), false);
});

test("journal memory and restoration are bounded and validate their allowlisted schema", () => {
  const journal = new FlowJournal();
  const id = journal.start(context);
  for (let i = 0; i < JOURNAL_LIMIT + 50; i++) journal.record(id, context, "wait_worker", "started");
  assert.equal(journal.history().length, JOURNAL_LIMIT);
  const valid = journal.history()[0]!;
  journal.restore([null, {}, { ...valid, at: 1e99 }, { ...valid, role: "admin" },
    ...Array.from({ length: JOURNAL_LIMIT + 50 }, () => ({ ...valid, prompt: "secret prompt", token: "secret token" }))]);
  assert.equal(journal.history().length, JOURNAL_LIMIT);
  assert.equal(JSON.stringify(journal.history()).includes("secret"), false);
  assert.equal(journal.progress()[0]?.state, "unconfirmed");
});

test("restoration is branch-local, keeps completed outcomes and never resumes provisioning", () => {
  const first = new FlowJournal();
  const id = first.start(context);
  first.record(id, context, "ready", "succeeded");
  const second = new FlowJournal();
  second.restore(first.history());
  assert.equal(second.progress()[0]?.state, "succeeded");
  second.restore([]);
  assert.equal(second.progress().length, 0);
});

test("journal persistence failure does not break the flow and is reported", () => {
  const journal = new FlowJournal(() => { throw new Error("disk unavailable"); });
  assert.doesNotThrow(() => journal.start(context));
  assert.equal(journal.persistence_error, true);
  assert.equal(journal.progress().length, 1);
});

test("tasks wait for callback without claiming receipt or execution and callbacks are idempotent", () => {
  let now = 1000;
  const journal = new FlowJournal(undefined, () => now);
  const task = { cwd: context.cwd, role: context.role, task_id: "task-1", target: "coder@test" };
  journal.taskSent(task);
  now = 5000;
  const pending = journal.progress()[0]!;
  assert.equal(pending.phase, "wait_callback");
  assert.equal(pending.last_confirmed?.phase, "send_task");
  assert.equal(pending.elapsed_ms, 4000);
  journal.callbackReceived("unrelated", context.cwd);
  assert.equal(journal.progress()[0]?.state, "running");
  journal.callbackReceived("task-1", context.cwd);
  const count = journal.history().length;
  journal.callbackReceived("task-1", context.cwd);
  assert.equal(journal.history().length, count);
  assert.equal(journal.progress()[0]?.phase, "callback_received");
  assert.equal(journal.progress()[0]?.state, "succeeded");
});

test("failed send never enters callback wait and successful retry supersedes its finding", () => {
  const journal = new FlowJournal();
  const task = { cwd: context.cwd, role: context.role, task_id: "retry", target: "coder@test" };
  journal.taskSendFailed(task);
  assert.equal(journal.progress()[0]?.state, "failed");
  assert.equal(journal.progress()[0]?.phase, "send_task");
  journal.taskSent(task);
  journal.callbackReceived("retry", context.cwd);
  assert.equal(assessProgress(currentProgress(journal.progress())).length, 0);
});

test("a successful provisioning retry removes the current failure but retains incident history", () => {
  const journal = new FlowJournal();
  const failed = journal.start(context);
  journal.record(failed, context, "wait_shell", "failed");
  const successful = journal.start(context);
  journal.record(successful, context, "ready", "succeeded");
  assert.equal(journal.progress().length, 2);
  assert.equal(currentProgress(journal.progress()).length, 1);
  assert.equal(assessProgress(currentProgress(journal.progress())).length, 0);
});

test("cwd aliases resolve to the same trace and callbacks survive a reload", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "servitor-alias-"));
  try {
    await mkdir(path.join(directory, "project"));
    await symlink(path.join(directory, "project"), path.join(directory, "alias"));
    const journal = new FlowJournal();
    journal.taskSent({ cwd: path.join(directory, "alias"), role: "coder", task_id: "alias", target: "coder@test" });
    const restored = new FlowJournal();
    restored.restore(journal.history());
    assert.equal(restored.progress(path.join(directory, "project"))[0]?.state, "unconfirmed");
    restored.callbackReceived("alias", path.join(directory, "project"));
    assert.equal(restored.progress()[0]?.state, "succeeded");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("code fingerprint is captured once and distinguishes sources with the same version", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "servitor-fingerprint-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.5.1" }));
    await writeFile(path.join(root, "src", "index.ts"), "export const value = 1;");
    const captured = captureProvenance(root);
    await writeFile(path.join(root, "src", "index.ts"), "export const value = 2;");
    const changed = captureProvenance(root);
    assert.equal(captured.version, changed.version);
    assert.notEqual(captured.source_sha256, changed.source_sha256);
    assert.match(captured.source_sha256 ?? "", /^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration diagnostics disclose sources, not settings bodies or credential-bearing specs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "servitor-config-report-"));
  try {
    await writeFile(path.join(root, "settings.json"), JSON.stringify({
      secret: "PRIVATE_SETTINGS_VALUE",
      servitors: { extensions: ["npm:safe-provider", "https://user:REMOTE_SECRET@example.test/ext?token=QUERY_SECRET"] },
    }));
    const config = inspectWorkerConfiguration(root, { PI_CODING_AGENT_DIR: root });
    assert.equal(config.sources[1]?.status, "loaded");
    assert.ok(config.configured_extensions.coder.includes("npm:safe-provider"));
    assert.doesNotMatch(JSON.stringify(config), /PRIVATE_SETTINGS_VALUE|REMOTE_SECRET|QUERY_SECRET/);
    await writeFile(path.join(root, "settings.json"), "{broken-secret");
    assert.equal(inspectWorkerConfiguration(root, { PI_CODING_AGENT_DIR: root }).sources[1]?.status, "invalid_or_unreadable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("long-running task summaries survive timeline eviction and can still receive callbacks", () => {
  const events: FlowEvent[] = [];
  const journal = new FlowJournal((event) => events.push(event));
  journal.taskSent({ cwd: context.cwd, role: "coder", task_id: "long", target: "coder@test" });
  for (let index = 0; index < JOURNAL_LIMIT + 20; index++) {
    const id = journal.start(context);
    journal.record(id, context, "ready", "succeeded");
  }
  assert.equal(journal.history().length, JOURNAL_LIMIT);
  assert.equal(journal.history_truncated, true);
  assert.equal(journal.progress().find((run) => run.task_id === "long")?.state, "running");
  assert.equal(journal.runs_truncated, false);
  const restored = new FlowJournal();
  restored.restore(events);
  assert.equal(restored.progress().find((run) => run.task_id === "long")?.state, "unconfirmed");
  restored.callbackReceived("long", context.cwd);
  assert.equal(restored.progress().find((run) => run.task_id === "long")?.state, "succeeded");
});

test("the runtime fingerprint attached to historical events survives reload", () => {
  const journal = new FlowJournal();
  journal.setOrigin({ package_root: "/old-package", source_sha256: "a".repeat(64) });
  const id = journal.start(context);
  const restored = new FlowJournal();
  restored.setOrigin({ package_root: "/new-package", source_sha256: "b".repeat(64) });
  restored.restore(journal.history());
  assert.equal(restored.progress()[0]?.last_event.source_sha256, "a".repeat(64));
  restored.record(id, context, "ready", "succeeded");
  assert.equal(restored.progress()[0]?.last_event.source_sha256, "b".repeat(64));
});

function doctorFixture(journal: FlowJournal): DoctorResult {
  return {
    status: "ok", healthy: true, environment_health: "healthy", execution_health: "pending",
    cwd: context.cwd, selected_backend: "fake", host_backends: [], transport: "pi-link/link_send",
    lead_link: null, lead_link_error: "RAW_ERROR_SECRET", pi_link_status: {}, dependencies: [], profiles: [], workers: [],
    diagnostics: {
      provenance: captureProvenance(), configuration: null, runs: journal.progress(), recent_events: journal.history(),
      findings: assessProgress(journal.progress()), persistence_error: false, history_limit: JOURNAL_LIMIT,
      history_truncated: journal.history_truncated, runs_truncated: journal.runs_truncated,
    },
  };
}

test("doctor formatting separates environment health from flow and does not call a long wait a stall", () => {
  const journal = new FlowJournal();
  journal.taskSent({ cwd: context.cwd, role: "coder", task_id: "format", target: "coder@test" });
  const formatted = formatRuntimeResult(doctorFixture(journal));
  assert.match(formatted, /Environment: healthy · Execution: pending/);
  assert.match(formatted, /wait_callback/);
  assert.match(formatted, /execution is unconfirmed/);
  assert.doesNotMatch(formatted, /RUNNING_TASK|DEADLOCK|worker is stuck/);
});

test("explicit report writes one private metadata-only file without raw errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "servitor-report-"));
  try {
    const journal = new FlowJournal();
    journal.taskSent({ cwd: context.cwd, role: "coder", task_id: "report", target: "coder@test" });
    const file = await saveDoctorReport(doctorFixture(journal), path.join(root, "reports"));
    const text = await readFile(file, "utf8");
    assert.match(text, /wait_callback/);
    assert.doesNotMatch(text, /RAW_ERROR_SECRET/);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
