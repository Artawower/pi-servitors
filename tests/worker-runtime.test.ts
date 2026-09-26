import assert from "node:assert/strict";
import test from "node:test";
import type { WorkerHost } from "../src/host/worker-host.ts";
import type {
  LinkStatusProvider,
  RuntimeMutex,
  WorkerDependencySet,
  WorkerProfileStore,
} from "../src/runtime/contracts.ts";
import { WorkerRuntime } from "../src/runtime/worker-runtime.ts";
import type {
  GroupCreation,
  GroupRef,
  HostContext,
  HostDetection,
  LinkConnection,
  LinkSnapshot,
  Role,
  SlotInspection,
  SlotRef,
  WorkerRef,
} from "../src/types.ts";

class ImmediateLock implements RuntimeMutex {
  async withLock<T>(_key: string, _signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

class FakeProfiles implements WorkerProfileStore {
  synced: Role[] = [];
  async sync(role: Role): Promise<string> {
    this.synced.push(role);
    return `/profiles/${role}.md`;
  }
  async status(): Promise<Array<Record<string, unknown>>> {
    return [
      { role: "coder", source_exists: true },
      { role: "reviewer", source_exists: true },
      { role: "researcher-code", source_exists: true },
    ];
  }
}

class FakeDependencies implements WorkerDependencySet {
  assertCount = 0;
  async assertAvailable(): Promise<void> {
    this.assertCount += 1;
  }
  async status(): Promise<Array<Record<string, unknown> & { exists: boolean }>> {
    return [
      { name: "pi-link", exists: true },
      { name: "pi-open-agents", exists: true },
    ];
  }
  buildPiArgs(role: Role, linkName: string): string[] {
    return ["-ne", "-e", "/deps/open-agents.ts", "-e", "/deps/link.ts", "--agent", `profile-${role}`, "--link-name", linkName];
  }
}

class FakeLink implements LinkStatusProvider {
  readonly snapshotValue: LinkSnapshot = {
    supported: true,
    reachable: true,
    reason: null,
    terminals: [{ name: "lead@team", cwd: "/tmp/test-swarm" }],
  };
  waits: string[] = [];

  async snapshot(): Promise<LinkSnapshot> {
    return this.snapshotValue;
  }
  names(snapshot: LinkSnapshot): Set<string> {
    return new Set(snapshot.terminals.map((item) => item.name));
  }
  connection(name: string, snapshot: LinkSnapshot): LinkConnection {
    return {
      connected: snapshot.terminals.some((item) => item.name === name),
      verifier: "fake",
      status_supported: true,
      status_reachable: true,
      reason: null,
    };
  }
  async waitFor(name: string): Promise<LinkConnection> {
    this.waits.push(name);
    return {
      connected: true,
      verifier: "fake",
      status_supported: true,
      status_reachable: true,
      reason: null,
    };
  }
}

class FakeHost implements WorkerHost {
  readonly kind = "herdr";
  group: GroupRef | null = null;
  slot: SlotRef = {
    id: "slot-1",
    groupId: "group-1",
    label: "",
    cwd: "/tmp/test-swarm",
  };
  worker: WorkerRef | null = null;
  runCalls: string[][] = [];
  renameWorkerCalls: string[] = [];
  createdGroups = 0;
  createdSlots = 0;

  async detect(): Promise<HostDetection> {
    return { backend: this.kind, available: true, active: true };
  }
  async currentContext(cwd: string): Promise<HostContext> {
    return { backend: this.kind, scopeId: "scope-1", leadSlotId: "lead-slot", cwd };
  }
  async findGroup(): Promise<GroupRef | null> {
    return this.group;
  }
  async createGroup(_ctx: HostContext, label: string): Promise<GroupCreation> {
    this.createdGroups += 1;
    this.group = { id: "group-1", label };
    return { group: this.group, initialSlot: this.slot };
  }
  async findSlot(_ctx: HostContext, _group: GroupRef, label: string): Promise<SlotRef | null> {
    return this.slot.label === label ? this.slot : null;
  }
  async createSlot(_ctx: HostContext, group: GroupRef, label: string, cwd: string): Promise<SlotRef> {
    this.createdSlots += 1;
    this.slot = { id: "slot-2", groupId: group.id, label, cwd };
    return this.slot;
  }
  async renameSlot(_ctx: HostContext, slot: SlotRef, label: string): Promise<SlotRef> {
    this.slot = { ...slot, label };
    return this.slot;
  }
  async getSlot(): Promise<SlotRef> {
    return this.slot;
  }
  async inspectSlot(): Promise<SlotInspection> {
    return this.worker ? { kind: "worker", worker: this.worker } : { kind: "shell" };
  }
  async waitUntilRunnable(): Promise<void> {}
  async findWorker(_ctx: HostContext, name: string): Promise<WorkerRef | null> {
    return this.worker?.name === name ? this.worker : null;
  }
  async waitForWorker(): Promise<WorkerRef> {
    this.worker = { name: "temporary", slotId: this.slot.id, state: "idle" };
    return this.worker;
  }
  async renameWorker(_ctx: HostContext, slot: SlotRef, name: string): Promise<WorkerRef> {
    this.renameWorkerCalls.push(name);
    this.worker = { name, slotId: slot.id, state: "idle" };
    return this.worker;
  }
  async run(_ctx: HostContext, _slot: SlotRef, argv: readonly string[]): Promise<void> {
    this.runCalls.push([...argv]);
  }
}

function setup(host = new FakeHost()) {
  const link = new FakeLink();
  const profiles = new FakeProfiles();
  const dependencies = new FakeDependencies();
  const runtime = new WorkerRuntime({
    hosts: [host],
    link,
    profiles,
    dependencies,
    lock: new ImmediateLock(),
  });
  return { runtime, host, link, profiles, dependencies };
}

test("ensureRole provisions through WorkerHost and returns event-driven routing identities", async () => {
  const { runtime, host, link, profiles, dependencies } = setup();
  const result = await runtime.ensureRole("/tmp/test-swarm", "coder");

  assert.equal(result.status, "ready");
  assert.equal(result.reused, false);
  assert.equal(result.backend, "herdr");
  assert.equal(result.lead_link_name, "lead@team");
  assert.match(result.link_target, /^psv-test-swarm-[a-f0-9]{6}-coder@team$/);
  assert.equal(result.slot, "slot-1");
  assert.equal(host.createdGroups, 1);
  assert.equal(host.createdSlots, 0);
  assert.equal(host.runCalls.length, 1);
  assert.deepEqual(host.runCalls[0]?.slice(0, 2), ["pi", "-ne"]);
  assert.equal(host.runCalls[0]?.includes("antigravity"), false);
  assert.deepEqual(profiles.synced, ["coder"]);
  assert.equal(dependencies.assertCount, 1);
  assert.deepEqual(link.waits, [result.link_target]);
});

test("ensureRole reuses an exact managed worker without launching another process", async () => {
  const host = new FakeHost();
  host.group = { id: "group-1", label: "AI SERVITORS" };
  const first = setup(host);
  const created = await first.runtime.ensureRole("/tmp/test-swarm", "coder");

  host.runCalls = [];
  const second = setup(host);
  const reused = await second.runtime.ensureRole("/tmp/test-swarm", "coder");

  assert.equal(reused.runtime_name, created.runtime_name);
  assert.equal(reused.reused, true);
  assert.equal(host.runCalls.length, 0);
  assert.equal(host.createdGroups, 0);
});

test("doctor reports backend, bundled dependencies, profiles, and Lead connectivity", async () => {
  const { runtime } = setup();
  const result = await runtime.doctor("/tmp/test-swarm");
  assert.equal(result.healthy, true);
  assert.equal(result.selected_backend, "herdr");
  assert.equal(result.lead_link?.name, "lead@team");
  assert.equal(result.dependencies.every((item) => item.exists === true), true);
});
