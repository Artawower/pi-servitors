import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { ROLES, type Role } from "../types.ts";

export const JOURNAL_ENTRY_TYPE = "pi-servitors:diagnostic-v1";
export const JOURNAL_LIMIT = 200;
export const PHASES = [
  "select_host", "wait_lock", "dependencies", "sync_profile", "resolve_lead",
  "resolve_group", "find_worker", "validate_worker", "resolve_slot", "wait_shell",
  "launch_command", "wait_worker", "rename_worker", "validate_location", "wait_link",
  "ready", "send_task", "wait_callback", "callback_received",
] as const;
export type FlowPhase = (typeof PHASES)[number];
export type FlowOutcome = "started" | "succeeded" | "failed" | "cancelled";
export type FlowContext = {
  cwd: string;
  role: Role | null;
  kind: "provision" | "delegation";
  slot?: string;
  target?: string;
  task_id?: string;
};
export type FlowEvent = FlowContext & {
  version: 1;
  run_id: string;
  at: number;
  phase: FlowPhase;
  outcome: FlowOutcome;
  source_sha256?: string;
  package_root?: string;
};
export type FlowProgress = FlowContext & {
  run_id: string;
  phase: FlowPhase;
  state: "running" | "unconfirmed" | "succeeded" | "failed" | "cancelled";
  started_at: number;
  phase_started_at: number;
  elapsed_ms: number;
  phase_elapsed_ms: number;
  last_event: FlowEvent;
  last_confirmed: FlowEvent | null;
};

function canonicalCwd(cwd: string): string {
  try { return realpathSync(cwd); } catch { return path.resolve(cwd); }
}

function parseEvent(raw: unknown): FlowEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || typeof value.run_id !== "string" || value.run_id.length > 128) return null;
  if (typeof value.cwd !== "string" || value.cwd.length > 4096) return null;
  if (value.kind !== "provision" && value.kind !== "delegation") return null;
  if (value.role !== null && !ROLES.includes(value.role as Role)) return null;
  if (!PHASES.includes(value.phase as FlowPhase)) return null;
  if (!["started", "succeeded", "failed", "cancelled"].includes(String(value.outcome))) return null;
  if (typeof value.at !== "number" || !Number.isFinite(value.at) || value.at < 0 || value.at > 8.64e15) return null;
  if (value.source_sha256 !== undefined && (typeof value.source_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.source_sha256))) return null;
  if (value.package_root !== undefined && (typeof value.package_root !== "string" || value.package_root.length > 4096)) return null;
  for (const key of ["slot", "target", "task_id"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > 256)) return null;
  }
  return {
    version: 1, run_id: value.run_id, cwd: value.cwd, kind: value.kind,
    role: value.role as Role | null, at: value.at,
    phase: value.phase as FlowPhase, outcome: value.outcome as FlowOutcome,
    ...(typeof value.slot === "string" ? { slot: value.slot } : {}),
    ...(typeof value.target === "string" ? { target: value.target } : {}),
    ...(typeof value.task_id === "string" ? { task_id: value.task_id } : {}),
    ...(typeof value.source_sha256 === "string" ? { source_sha256: value.source_sha256 } : {}),
    ...(typeof value.package_root === "string" ? { package_root: value.package_root } : {}),
  };
}

type RunRecord = { first: FlowEvent; last: FlowEvent; phase_start: FlowEvent; confirmed: FlowEvent | null };

function terminalEvent(event: FlowEvent): boolean {
  return event.outcome === "failed" || event.outcome === "cancelled" ||
    ((event.phase === "ready" || event.phase === "callback_received") && event.outcome === "succeeded");
}

export class FlowJournal {
  private events: FlowEvent[] = [];
  private readonly runs = new Map<string, RunRecord>();
  history_truncated = false;
  runs_truncated = false;
  private readonly liveRuns = new Set<string>();
  private origin: { package_root?: string; source_sha256?: string } = {};
  persistence_error = false;

  private readonly persist: ((event: FlowEvent) => void) | undefined;
  private readonly now: () => number;

  constructor(persist?: (event: FlowEvent) => void, now: () => number = Date.now) {
    this.persist = persist;
    this.now = now;
  }

  setOrigin(origin: { package_root: string; source_sha256: string | null }): void {
    this.origin = { package_root: origin.package_root, ...(origin.source_sha256 ? { source_sha256: origin.source_sha256 } : {}) };
  }

