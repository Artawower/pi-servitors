import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { PiCommandRunner } from "./command.ts";
import { HerdrHost } from "./host/herdr-host.ts";
import { callbackTaskIds, callbackTaskIdsFromContext, looksLikePiLinkDelivery, parseDelegationPacket } from "./delegation/protocol.ts";
import { DelegationTracker } from "./delegation/tracker.ts";
import { PiLinkStatusClient } from "./link/pi-link-status.ts";
import { WorkerRuntime } from "./runtime/worker-runtime.ts";
import path from "node:path";
import { FlowJournal, JOURNAL_ENTRY_TYPE } from "./diagnostics/journal.ts";
import { formatRuntimeResult as formatResult } from "./diagnostics/format.ts";
import { saveDoctorReport } from "./diagnostics/report.ts";
import type { DoctorResult, RuntimeStatusResult } from "./types.ts";
import { DelegationStatusView } from "./ui/delegation-status.ts";

const ROLE_SCHEMA = StringEnum(["coder", "reviewer", "researcher-code"] as const);

function hasOperationalError(details: unknown): boolean {
  return Boolean(
    details &&
      typeof details === "object" &&
      (details as Record<string, unknown>).error,
  );
}

function withSession<T extends DoctorResult | RuntimeStatusResult>(result: T, ctx: ExtensionContext): T {
  result.diagnostics.session = {
    file: ctx.sessionManager?.getSessionFile?.() ?? null,
    id: ctx.sessionManager?.getSessionId?.() ?? null,
  };
  return result;
}

