import { realpath } from "node:fs/promises";
import path from "node:path";
import { GROUP_LABEL, ROLE_CONFIG } from "../config.ts";
import { RuntimeFailure } from "../errors.ts";
import type { WorkerHost } from "../host/worker-host.ts";
import { PiLinkStatusClient } from "../link/pi-link-status.ts";
import type {
  DoctorResult,
  GroupRef,
  HostDetection,
  LeadLink,
  LinkConnection,
  LinkSnapshot,
  ReadyResult,
  Role,
  RuntimeContext,
  RuntimeStatusResult,
  SlotRef,
  WorkerRef,
} from "../types.ts";
import { RuntimeDependencies } from "./dependencies.ts";
import type { LinkStatusProvider, RuntimeMutex, WorkerDependencySet, WorkerProfileStore } from "./contracts.ts";
import {
  buildRuntimeContext,
  inferLeadLink,
  linkTarget,
  runtimeName,
  slotLabel,
  wrongGroupTargets,
} from "./identity.ts";
import { RuntimeLock } from "./lock.ts";
import { ProfileStore } from "./profiles.ts";

export type WorkerRuntimeOptions = {
  hosts: WorkerHost[];
  link?: LinkStatusProvider;
  profiles?: WorkerProfileStore;
  dependencies?: WorkerDependencySet;
  lock?: RuntimeMutex;
  backendPreference?: string;
};

type SelectedHost = {
  host: WorkerHost;
  detection: HostDetection;
  ctx: RuntimeContext;
};

export class WorkerRuntime {
  private readonly hosts: WorkerHost[];
  private readonly link: LinkStatusProvider;
  private readonly profiles: WorkerProfileStore;
  private readonly dependencies: WorkerDependencySet;
  private readonly lock: RuntimeMutex;
  private readonly backendPreference: string | undefined;

  constructor(options: WorkerRuntimeOptions) {
    this.hosts = options.hosts;
    this.link = options.link ?? new PiLinkStatusClient();
    this.profiles = options.profiles ?? new ProfileStore();
    this.dependencies = options.dependencies ?? new RuntimeDependencies();
    this.lock = options.lock ?? new RuntimeLock();
    this.backendPreference = options.backendPreference;
  }

  async ensureRole(cwd: string, role: Role, signal?: AbortSignal): Promise<ReadyResult> {
    const selected = await this.selectHost(cwd, signal);
    const { host, ctx } = selected;
    const lockKey = `${ctx.host.backend}-${ctx.host.scopeId}-${ctx.scopeHash}`;

    return this.lock.withLock(lockKey, signal, async () => {
      await this.dependencies.assertAvailable();
      await this.profiles.sync(role);

      const linkSnapshot = await this.link.snapshot();
      const lead = inferLeadLink(ctx, linkSnapshot);
      const target = linkTarget(ctx, role, lead.name);
      const name = runtimeName(ctx, role);

      let group = await host.findGroup(ctx.host, GROUP_LABEL, signal);
      let createdRoot: SlotRef | null = null;
      if (!group) {
        const created = await host.createGroup(ctx.host, GROUP_LABEL, signal);
        group = created.group;
        createdRoot = created.initialSlot;
      }

      const existingWorker = await host.findWorker(ctx.host, name, signal);
      if (existingWorker) {
        const slot = await this.validateWorkerLocation(host, ctx, group, name, existingWorker, signal);
        const link = await this.link.waitFor(target, {
          timeoutMs: 3_000,
          ...(signal ? { signal } : {}),
        });
        if (link.connected === false) {
          const wrong = wrongGroupTargets(ctx, role, await this.link.snapshot());
          const detail = wrong.length ? ` Connected variants: ${JSON.stringify(wrong)}.` : "";
          throw new RuntimeFailure(
            `managed worker ${JSON.stringify(name)} is live in the correct slot but expected ` +
              `pi-link target ${JSON.stringify(target)} is not connected.${detail} Do not create ` +
              "a duplicate; restart/reconnect this same worker in the Lead's group.",
          );
        }
        return readyPayload(ctx, role, name, target, lead, group, slot, true, link, this.dependencies);
      }

      const preflightLink = this.link.connection(target, linkSnapshot);
      if (preflightLink.connected === true) {
        throw new RuntimeFailure(
          `pi-link target ${JSON.stringify(target)} is already connected but ${host.kind} has no ` +
            "matching managed worker. Refusing split-brain duplicate creation.",
        );
      }

      const wrong = wrongGroupTargets(ctx, role, linkSnapshot);
      if (wrong.length) {
        throw new RuntimeFailure(
          `managed link identity for ${role} already exists in another pi-link group: ` +
            `${JSON.stringify(wrong)}; expected ${JSON.stringify(target)}. Stop/reconnect that ` +
            "stale worker before retrying.",
        );
      }

      const slot = await this.ensureRoleSlot(host, ctx, group, role, createdRoot, signal);
      this.assertSlotCwd(slot, ctx.host.cwd);

      await host.waitUntilRunnable(ctx.host, slot, signal);
      await host.run(
        ctx.host,
        slot,
        ["pi", ...this.dependencies.buildPiArgs(role, target, ctx.host.cwd)],
        signal,
      );
      await host.waitForWorker(ctx.host, slot, signal);
      const worker = await host.renameWorker(ctx.host, slot, name, signal);
      const validatedSlot = await this.validateWorkerLocation(
        host,
        ctx,
        group,
        name,
        worker,
        signal,
      );

      const link = await this.link.waitFor(target, signal ? { signal } : {});
      if (link.connected === false) {
        throw new RuntimeFailure(
          `managed worker ${JSON.stringify(name)} started in ${host.kind} but pi-link target ` +
            `${JSON.stringify(target)} did not connect. The process was left intact for ` +
            "diagnosis; do not create another slot.",
        );
      }

      return readyPayload(
        ctx,
        role,
        name,
        target,
        lead,
        group,
        validatedSlot,
        false,
        link,
        this.dependencies,
      );
    });
  }

