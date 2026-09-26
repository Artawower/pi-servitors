import { SHELL_READY_TIMEOUT_MS, WORKER_START_TIMEOUT_MS } from "../config.ts";
import type { CommandResult, CommandRunner } from "../command.ts";
import { runChecked } from "../command.ts";
import { RuntimeFailure } from "../errors.ts";
import type {
  GroupCreation,
  GroupRef,
  HostContext,
  HostDetection,
  SlotInspection,
  SlotRef,
  WorkerRef,
} from "../types.ts";
import type { WorkerHost } from "./worker-host.ts";

const POLL_MS = 250;

type JsonObject = Record<string, unknown>;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

function firstString(obj: JsonObject, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = obj[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function entityId(obj: JsonObject, kind: string): string | undefined {
  return firstString(obj, [`${kind}_id`, "id", kind]);
}

function entityLabel(obj: JsonObject): string | undefined {
  return firstString(obj, ["label", "name", "title"]);
}

function agentName(obj: JsonObject): string | undefined {
  return firstString(obj, ["agent_name", "name", "label"]);
}

function agentState(obj: JsonObject): string | undefined {
  return firstString(obj, ["agent_status", "state", "status"]);
}

function agentSlotId(obj: JsonObject): string | undefined {
  const direct = firstString(obj, ["pane_id"]);
  if (direct) return direct;
  const pane = obj.pane;
  if (typeof pane === "string" && pane) return pane;
  if (pane && typeof pane === "object") return entityId(pane as JsonObject, "pane");
  return undefined;
}

function slotGroupId(obj: JsonObject): string | undefined {
  const direct = firstString(obj, ["tab_id"]);
  if (direct) return direct;
  const tab = obj.tab;
  if (typeof tab === "string" && tab) return tab;
  if (tab && typeof tab === "object") return entityId(tab as JsonObject, "tab");
  return undefined;
}

function slotScopeId(obj: JsonObject): string | undefined {
  const direct = firstString(obj, ["workspace_id"]);
  if (direct) return direct;
  const workspace = obj.workspace;
  if (typeof workspace === "string" && workspace) return workspace;
  if (workspace && typeof workspace === "object") {
    return entityId(workspace as JsonObject, "workspace");
  }
  return undefined;
}

function slotCwd(obj: JsonObject): string | undefined {
  return firstString(obj, ["foreground_cwd", "cwd"]);
}

function unwrap(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "result" in payload) {
    return (payload as JsonObject).result;
  }
  return payload;
}

function listResult(payload: unknown, key: string): JsonObject[] {
  const root = unwrap(payload);
  if (Array.isArray(root)) return root.filter(isObject);
  if (isObject(root) && Array.isArray(root[key])) return root[key].filter(isObject);
  if (isObject(payload) && Array.isArray(payload[key])) return payload[key].filter(isObject);
  return [];
}

function objectResult(payload: unknown, key: string): JsonObject {
  const root = unwrap(payload);
  if (isObject(root)) {
    const value = root[key];
    if (isObject(value)) return value;
    return root;
  }
  return {};
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

function toSlot(raw: JsonObject): SlotRef {
  const id = entityId(raw, "pane");
  const groupId = slotGroupId(raw);
  if (!id || !groupId) throw new RuntimeFailure("Herdr pane response lacks pane/tab id");
  const label = entityLabel(raw);
  const cwd = slotCwd(raw);
  return {
    id,
    groupId,
    ...(label ? { label } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

function toWorker(raw: JsonObject): WorkerRef {
  const slotId = agentSlotId(raw);
  if (!slotId) throw new RuntimeFailure("Herdr agent response has no pane id");
  const name = agentName(raw);
  const state = agentState(raw);
  return {
    slotId,
    ...(name ? { name } : {}),
    ...(state ? { state } : {}),
  };
}

export class HerdrHost implements WorkerHost {
  readonly kind = "herdr";
  private readonly runner: CommandRunner;
  private readonly env: NodeJS.ProcessEnv;

  constructor(runner: CommandRunner, env: NodeJS.ProcessEnv = process.env) {
    this.runner = runner;
    this.env = env;
  }

  async detect(cwd: string, signal?: AbortSignal): Promise<HostDetection> {
    let available = false;
    try {
      const result = await this.runner.exec("herdr", ["--help"], {
        cwd,
        ...(signal ? { signal } : {}),
        timeout: 5_000,
      });
      available = result.code === 0;
    } catch {
      available = false;
    }
    const active = Boolean(this.env.HERDR_WORKSPACE_ID && this.env.HERDR_PANE_ID);
    return {
      backend: this.kind,
      available,
      active: available && active,
      ...(!available
        ? { reason: "herdr CLI is not available on PATH" }
        : !active
          ? { reason: "HERDR_WORKSPACE_ID/HERDR_PANE_ID are not set" }
          : {}),
    };
  }

  async currentContext(cwd: string): Promise<HostContext> {
    const scopeId = this.env.HERDR_WORKSPACE_ID;
    const leadSlotId = this.env.HERDR_PANE_ID;
    if (!scopeId || !leadSlotId) {
      throw new RuntimeFailure(
        "Herdr backend is not active: HERDR_WORKSPACE_ID/HERDR_PANE_ID are missing",
      );
    }
    return { backend: this.kind, scopeId, leadSlotId, cwd };
  }

  async findGroup(ctx: HostContext, label: string, signal?: AbortSignal): Promise<GroupRef | null> {
    const tabs = listResult(
      await this.runJson(["tab", "list", "--workspace", ctx.scopeId], ctx.cwd, signal),
      "tabs",
    );
    const matches = tabs.filter((tab) => entityLabel(tab) === label);
    if (matches.length > 1) {
      throw new RuntimeFailure(
        `multiple ${JSON.stringify(label)} tabs in ${ctx.scopeId}: ${JSON.stringify(
          matches.map((tab) => entityId(tab, "tab")),
        )}`,
      );
    }
    const match = matches[0];
    if (!match) return null;
    const id = entityId(match, "tab");
    if (!id) throw new RuntimeFailure(`Herdr tab ${JSON.stringify(label)} has no id`);
    return { id, label };
  }

  async createGroup(ctx: HostContext, label: string, signal?: AbortSignal): Promise<GroupCreation> {
    const root = unwrap(
      await this.runJson(
        [
          "tab",
          "create",
          "--workspace",
          ctx.scopeId,
          "--cwd",
          ctx.cwd,
          "--label",
          label,
          "--no-focus",
        ],
        ctx.cwd,
        signal,
      ),
    );
    if (!isObject(root)) throw new RuntimeFailure("unexpected Herdr tab-create response");
    const tab = root.tab;
    const pane = root.root_pane;
    if (!isObject(tab) || !isObject(pane)) {
      throw new RuntimeFailure("tab-create response lacks result.tab/result.root_pane");
    }
    const id = entityId(tab, "tab");
    const paneId = entityId(pane, "pane");
    if (!id) throw new RuntimeFailure("new Herdr tab has no id");
    if (!paneId) throw new RuntimeFailure("new Herdr root pane has no id");
    const initialSlot = await this.getSlot(ctx, paneId, signal);
    return { group: { id, label }, initialSlot };
  }

  async findSlot(
    ctx: HostContext,
    group: GroupRef,
    label: string,
    signal?: AbortSignal,
  ): Promise<SlotRef | null> {
    const slots = await this.slotsInGroup(ctx, group.id, signal);
    const matches = slots.filter((slot) => slot.label === label);
    if (matches.length > 1) {
      throw new RuntimeFailure(
        `multiple panes labeled ${JSON.stringify(label)}: ${JSON.stringify(matches.map((slot) => slot.id))}`,
      );
    }
    return matches[0] ?? null;
  }

  async createSlot(
    ctx: HostContext,
    group: GroupRef,
    label: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<SlotRef> {
    const slots = (await this.slotsInGroup(ctx, group.id, signal)).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const base = slots.at(-1);
    if (!base) throw new RuntimeFailure(`${group.label} has no pane available to split`);
    const direction = slots.length % 2 === 1 ? "right" : "down";
    const root = unwrap(
      await this.runJson(
        [
          "pane",
          "split",
          base.id,
          "--direction",
          direction,
          "--ratio",
          "0.5",
          "--cwd",
          cwd,
          "--no-focus",
        ],
        ctx.cwd,
        signal,
      ),
    );
    const pane = isObject(root) ? root.pane : undefined;
    if (!isObject(pane)) throw new RuntimeFailure("pane-split response lacks result.pane");
    const slot = toSlot(pane);
    return this.renameSlot(ctx, slot, label, signal);
  }

  async renameSlot(
    ctx: HostContext,
    slot: SlotRef,
    label: string,
    signal?: AbortSignal,
  ): Promise<SlotRef> {
    await this.runJson(["pane", "rename", slot.id, label], ctx.cwd, signal);
    return this.getSlot(ctx, slot.id, signal);
  }

  async getSlot(ctx: HostContext, slotId: string, signal?: AbortSignal): Promise<SlotRef> {
    const pane = objectResult(
      await this.runJson(["pane", "get", slotId], ctx.cwd, signal),
      "pane",
    );
    const scopeId = slotScopeId(pane);
    if (scopeId && scopeId !== ctx.scopeId) {
      throw new RuntimeFailure(
        `pane ${slotId} is in workspace ${scopeId}, expected ${ctx.scopeId}`,
      );
    }
    return toSlot(pane);
  }

  async inspectSlot(
    ctx: HostContext,
    slot: SlotRef,
    signal?: AbortSignal,
  ): Promise<SlotInspection> {
    const agent = await this.getAgentBySlot(ctx, slot.id, signal);
    if (agent) return { kind: "worker", worker: agent };

    const processInfo = objectResult(
      await this.runJson(["pane", "process-info", "--pane", slot.id], ctx.cwd, signal),
      "process_info",
    );
    const shellPid = processInfo.shell_pid;
    const foreground = processInfo.foreground_process_group_id;
    if (typeof shellPid === "number" && foreground === shellPid) return { kind: "shell" };
    return { kind: "busy", detail: JSON.stringify(processInfo) };
  }

  async waitUntilRunnable(
    ctx: HostContext,
    slot: SlotRef,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + SHELL_READY_TIMEOUT_MS;
    let last: SlotInspection | undefined;
    while (Date.now() < deadline) {
      last = await this.inspectSlot(ctx, slot, signal);
      if (last.kind === "shell") return;
      await sleep(POLL_MS, signal);
    }
    throw new RuntimeFailure(
      `managed pane ${slot.id} did not reach an available interactive shell within ` +
        `${Math.round(SHELL_READY_TIMEOUT_MS / 1000)}s; inspection=${JSON.stringify(last)}`,
    );
  }

  async findWorker(
    ctx: HostContext,
    name: string,
    signal?: AbortSignal,
  ): Promise<WorkerRef | null> {
    const agents = listResult(await this.runJson(["agent", "list"], ctx.cwd, signal), "agents");
    const matches = agents.filter((agent) => agentName(agent) === name);
    if (matches.length > 1) {
      throw new RuntimeFailure(`multiple live Herdr agents use managed name ${JSON.stringify(name)}`);
    }
    return matches[0] ? toWorker(matches[0]) : null;
  }

  async waitForWorker(
    ctx: HostContext,
    slot: SlotRef,
    signal?: AbortSignal,
  ): Promise<WorkerRef> {
    const deadline = Date.now() + WORKER_START_TIMEOUT_MS;
    let last: WorkerRef | null = null;
    while (Date.now() < deadline) {
      const current = await this.getAgentBySlot(ctx, slot.id, signal);
      if (current) {
        last = current;
        if (current.state && current.state !== "unknown") return current;
      }
      await sleep(POLL_MS, signal);
    }
    throw new RuntimeFailure(
      `Pi was detected in pane ${slot.id} but did not become ready within ` +
        `${Math.round(WORKER_START_TIMEOUT_MS / 1000)}s; last_worker=${JSON.stringify(last)}`,
    );
  }

  async renameWorker(
    ctx: HostContext,
    slot: SlotRef,
    name: string,
    signal?: AbortSignal,
  ): Promise<WorkerRef> {
    await this.runJson(["agent", "rename", slot.id, name], ctx.cwd, signal);
    const worker = await this.findWorker(ctx, name, signal);
    if (!worker) {
      throw new RuntimeFailure(
        `Pi became ready in pane ${slot.id} but Herdr could not resolve renamed agent ${JSON.stringify(name)}`,
      );
    }
    return worker;
  }

  async run(
    ctx: HostContext,
    slot: SlotRef,
    argv: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const command = argv.map(shellQuote).join(" ");
    await runChecked(this.runner, "herdr", ["pane", "run", slot.id, command], {
      cwd: ctx.cwd,
      ...(signal ? { signal } : {}),
      timeout: 10_000,
    });
  }

  private async slotsInGroup(
    ctx: HostContext,
    groupId: string,
    signal?: AbortSignal,
  ): Promise<SlotRef[]> {
    const panes = listResult(
      await this.runJson(["pane", "list", "--workspace", ctx.scopeId], ctx.cwd, signal),
      "panes",
    );
    const result: SlotRef[] = [];
    for (const pane of panes) {
      const id = entityId(pane, "pane");
      if (!id) continue;
      const resolved = slotGroupId(pane) ? pane : objectResult(
        await this.runJson(["pane", "get", id], ctx.cwd, signal),
        "pane",
      );
      if (slotGroupId(resolved) === groupId) result.push(toSlot(resolved));
    }
    return result;
  }

  private async getAgentBySlot(
    ctx: HostContext,
    slotId: string,
    signal?: AbortSignal,
  ): Promise<WorkerRef | null> {
    const result = await this.runner.exec("herdr", ["agent", "get", slotId], {
      cwd: ctx.cwd,
      ...(signal ? { signal } : {}),
      timeout: 5_000,
    });
    if (result.code !== 0 || !result.stdout.trim()) return null;
    try {
      return toWorker(objectResult(JSON.parse(result.stdout), "agent"));
    } catch {
      return null;
    }
  }

  private async runJson(
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const text = await runChecked(this.runner, "herdr", args, {
      cwd,
      ...(signal ? { signal } : {}),
      timeout: 30_000,
    });
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new RuntimeFailure(
        `Herdr returned non-JSON output for ${args.join(" ")}:\n${text}\n${String(error)}`,
      );
    }
  }
}

export const herdrInternals = {
  shellQuote,
  entityId,
  entityLabel,
  agentName,
  agentSlotId,
  slotGroupId,
  slotCwd,
  unwrap,
  listResult,
  objectResult,
};
