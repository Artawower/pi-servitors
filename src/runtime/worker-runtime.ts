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
import { FlowJournal, JOURNAL_LIMIT, type FlowContext, type FlowPhase } from "../diagnostics/journal.ts";
import { assessProgress, assessWorkers, currentProgress } from "../diagnostics/assessment.ts";
import { captureProvenance } from "../diagnostics/provenance.ts";
import type { RuntimeDiagnostics, RuntimeRoleStatus } from "../types.ts";

export type WorkerRuntimeOptions = {
  hosts: WorkerHost[];
  link?: LinkStatusProvider;
  profiles?: WorkerProfileStore;
  dependencies?: WorkerDependencySet;
  lock?: RuntimeMutex;
  backendPreference?: string;
  journal?: FlowJournal;
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
  readonly journal: FlowJournal;
  private readonly provenance = captureProvenance();

  constructor(options: WorkerRuntimeOptions) {
    this.hosts = options.hosts;
    this.link = options.link ?? new PiLinkStatusClient();
    this.profiles = options.profiles ?? new ProfileStore();
    this.dependencies = options.dependencies ?? new RuntimeDependencies();
    this.lock = options.lock ?? new RuntimeLock();
    this.backendPreference = options.backendPreference;
    this.journal = options.journal ?? new FlowJournal();
    this.journal.setOrigin(this.provenance);
  }

  async ensureRole(cwd: string, role: Role, signal?: AbortSignal): Promise<ReadyResult> {
    const flow: FlowContext = { cwd: path.resolve(cwd), role, kind: "provision" };
    const id = this.journal.start(flow);
    let phase: FlowPhase = "select_host";
    const stage = <T>(next: FlowPhase, operation: () => Promise<T>): Promise<T> => {
      phase = next;
      return this.journal.stage(id, flow, next, operation);
    };
    try {
      const { host, ctx } = await stage("select_host", () => this.selectHost(cwd, signal));
      flow.cwd = ctx.host.cwd;
      const lockKey = `${ctx.host.backend}-${ctx.host.scopeId}-${ctx.scopeHash}`;
      phase = "wait_lock";
      this.journal.record(id, flow, phase, "started");
      return await this.lock.withLock(lockKey, signal, async () => {
        this.journal.record(id, flow, "wait_lock", "succeeded");
        await stage("dependencies", () => this.dependencies.assertAvailable());
        await stage("sync_profile", () => this.profiles.sync(role));
        const { linkSnapshot, lead } = await stage("resolve_lead", async () => {
          const linkSnapshot = await this.link.snapshot();
          return { linkSnapshot, lead: inferLeadLink(ctx, linkSnapshot) };
        });
        const target = linkTarget(ctx, role, lead.name);
        const name = runtimeName(ctx, role);
        flow.target = target;
        let createdRoot: SlotRef | null = null;
        const group = await stage("resolve_group", async () => {
          const existing = await host.findGroup(ctx.host, GROUP_LABEL, signal);
          if (existing) return existing;
          const created = await host.createGroup(ctx.host, GROUP_LABEL, signal);
          createdRoot = created.initialSlot;
          return created.group;
        });
        const existingWorker = await stage("find_worker", () => host.findWorker(ctx.host, name, signal));
        if (existingWorker) {
          flow.slot = existingWorker.slotId;
          const slot = await stage("validate_worker", () =>
            this.validateWorkerLocation(host, ctx, group, name, existingWorker, signal));
          const link = await stage("wait_link", async () => {
            const link = await this.link.waitFor(target, { timeoutMs: 3_000, ...(signal ? { signal } : {}) });
            if (link.connected === false) {
              const wrong = wrongGroupTargets(ctx, role, await this.link.snapshot());
              const detail = wrong.length ? ` Connected variants: ${JSON.stringify(wrong)}.` : "";
              throw new RuntimeFailure(
                `managed worker ${JSON.stringify(name)} is live in the correct slot but expected ` +
                `pi-link target ${JSON.stringify(target)} is not connected.${detail} Do not create ` +
                "a duplicate; restart/reconnect this same worker in the Lead's group.",
              );
            }
            return link;
          });
          this.journal.record(id, flow, "ready", "succeeded");
          return readyPayload(ctx, role, name, target, lead, group, slot, true, link, this.dependencies);
        }
        if (this.link.connection(target, linkSnapshot).connected === true) {
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
        const slot = await stage("resolve_slot", () => this.ensureRoleSlot(host, ctx, group, role, createdRoot, signal));
        flow.slot = slot.id;
        this.assertSlotCwd(slot, ctx.host.cwd);
        await stage("wait_shell", () => host.waitUntilRunnable(ctx.host, slot, signal));
        await stage("launch_command", () => host.run(
          ctx.host, slot, ["pi", ...this.dependencies.buildPiArgs(role, target, ctx.host.cwd)], signal,
        ));
        await stage("wait_worker", () => host.waitForWorker(ctx.host, slot, signal));
        const worker = await stage("rename_worker", () => host.renameWorker(ctx.host, slot, name, signal));
        const validatedSlot = await stage("validate_location", () =>
          this.validateWorkerLocation(host, ctx, group, name, worker, signal));
        const link = await stage("wait_link", async () => {
          const link = await this.link.waitFor(target, signal ? { signal } : {});
          if (link.connected === false) {
            throw new RuntimeFailure(
              `managed worker ${JSON.stringify(name)} started in ${host.kind} but pi-link target ` +
              `${JSON.stringify(target)} did not connect. The process was left intact for ` +
              "diagnosis; do not create another slot.",
            );
          }
          return link;
        });
        this.journal.record(id, flow, "ready", "succeeded");
        return readyPayload(ctx, role, name, target, lead, group, validatedSlot, false, link, this.dependencies);
      });
    } catch (error) {
      this.journal.record(id, flow, phase, signal?.aborted ? "cancelled" : "failed");
      throw error;
    }
  }

  getDiagnostics(cwd: string): RuntimeDiagnostics {
    const runs = this.journal.progress(path.resolve(cwd));
    return {
      provenance: this.provenance,
      configuration: this.dependencies.configuration?.(cwd) ?? null,
      runs, recent_events: this.journal.history(path.resolve(cwd)),
      findings: assessProgress(currentProgress(runs)), persistence_error: this.journal.persistence_error,
      history_limit: JOURNAL_LIMIT,
      history_truncated: this.journal.history_truncated,
      runs_truncated: this.journal.runs_truncated,
    };
  }

  private async readWorkerRoles(
    selected: SelectedHost, group: GroupRef, lead: LeadLink | null,
    snapshot: LinkSnapshot, diagnostics: RuntimeDiagnostics, signal?: AbortSignal,
  ): Promise<RuntimeRoleStatus[]> {
    const { host, ctx } = selected;
    const connected = this.link.names(snapshot);
    const roles: RuntimeRoleStatus[] = [];
    for (const role of ["coder", "reviewer", "researcher-code"] as const) {
      const name = runtimeName(ctx, role);
      const target = lead ? linkTarget(ctx, role, lead.name) : null;
      const worker = await host.findWorker(ctx.host, name, signal);
      const slot = await host.findSlot(ctx.host, group, slotLabel(ctx, role), signal);
      roles.push({
        role, state: worker ? worker.state ?? "unknown" : slot ? "not_detected" : "absent",
        runtime_name: name, link_target: target,
        link_connected: target && snapshot.supported === true && snapshot.reachable ? connected.has(target) : null,
        slot: worker?.slotId ?? slot?.id ?? null, expected_slot: slot?.id ?? null,
        profile: ROLE_CONFIG[role].profile,
        progress: diagnostics.runs.filter((run) => run.kind === "provision" && run.role === role).at(-1) ?? null,
        tasks: diagnostics.runs.filter((run) => run.kind === "delegation" &&
          (run.role === role || run.target === target) && run.state !== "succeeded"),
      });
    }
    return roles;
  }

  async status(cwd: string, signal?: AbortSignal): Promise<RuntimeStatusResult> {
    let selected: SelectedHost;
    try {
      selected = await this.selectHost(cwd, signal);
    } catch (error) {
      signal?.throwIfAborted();
      return {
        status: "ok", cwd: path.resolve(cwd), lead_link: null,
        lead_link_error: error instanceof Error ? error.message : String(error), roles: [],
        diagnostics: this.getDiagnostics(cwd),
      };
    }
    const { host, ctx } = selected;
    const diagnostics = this.getDiagnostics(ctx.host.cwd);
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
        diagnostics,
      };
    }

    const roles = await this.readWorkerRoles(selected, group, lead, linkSnapshot, diagnostics, signal);

    return {
      status: "ok",
      backend: host.kind,
      scope: ctx.host.scopeId,
      group: group.id,
      cwd: ctx.host.cwd,
      lead_link: lead,
      lead_link_error: leadError,
      roles,
      diagnostics,
      link_status: {
        supported: linkSnapshot.supported,
        reachable: linkSnapshot.reachable,
        reason: linkSnapshot.reason,
        verifier: "http://127.0.0.1:9900/status",
      },
    };
  }

  async doctor(cwd: string, signal?: AbortSignal): Promise<DoctorResult> {
    signal?.throwIfAborted();
    const detections = await Promise.all(this.hosts.map((host) => host.detect(cwd, signal)));
    const dependencyStatus = await this.dependencies.status();
    const profileStatus = await this.profiles.status();
    const linkSnapshot = await this.link.snapshot();

    let selected: SelectedHost | null = null;
    let selectionError: string | null = null;
    try {
      selected = await this.selectHost(cwd, signal, detections);
    } catch (error) {
      signal?.throwIfAborted();
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
    const healthy = Boolean(selected && lead && dependenciesOk && profilesOk && linkSnapshot.reachable && linkSnapshot.supported);
    const diagnostics = this.getDiagnostics(selected?.ctx.host.cwd ?? cwd);
    if (!selected || !lead || !linkSnapshot.reachable || linkSnapshot.supported !== true) {
      diagnostics.findings.push({ code: "runtime_prerequisite_unavailable", severity: "error", role: null,
        evidence: "Host selection or Lead/pi-link connectivity could not be verified.",
        next_check: "Check selected_backend, host_backends, lead_link_error and pi_link_status. Do not provision another worker." });
    }
    if (!dependenciesOk || !profilesOk) {
      diagnostics.findings.push({ code: "bundled_resources_missing", severity: "error", role: null,
        evidence: "At least one bundled dependency or source profile is missing.",
        next_check: "Inspect dependencies and profiles; repair the package installation before provisioning." });
    }
    for (const source of diagnostics.configuration?.sources ?? []) {
      if (source.status !== "invalid_or_unreadable") continue;
      diagnostics.findings.push({ code: "configuration_unreadable", severity: "warning", role: null,
        evidence: `Configuration source ${source.path} could not be parsed as an object or read.`,
        next_check: "Validate this file locally; its contents are deliberately not included in diagnostics." });
    }
    for (const profile of profileStatus) {
      if (profile.source_exists !== true || profile.target_exists !== true || profile.target_synced !== false) continue;
      diagnostics.findings.push({ code: "reserved_profile_out_of_sync", severity: "warning", role: String(profile.role),
        evidence: "The deployed reserved profile differs from this package's source profile; this is not evidence of the active worker model.",
        next_check: "Inspect the reported source/target profile paths and any project-local override before restarting the worker." });
    }
    let workers: RuntimeRoleStatus[] = [];
    let inspectionFailed = false;
    if (selected) {
      try {
        const group = await selected.host.findGroup(selected.ctx.host, GROUP_LABEL, signal);
        if (group) workers = await this.readWorkerRoles(selected, group, lead, linkSnapshot, diagnostics, signal);
        if (!group && currentProgress(diagnostics.runs).some((run) => run.kind === "provision" && run.phase === "ready")) {
          inspectionFailed = true;
          diagnostics.findings.push({ code: "worker_group_not_found", severity: "warning", role: null,
            evidence: "Provisioning previously reached READY, but its managed group is not present now.",
            next_check: "Check whether the group was intentionally closed; preserved history is not proof the worker is still alive." });
        }
      } catch {
        signal?.throwIfAborted();
        inspectionFailed = true;
        diagnostics.findings.push({ code: "worker_inspection_incomplete", severity: "warning", role: null,
          evidence: "Current worker observations could not be collected. The journal is still available.",
          next_check: "Check terminal host availability before interpreting missing workers as stopped." });
      }
    }
    const workerFindings = assessWorkers(workers);
    diagnostics.findings.push(...workerFindings);
    const executionRuns = currentProgress(diagnostics.runs);
    const executionHealth = inspectionFailed || workerFindings.length > 0 ? "attention_required"
      : diagnostics.runs.length === 0 ? "no_observations"
      : executionRuns.some((run) => ["failed", "cancelled", "unconfirmed"].includes(run.state)) ? "attention_required"
      : executionRuns.some((run) => run.state === "running") ? "pending" : "no_pending_transitions";

    return {
      status: "ok",
      healthy,
      environment_health: healthy ? "healthy" : "unhealthy",
      execution_health: executionHealth,
      diagnostics,
      workers,
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