export default function piServitors(pi: ExtensionAPI) {
  const runner = new PiCommandRunner(pi);
  const backendPreference = process.env.PI_SERVITORS_BACKEND;
  const linkStatus = new PiLinkStatusClient();
  const journal = new FlowJournal((event) => pi.appendEntry(JOURNAL_ENTRY_TYPE, event));
  const runtime = new WorkerRuntime({
    hosts: [new HerdrHost(runner)],
    journal,
    link: linkStatus,
    ...(backendPreference ? { backendPreference } : {}),
  });

  const delegations = new DelegationTracker();
  const delegationView = new DelegationStatusView(delegations, linkStatus);
  let servitorsMode = false;
  const setServitorsMode = (enabled: boolean, persist = false) => {
    servitorsMode = enabled;
    const activeTools = new Set(pi.getActiveTools());
    if (enabled) activeTools.add("team_ensure_role");
    else activeTools.delete("team_ensure_role");
    pi.setActiveTools([...activeTools]);
    if (persist) pi.appendEntry("pi-servitors:mode-v1", { enabled });
  };

  const restore = (ctx: ExtensionContext) => {
    journal.restore(ctx.sessionManager.getBranch().flatMap((entry) =>
      entry.type === "custom" && entry.customType === JOURNAL_ENTRY_TYPE ? [entry.data] : []));
    delegations.clear();
    for (const run of journal.progress()) {
      if (run.kind !== "delegation" || run.phase !== "wait_callback" ||
        !["running", "unconfirmed"].includes(run.state) || !run.task_id || !run.target) continue;
      delegations.start({ taskId: run.task_id, target: run.target, role: run.role }, run.started_at);
    }
    const branch = ctx.sessionManager.getBranch();
    let modeEntry: (typeof branch)[number] | undefined;
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry?.type === "custom" && entry.customType === "pi-servitors:mode-v1" &&
        entry.data && typeof entry.data === "object" && "enabled" in entry.data) {
        modeEntry = entry;
        break;
      }
    }
    const enabled = Boolean(modeEntry?.type === "custom" &&
      (modeEntry.data as { enabled?: unknown }).enabled === true);
    setServitorsMode(enabled);
    delegationView.render(ctx.ui);
  };
  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));

  const completeTask = (taskId: string, ctx: ExtensionContext): boolean => {
    journal.callbackReceived(taskId, path.resolve(ctx.cwd ?? process.cwd()));
    return Boolean(delegations.complete(taskId));
  };
  const completeCallbacks = (text: string, ctx: ExtensionContext) => {
    if (!looksLikePiLinkDelivery(text)) return;
    let changed = false;
    for (const taskId of callbackTaskIds(text)) {
      if (completeTask(taskId, ctx)) changed = true;
    }
    if (changed) delegationView.render(ctx.ui);
  };

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "link_send") return;

    const message = typeof event.input.message === "string" ? event.input.message : null;
    const target = typeof event.input.to === "string" ? event.input.to : null;
    if (!message || !target) return;

    const packet = parseDelegationPacket(message);
    if (!packet) return;
    const flow = { cwd: path.resolve(ctx.cwd ?? process.cwd()), role: packet.role, target, task_id: packet.taskId };
    if (event.isError || hasOperationalError(event.details)) {
      journal.taskSendFailed(flow);
      return;
    }

    delegations.start({
      taskId: packet.taskId,
      target,
      role: packet.role,
    });
    journal.taskSent(flow);
    delegationView.render(ctx.ui);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "extension") return;
    completeCallbacks(event.text, ctx);
  });

  // pi.sendMessage({ triggerTurn: true }) currently bypasses before_agent_start
  // in Pi. The context event still runs before the provider request and contains
  // the delivered [Link: ...] message, so completion tracking lives here.
  pi.on("context", async (event, ctx) => {
    let changed = false;
    for (const taskId of callbackTaskIdsFromContext(event.messages)) {
      if (completeTask(taskId, ctx)) changed = true;
    }
    if (changed) delegationView.render(ctx.ui);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    delegations.clear();
    journal.clear();
    setServitorsMode(false);
    delegationView.clear(ctx.ui);
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!servitorsMode) return;
    const guideline = "Servitors mode is active for this Pi session. Route substantive user work through the pi-servitors team workflow; do not switch to solo mode unless the user runs /solo.";
    if (!event.systemPromptOptions.promptGuidelines.includes(guideline)) {
      event.systemPromptOptions.promptGuidelines.push(guideline);
    }
  });

  pi.registerTool({
    name: "team_ensure_role",
    label: "Workers: ensure role",
    description:
      "Provision workers only for an explicit user task started with /servitors <prompt>. " +
      "Ensure exactly one managed worker for coder/reviewer/researcher-code in the current terminal host scope. " +
      "The runtime starts or reuses the worker, inherits the Lead pi-link group, and returns the exact link_target plus Lead reply identity. " +
      "After READY, normal delegation MUST use pi-link link_send. Do not poll status/list tools while waiting and do not fall back to terminal-host messaging.",
    parameters: Type.Object({ role: ROLE_SCHEMA }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: `Ensuring ${params.role}…` }],
        details: {},
      });
      const result = await runtime.ensureRole(ctx.cwd, params.role, signal);
      return {
        content: [{ type: "text", text: formatResult(result) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "team_runtime_status",
    label: "Workers: runtime status",
    description:
      "Read-only snapshot of worker processes, connectivity, observed flow phases, elapsed waits and pending task callbacks. " +
      "Does not create, restart, prompt, or wait for workers.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const result = withSession(await runtime.status(ctx.cwd, signal), ctx);
      return {
        content: [{ type: "text", text: formatResult(result) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "team_runtime_doctor",
    label: "Workers: runtime doctor",
    description:
      "Check runtime prerequisites separately from observed flow health, explain unconfirmed transitions, code/config provenance and next checks. " +
      "Does not create/restart workers or poll for task completion. report=true explicitly saves a metadata-only local report.",
    parameters: Type.Object({ report: Type.Optional(Type.Boolean()) }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = withSession(await runtime.doctor(ctx.cwd, signal), ctx);
      if (params.report) result.report_file = await saveDoctorReport(result);
      return {
        content: [{ type: "text", text: formatResult(result) }],
        details: result,
      };
    },
  });

  setServitorsMode(false);

  pi.registerCommand("servitors", {
    description: "Run a task with the pi-servitors team: /servitors <prompt>",
    handler: (args, ctx) => {
      const prompt = args.trim();
      if (!prompt) {
        ctx.ui.notify("Usage: /servitors <prompt>", "error");
        return Promise.resolve();
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Pi is busy. Start /servitors <prompt> when the current turn is complete.", "warning");
        return Promise.resolve();
      }
      setServitorsMode(true, true);
      pi.sendUserMessage(`/skill:pi-servitors\n\n${prompt}`, { expandPromptTemplates: true });
      return Promise.resolve();
    },
  });

  pi.registerCommand("solo", {
    description: "Return this Pi session to solo mode",
    handler: (_args, _ctx) => {
      setServitorsMode(false, true);
      return Promise.resolve();
    },
  });

  pi.registerCommand("team-status", {
    description: "Show worker processes, observed phases, elapsed waits and pending callbacks",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify(formatResult(withSession(await runtime.status(ctx.cwd, ctx.signal), ctx)), "info");
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    },
  });

  pi.registerCommand("team-ensure", {
    description: "Deprecated: start team tasks with /servitors <prompt>",
    handler: (_args, ctx) => {
      ctx.ui.notify("Start a Servitors task with /servitors <prompt>.", "info");
      return Promise.resolve();
    },
  });

  pi.registerCommand("team-doctor", {
    description: "Explain prerequisites and flow health; --report saves a metadata-only diagnostic report",
    handler: async (args, ctx) => {
      if (args.trim() && args.trim() !== "--report") {
        ctx.ui.notify("Usage: /team-doctor [--report]", "error");
        return;
      }
      try {
        const result = withSession(await runtime.doctor(ctx.cwd, ctx.signal), ctx);
        if (args.trim() === "--report") result.report_file = await saveDoctorReport(result);
        ctx.ui.notify(formatResult(result), "info");
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    },
  });
}
