import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { PiCommandRunner } from "./command.ts";
import { HerdrHost } from "./host/herdr-host.ts";
import { callbackTaskIds, callbackTaskIdsFromContext, looksLikePiLinkDelivery, parseDelegationPacket } from "./delegation/protocol.ts";
import { DelegationTracker } from "./delegation/tracker.ts";
import { PiLinkStatusClient } from "./link/pi-link-status.ts";
import { WorkerRuntime } from "./runtime/worker-runtime.ts";
import type { RuntimeResult } from "./types.ts";
import { DelegationStatusView } from "./ui/delegation-status.ts";

const ROLE_SCHEMA = StringEnum(["coder", "reviewer", "researcher-code"] as const);

function hasOperationalError(details: unknown): boolean {
  return Boolean(
    details &&
      typeof details === "object" &&
      (details as Record<string, unknown>).error,
  );
}

function normalizeRole(value: string): "coder" | "reviewer" | "researcher-code" | null {
  const role = value.trim().toLowerCase();
  if (role === "researcher") return "researcher-code";
  if (role === "coder" || role === "reviewer" || role === "researcher-code") return role;
  return null;
}

function formatResult(result: RuntimeResult): string {
  if (result.status === "ready") {
    return [
      `${result.role}: ${result.reused ? "reused" : "started"}`,
      `target=${result.link_target}`,
      `reply_to=${result.lead_link_name}`,
      `group=${result.link_group ?? "plain"}`,
      `transport=${result.transport}`,
      `backend=${result.backend}`,
      `scope=${result.scope}`,
      `host_group=${result.group}`,
      `slot=${result.slot}`,
      `cwd=${result.cwd}`,
      `profile=${result.profile}`,
      `link=${result.link.connected === true ? "connected" : result.link.connected === false ? "not connected" : "unknown"}`,
    ].join("\n");
  }

  if ("healthy" in result) return JSON.stringify(result, null, 2);

  if (result.roles.length === 0) {
    const lead = result.lead_link?.name ? ` Lead=${result.lead_link.name}.` : "";
    const error = result.lead_link_error ? ` ${result.lead_link_error}` : "";
    return `No managed worker roles are present.${lead}${error}`;
  }

  return result.roles
    .map((role) => {
      const name = String(role.role ?? "unknown");
      const state = String(role.state ?? "unknown");
      const target = String(role.link_target ?? "unknown");
      const slot = String(role.slot ?? "unknown");
      const link = role.link_connected === true ? "link:on" : role.link_connected === false ? "link:off" : "link:?";
      return `${name}: ${state} · ${target} · ${slot} · ${link}`;
    })
    .join("\n");
}

export default function piServitors(pi: ExtensionAPI) {
  const runner = new PiCommandRunner(pi);
  const backendPreference = process.env.PI_SERVITORS_BACKEND;
  const linkStatus = new PiLinkStatusClient();
  const runtime = new WorkerRuntime({
    hosts: [new HerdrHost(runner)],
    link: linkStatus,
    ...(backendPreference ? { backendPreference } : {}),
  });

  const delegations = new DelegationTracker();
  const delegationView = new DelegationStatusView(delegations, linkStatus);

  const completeCallbacks = (text: string, ctx: ExtensionContext) => {
    if (!looksLikePiLinkDelivery(text)) return;
    let changed = false;
    for (const taskId of callbackTaskIds(text)) {
      if (delegations.complete(taskId)) changed = true;
    }
    if (changed) delegationView.render(ctx.ui);
  };

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "link_send" || event.isError || hasOperationalError(event.details)) return;

    const message = typeof event.input.message === "string" ? event.input.message : null;
    const target = typeof event.input.to === "string" ? event.input.to : null;
    if (!message || !target) return;

    const packet = parseDelegationPacket(message);
    if (!packet) return;

    delegations.start({
      taskId: packet.taskId,
      target,
      role: packet.role,
    });
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
      if (delegations.complete(taskId)) changed = true;
    }
    if (changed) delegationView.render(ctx.ui);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    delegations.clear();
    delegationView.clear(ctx.ui);
  });

  pi.registerTool({
    name: "team_ensure_role",
    label: "Workers: ensure role",
    description:
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
      "Read-only status of managed workers, selected terminal backend, Lead pi-link identity/group, and worker connectivity. " +
      "Does not create, restart, prompt, or wait for workers.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const result = await runtime.status(ctx.cwd, signal);
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
      "Check terminal-host availability, bundled Pi dependencies, pi-link /status, deterministic Lead/group inference, and worker profiles. Does not create workers.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const result = await runtime.doctor(ctx.cwd, signal);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerCommand("team-status", {
    description: "Show managed worker roles and pi-link targets",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify(formatResult(await runtime.status(ctx.cwd, ctx.signal)), "info");
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    },
  });

  pi.registerCommand("team-ensure", {
    description: "Ensure one role: coder | reviewer | researcher-code",
    handler: async (args, ctx) => {
      const role = normalizeRole(args);
      if (!role) {
        ctx.ui.notify("Usage: /team-ensure coder|reviewer|researcher-code", "error");
        return;
      }
      try {
        ctx.ui.notify(formatResult(await runtime.ensureRole(ctx.cwd, role, ctx.signal)), "info");
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    },
  });

  pi.registerCommand("team-doctor", {
    description: "Check servitor host/pi-link prerequisites and Lead group detection",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify(JSON.stringify(await runtime.doctor(ctx.cwd, ctx.signal), null, 2), "info");
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    },
  });
}
