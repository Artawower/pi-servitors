import type { FlowEvent, FlowProgress } from "./diagnostics/journal.ts";
import type { DiagnosticFinding } from "./diagnostics/assessment.ts";
import type { RuntimeProvenance } from "./diagnostics/provenance.ts";
import type { WorkerConfiguration } from "./diagnostics/configuration.ts";

export const ROLES = ["coder", "reviewer", "researcher-code"] as const;
export type Role = (typeof ROLES)[number];

export type RoleConfig = {
  profile: string;
  runtimeSuffix: string;
};

export type HostDetection = {
  backend: string;
  available: boolean;
  active: boolean;
  reason?: string;
};

export type HostContext = {
  backend: string;
  scopeId: string;
  leadSlotId: string;
  cwd: string;
};

export type GroupRef = {
  id: string;
  label: string;
};

export type SlotRef = {
  id: string;
  groupId: string;
  label?: string;
  cwd?: string;
};

export type WorkerRef = {
  name?: string;
  slotId: string;
  state?: string;
};

export type SlotInspection =
  | { kind: "shell" }
  | { kind: "worker"; worker: WorkerRef }
  | { kind: "busy"; detail?: string };

export type GroupCreation = {
  group: GroupRef;
  initialSlot: SlotRef;
};

export type LinkTerminal = {
  name: string;
  cwd?: string;
  [key: string]: unknown;
};

export type LinkSnapshot = {
  supported: boolean | null;
  reachable: boolean;
  reason: string | null;
  terminals: LinkTerminal[];
};

export type LinkConnection = {
  connected: boolean | null;
  verifier: string;
  status_supported: boolean | null;
  status_reachable: boolean;
  reason: string | null;
};

export type LeadLink = {
  name: string;
  group: string | null;
  terminal: LinkTerminal;
};

export type RuntimeContext = {
  host: HostContext;
  projectSlug: string;
  scopeHash: string;
};

export type ReadyResult = {
  status: "ready";
  role: Role;
  runtime_name: string;
  link_target: string;
  lead_link_name: string;
  link_group: string | null;
  transport: "pi-link/link_send";
  reused: boolean;
  backend: string;
  scope: string;
  group: string;
  slot: string;
  cwd: string;
  profile: string;
  harness: string[];
  link: LinkConnection;
};

export type RuntimeDiagnostics = {
  session?: { file: string | null; id: string | null };
  provenance: RuntimeProvenance;
  configuration: WorkerConfiguration | null;
  runs: FlowProgress[];
  recent_events: FlowEvent[];
  findings: DiagnosticFinding[];
  persistence_error: boolean;
  history_limit: number;
  history_truncated: boolean;
  runs_truncated: boolean;
};

export type RuntimeRoleStatus = {
  role: Role;
  state: string;
  runtime_name: string;
  link_target: string | null;
  link_connected: boolean | null;
  slot: string | null;
  expected_slot: string | null;
  profile: string;
  progress: FlowProgress | null;
  tasks: FlowProgress[];
};

export type RuntimeStatusResult = {
  status: "ok";
  backend?: string;
  scope?: string;
  group?: string;
  cwd: string;
  lead_link: LeadLink | null;
  lead_link_error: string | null;
  roles: RuntimeRoleStatus[];
  link_status?: Record<string, unknown>;
  diagnostics: RuntimeDiagnostics;
};

export type DoctorResult = {
  status: "ok";
  healthy: boolean;
  environment_health: "healthy" | "unhealthy";
  execution_health: "no_observations" | "no_pending_transitions" | "pending" | "attention_required";
  diagnostics: RuntimeDiagnostics;
  report_file?: string;
  workers: RuntimeRoleStatus[];
  cwd: string;
  selected_backend: string | null;
  host_backends: HostDetection[];
  transport: "pi-link/link_send";
  lead_link: LeadLink | null;
  lead_link_error: string | null;
  pi_link_status: Record<string, unknown>;
  dependencies: Array<Record<string, unknown>>;
  profiles: Array<Record<string, unknown>>;
};

export type RuntimeResult = ReadyResult | RuntimeStatusResult | DoctorResult;