  async status(cwd: string, signal?: AbortSignal): Promise<RuntimeStatusResult> {
    const { host, ctx } = await this.selectHost(cwd, signal);
    const linkSnapshot = await this.link.snapshot();
    let lead: LeadLink | null = null;
    let leadError: string | null = null;
    try {
      lead = inferLeadLink(ctx, linkSnapshot);
    } catch (error) {
      leadError = error instanceof Error ? error.message : String(error);
    }

    const group = await host.findGroup(ctx.host, GROUP_LABEL, signal);
    if (!group) {
      return {
        status: "ok",
        backend: host.kind,
        scope: ctx.host.scopeId,
        cwd: ctx.host.cwd,
        lead_link: lead,
        lead_link_error: leadError,
        roles: [],
      };
    }

    const connected = this.link.names(linkSnapshot);
    const roles: Array<Record<string, unknown>> = [];
    for (const role of ["coder", "reviewer", "researcher-code"] as const) {
      const name = runtimeName(ctx, role);
      const target = lead ? linkTarget(ctx, role, lead.name) : null;
      const worker = await host.findWorker(ctx.host, name, signal);
      const slot = await host.findSlot(ctx.host, group, slotLabel(ctx, role), signal);
      roles.push({
        role,
        state: worker?.state ?? (slot ? "stopped" : "absent"),
        runtime_name: name,
        link_target: target,
        link_connected:
          target && linkSnapshot.supported === true ? connected.has(target) : null,
        slot: worker?.slotId ?? slot?.id ?? null,
        profile: ROLE_CONFIG[role].profile,
      });
    }

    return {
      status: "ok",
      backend: host.kind,
      scope: ctx.host.scopeId,
      group: group.id,
      cwd: ctx.host.cwd,
      lead_link: lead,
      lead_link_error: leadError,
      roles,
      link_status: {
        supported: linkSnapshot.supported,
        reachable: linkSnapshot.reachable,
        reason: linkSnapshot.reason,
        verifier: "http://127.0.0.1:9900/status",
      },
    };
  }

  async doctor(cwd: string, signal?: AbortSignal): Promise<DoctorResult> {
    const detections = await Promise.all(this.hosts.map((host) => host.detect(cwd, signal)));
    const dependencyStatus = await this.dependencies.status();
    const profileStatus = await this.profiles.status();
    const linkSnapshot = await this.link.snapshot();

    let selected: SelectedHost | null = null;
    let selectionError: string | null = null;
    try {
      selected = await this.selectHost(cwd, signal, detections);
    } catch (error) {
      selectionError = error instanceof Error ? error.message : String(error);
    }

    let lead: LeadLink | null = null;
    let leadError: string | null = selectionError;
    if (selected) {
      try {
        lead = inferLeadLink(selected.ctx, linkSnapshot);
        leadError = null;
      } catch (error) {
        leadError = error instanceof Error ? error.message : String(error);
      }
    }

    const dependenciesOk = dependencyStatus.every((item) => item.exists);
    const profilesOk = profileStatus.every((item) => item.source_exists === true);
    const healthy = Boolean(selected && lead && dependenciesOk && profilesOk);

    return {
      status: "ok",
      healthy,
      cwd: path.resolve(cwd),
      selected_backend: selected?.host.kind ?? null,
      host_backends: detections,
      transport: "pi-link/link_send",
      lead_link: lead,
      lead_link_error: leadError,
      pi_link_status: {
        supported: linkSnapshot.supported,
        reachable: linkSnapshot.reachable,
        reason: linkSnapshot.reason,
        connected_terminals: [...this.link.names(linkSnapshot)].sort(),
        verifier: "http://127.0.0.1:9900/status",
        note:
          "pi-servitors requires pi-link 0.5-style /status so it can inherit the Lead " +
          "group deterministically. Normal worker communication is link_send only.",
      },
      dependencies: dependencyStatus,
      profiles: profileStatus,
    };
  }

