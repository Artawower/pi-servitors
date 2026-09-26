import type { Role } from "../types.ts";

export type DelegationStart = {
  taskId: string;
  target: string;
  role: Role | null;
};

export type ActiveDelegation = DelegationStart & {
  startedAt: number;
};

export type DelegationSnapshot = ActiveDelegation & {
  elapsedMs: number;
};

export type CompletedDelegation = ActiveDelegation & {
  completedAt: number;
  elapsedMs: number;
};

export class DelegationTracker {
  private readonly activeByTask = new Map<string, ActiveDelegation>();

  start(input: DelegationStart, now = Date.now()): ActiveDelegation {
    const existing = this.activeByTask.get(input.taskId);
    const delegation: ActiveDelegation = existing
      ? { ...existing, target: input.target, role: input.role ?? existing.role }
      : { ...input, startedAt: now };

    this.activeByTask.set(input.taskId, delegation);
    return delegation;
  }

  complete(taskId: string, now = Date.now()): CompletedDelegation | null {
    const active = this.activeByTask.get(taskId);
    if (!active) return null;

    this.activeByTask.delete(taskId);
    return {
      ...active,
      completedAt: now,
      elapsedMs: Math.max(0, now - active.startedAt),
    };
  }

  snapshot(now = Date.now()): DelegationSnapshot[] {
    return [...this.activeByTask.values()]
      .map((item) => ({
        ...item,
        elapsedMs: Math.max(0, now - item.startedAt),
      }))
      .sort((a, b) => a.startedAt - b.startedAt || a.taskId.localeCompare(b.taskId));
  }

  clear(): void {
    this.activeByTask.clear();
  }
}