  start(context: FlowContext): string {
    const id = randomUUID();
    this.record(id, context, context.kind === "provision" ? "select_host" : "send_task", "started");
    return id;
  }

  record(id: string, context: FlowContext, phase: FlowPhase, outcome: FlowOutcome): void {
    const event = parseEvent({ ...context, ...this.origin, cwd: canonicalCwd(context.cwd), version: 1, run_id: id, at: this.now(), phase, outcome });
    if (!event) return;
    this.liveRuns.add(id);
    this.remember(event);
    try {
      this.persist?.(event);
    } catch {
      this.persistence_error = true;
    }
  }

  private remember(event: FlowEvent): void {
    this.events.push(event);
    if (this.events.length > JOURNAL_LIMIT) {
      this.events.shift();
      this.history_truncated = true;
    }
    const existing = this.runs.get(event.run_id);
    this.runs.set(event.run_id, {
      first: existing?.first ?? event, last: event,
      phase_start: !existing || existing.last.phase !== event.phase || event.outcome === "started" ? event : existing.phase_start,
      confirmed: event.outcome === "succeeded" ? event : existing?.confirmed ?? null,
    });
    if (this.runs.size <= JOURNAL_LIMIT) return;
    const expired = [...this.runs.entries()].find(([, run]) => terminalEvent(run.last)) ?? this.runs.entries().next().value;
    if (!expired) return;
    if (!terminalEvent(expired[1].last)) this.runs_truncated = true;
    this.runs.delete(expired[0]);
    this.liveRuns.delete(expired[0]);
  }

  async stage<T>(id: string, context: FlowContext, phase: FlowPhase, operation: () => Promise<T>): Promise<T> {
    this.record(id, context, phase, "started");
    try {
      const result = await operation();
      this.record(id, context, phase, "succeeded");
      return result;
    } catch (error) {
      this.record(id, context, phase, "failed");
      throw error;
    }
  }

  restore(entries: readonly unknown[]): void {
    this.clear();
    for (const raw of entries) {
      const event = parseEvent(raw);
      if (!event) continue;
      this.remember(event);
    }
  }

  clear(): void {
    this.events = [];
    this.runs.clear();
    this.liveRuns.clear();
    this.persistence_error = false;
    this.history_truncated = false;
    this.runs_truncated = false;
  }

  history(cwd?: string): FlowEvent[] {
    const resolved = cwd ? canonicalCwd(cwd) : null;
    return this.events.filter((event) => !resolved || event.cwd === resolved).map((event) => ({ ...event }));
  }

  progress(cwd?: string): FlowProgress[] {
    const resolved = cwd ? canonicalCwd(cwd) : null;
    return [...this.runs.entries()].filter(([, run]) => !resolved || run.last.cwd === resolved).map(([id, run]) => {
      const { first, last, phase_start: phaseStart, confirmed } = run;
      const terminal = terminalEvent(last);
      const end = terminal ? last.at : this.now();
      const state: FlowProgress["state"] = terminal
        ? last.outcome as "succeeded" | "failed" | "cancelled"
        : this.liveRuns.has(id) ? "running" : "unconfirmed";
      return {
        ...last, state, started_at: first.at, phase_started_at: phaseStart.at,
        elapsed_ms: Math.max(0, end - first.at), phase_elapsed_ms: Math.max(0, end - phaseStart.at),
        last_event: last, last_confirmed: confirmed,
      } as FlowProgress;
    });
  }

  taskSent(context: Omit<FlowContext, "kind">): void {
    const pending = this.progress(context.cwd).find((run) => run.kind === "delegation" &&
      run.task_id === context.task_id && (run.state === "running" || run.state === "unconfirmed"));
    const task = { ...context, kind: "delegation" as const };
    const id = pending?.run_id ?? this.start(task);
    this.record(id, task, "send_task", "succeeded");
    this.record(id, task, "wait_callback", "started");
  }

  taskSendFailed(context: Omit<FlowContext, "kind">): void {
    const task = { ...context, kind: "delegation" as const };
    const id = this.start(task);
    this.record(id, task, "send_task", "failed");
  }

  callbackReceived(taskId: string, cwd: string): void {
    const pending = this.progress(cwd).find((run) => run.kind === "delegation" &&
      run.task_id === taskId && run.phase === "wait_callback" &&
      (run.state === "running" || run.state === "unconfirmed"));
    if (pending) this.record(pending.run_id, pending, "callback_received", "succeeded");
  }
}
