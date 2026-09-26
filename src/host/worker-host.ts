import type {
  GroupCreation,
  GroupRef,
  HostContext,
  HostDetection,
  SlotInspection,
  SlotRef,
  WorkerRef,
} from "../types.ts";

export interface WorkerHost {
  readonly kind: string;

  detect(cwd: string, signal?: AbortSignal): Promise<HostDetection>;
  currentContext(cwd: string, signal?: AbortSignal): Promise<HostContext>;

  findGroup(ctx: HostContext, label: string, signal?: AbortSignal): Promise<GroupRef | null>;
  createGroup(ctx: HostContext, label: string, signal?: AbortSignal): Promise<GroupCreation>;

  findSlot(
    ctx: HostContext,
    group: GroupRef,
    label: string,
    signal?: AbortSignal,
  ): Promise<SlotRef | null>;
  createSlot(
    ctx: HostContext,
    group: GroupRef,
    label: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<SlotRef>;
  renameSlot(ctx: HostContext, slot: SlotRef, label: string, signal?: AbortSignal): Promise<SlotRef>;
  getSlot(ctx: HostContext, slotId: string, signal?: AbortSignal): Promise<SlotRef>;
  inspectSlot(ctx: HostContext, slot: SlotRef, signal?: AbortSignal): Promise<SlotInspection>;
  waitUntilRunnable(ctx: HostContext, slot: SlotRef, signal?: AbortSignal): Promise<void>;

  findWorker(ctx: HostContext, name: string, signal?: AbortSignal): Promise<WorkerRef | null>;
  waitForWorker(ctx: HostContext, slot: SlotRef, signal?: AbortSignal): Promise<WorkerRef>;
  renameWorker(
    ctx: HostContext,
    slot: SlotRef,
    name: string,
    signal?: AbortSignal,
  ): Promise<WorkerRef>;

  run(
    ctx: HostContext,
    slot: SlotRef,
    argv: readonly string[],
    signal?: AbortSignal,
  ): Promise<void>;
}