  private async selectHost(
    cwd: string,
    signal?: AbortSignal,
    knownDetections?: HostDetection[],
  ): Promise<SelectedHost> {
    const detections = knownDetections ??
      (await Promise.all(this.hosts.map((host) => host.detect(cwd, signal))));

    const candidates = this.hosts.filter((host, index) => {
      const detection = detections[index];
      if (!detection?.active) return false;
      return !this.backendPreference || host.kind === this.backendPreference;
    });

    if (this.backendPreference && candidates.length === 0) {
      throw new RuntimeFailure(
        `requested worker host backend ${JSON.stringify(this.backendPreference)} is not active`,
      );
    }
    if (candidates.length === 0) {
      const summary = detections
        .map((item) => `${item.backend}: ${item.reason ?? (item.available ? "not active" : "unavailable")}`)
        .join("; ");
      throw new RuntimeFailure(
        `no supported worker host backend is active${summary ? ` (${summary})` : ""}`,
      );
    }
    if (candidates.length > 1) {
      throw new RuntimeFailure(
        `multiple worker host backends are active: ${candidates.map((host) => host.kind).join(", ")}. ` +
          "Select one explicitly before provisioning workers.",
      );
    }

    const host = candidates[0];
    if (!host) throw new RuntimeFailure("internal error: selected host disappeared");
    const resolvedCwd = await realpath(cwd).catch(() => path.resolve(cwd));
    const hostContext = await host.currentContext(resolvedCwd, signal);
    return {
      host,
      detection: detections.find((item) => item.backend === host.kind) ?? {
        backend: host.kind,
        available: true,
        active: true,
      },
      ctx: buildRuntimeContext(hostContext),
    };
  }

  private async ensureRoleSlot(
    host: WorkerHost,
    ctx: RuntimeContext,
    group: GroupRef,
    role: Role,
    createdRoot: SlotRef | null,
    signal?: AbortSignal,
  ): Promise<SlotRef> {
    const label = slotLabel(ctx, role);
    const existing = await host.findSlot(ctx.host, group, label, signal);
    if (existing) {
      const inspection = await host.inspectSlot(ctx.host, existing, signal);
      if (inspection.kind === "worker") {
        throw new RuntimeFailure(
          `managed role slot ${existing.id} is occupied by worker ` +
            `${JSON.stringify(inspection.worker.name ?? "unknown")}; refusing adoption`,
        );
      }
      if (inspection.kind === "busy") {
        throw new RuntimeFailure(
          `managed role slot ${existing.id} is occupied by an unrelated process; refusing adoption` +
            (inspection.detail ? ` (${inspection.detail})` : ""),
        );
      }
      return host.getSlot(ctx.host, existing.id, signal);
    }

    if (createdRoot) {
      return host.renameSlot(ctx.host, createdRoot, label, signal);
    }
    return host.createSlot(ctx.host, group, label, ctx.host.cwd, signal);
  }

  private async validateWorkerLocation(
    host: WorkerHost,
    ctx: RuntimeContext,
    group: GroupRef,
    expectedName: string,
    worker: WorkerRef,
    signal?: AbortSignal,
  ): Promise<SlotRef> {
    if (worker.name && worker.name !== expectedName) {
      throw new RuntimeFailure(
        `managed worker identity is ${JSON.stringify(worker.name)}, expected ${JSON.stringify(expectedName)}`,
      );
    }
    const slot = await host.getSlot(ctx.host, worker.slotId, signal);
    if (slot.groupId !== group.id) {
      throw new RuntimeFailure(
        `managed worker ${JSON.stringify(expectedName)} is in group ${slot.groupId}, expected ${group.id}`,
      );
    }
    this.assertSlotCwd(slot, ctx.host.cwd);
    return slot;
  }

  private assertSlotCwd(slot: SlotRef, expected: string): void {
    if (!slot.cwd) {
      throw new RuntimeFailure(`cannot verify cwd for managed slot ${slot.id}`);
    }
    if (path.resolve(slot.cwd) !== path.resolve(expected)) {
      throw new RuntimeFailure(`managed slot ${slot.id} cwd is ${slot.cwd}, expected ${expected}`);
    }
  }
}

export function readyPayload(
  ctx: RuntimeContext,
  role: Role,
  name: string,
  target: string,
  lead: LeadLink,
  group: GroupRef,
  slot: SlotRef,
  reused: boolean,
  link: LinkConnection,
  dependencies: WorkerDependencySet,
): ReadyResult {
  return {
    status: "ready",
    role,
    runtime_name: name,
    link_target: target,
    lead_link_name: lead.name,
    link_group: lead.group,
    transport: "pi-link/link_send",
    reused,
    backend: ctx.host.backend,
    scope: ctx.host.scopeId,
    group: group.id,
    slot: slot.id,
    cwd: ctx.host.cwd,
    profile: ROLE_CONFIG[role].profile,
    harness: dependencies.buildPiArgs(role, target, ctx.host.cwd),
    link,
  };
}
