import type { FlowPhase, FlowProgress } from "./journal.ts";
import type { RuntimeRoleStatus } from "../types.ts";

export type DiagnosticFinding = {
  code: string;
  severity: "warning" | "error";
  role: string | null;
  evidence: string;
  next_check: string;
};

export const PHASE_EXPECTATIONS: Record<FlowPhase, string> = {
  select_host: "an active supported terminal host",
  wait_lock: "exclusive access to this runtime scope",
  dependencies: "bundled worker dependencies to be available",
  sync_profile: "the worker profile to be synchronized",
  resolve_lead: "the exact Lead identity on pi-link",
  resolve_group: "the managed worker group",
  find_worker: "an exact managed worker identity or confirmation it is absent",
  validate_worker: "the worker location and identity to match",
  resolve_slot: "a safe managed role slot",
  wait_shell: "execution of the shell readiness probe",
  launch_command: "the terminal host to accept the launch command (not proof Pi executed)",
  wait_worker: "Pi to be detected with a known state",
  rename_worker: "the detected worker to acquire its managed name",
  validate_location: "the renamed worker location to match",
  wait_link: "the exact worker target to connect to pi-link",
  ready: "no further provisioning step; task execution is not implied",
  send_task: "link_send to return successfully (not proof of delivery or execution)",
  wait_callback: "a callback to be observed by Lead; worker execution is unconfirmed",
  callback_received: "no further callback; the task result has not been validated",
};

export function currentProgress(runs: readonly FlowProgress[]): FlowProgress[] {
  return runs.filter((run, index, all) => {
    if (run.kind === "delegation") {
      if (run.state === "succeeded") return false;
      if (run.state === "running" || run.state === "unconfirmed") return true;
      return !all.slice(index + 1).some((next) => next.kind === "delegation" && next.task_id === run.task_id);
    }
    if (run.state === "running" || run.state === "unconfirmed") return true;
    return !all.slice(index + 1).some((next) => next.kind === "provision" && next.role === run.role);
  });
}

export function assessWorkers(workers: readonly RuntimeRoleStatus[]): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  for (const worker of workers) {
    if (worker.link_connected === false && !["absent", "not_detected"].includes(worker.state)) {
      findings.push({ code: "worker_link_disconnected", severity: "warning", role: worker.role,
        evidence: `Managed worker is detected in ${worker.slot}, but its expected pi-link target is not connected.`,
        next_check: "Inspect the existing worker's pi-link configuration; do not create another slot." });
    }
    if (worker.state === "not_detected" && worker.progress?.phase === "ready") {
      findings.push({ code: "worker_no_longer_detected", severity: "warning", role: worker.role,
        evidence: "Provisioning previously reached READY, but the named worker is not detected in its managed slot now.",
        next_check: "Inspect the existing slot and original session for exit or detection errors before restarting." });
    }
    if (worker.expected_slot && worker.slot !== worker.expected_slot) {
      findings.push({ code: "worker_location_mismatch", severity: "error", role: worker.role,
        evidence: `Observed worker slot ${worker.slot} differs from managed role slot ${worker.expected_slot}.`,
        next_check: "Resolve the identity/location conflict manually; do not adopt or duplicate the process." });
    }
    if (worker.link_connected === false && worker.tasks.length > 0) {
      findings.push({ code: "pending_callback_target_disconnected", severity: "warning", role: worker.role,
        evidence: "A task callback is pending while the expected target is absent from pi-link. Task execution is unconfirmed.",
        next_check: "Preserve the task ID and inspect the existing worker's session and connection before resending." });
    }
  }
  return findings;
}

export function assessProgress(runs: readonly FlowProgress[]): DiagnosticFinding[] {
  return runs.filter((run) => run.state !== "succeeded").map((run) => {
    let code = "transition_pending";
    let evidence = `Run ${run.run_id}: ${run.phase} has not completed; waiting ${run.phase_elapsed_ms}ms. This alone does not prove a stall.`;
    if (run.state === "failed" || run.state === "cancelled") {
      code = `transition_${run.state}`;
      evidence = `Run ${run.run_id}: ${run.phase} ${run.state}. Raw error details remain in the original tool result, not this journal.`;
    }
    if (run.state === "unconfirmed") {
      code = "transition_unconfirmed";
      evidence = `Run ${run.run_id}: no completion recorded for ${run.phase} on the restored branch. The original operation is not known to be running.`;
    }
    return {
      code, severity: run.state === "failed" ? "error" : "warning", role: run.role,
      evidence, next_check: `Verify ${PHASE_EXPECTATIONS[run.phase]}. Preserve evidence before retrying; do not create a duplicate worker.`,
    };
  });
}
