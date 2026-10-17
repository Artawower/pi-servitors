import type { DoctorResult, RuntimeResult } from "../types.ts";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { currentProgress, PHASE_EXPECTATIONS } from "./assessment.ts";
import type { FlowProgress } from "./journal.ts";

function duration(ms: number): string {
  return `${Math.floor(ms / 1000)}s`;
}

function flowLines(run: FlowProgress): string[] {
  const last = run.last_confirmed;
  let label = run.state.toUpperCase();
  if (run.state === "running") label = run.kind === "delegation" ? "WAITING_CALLBACK" : "PROVISIONING";
  return [
    `${run.role ?? "task"}: ${label} · ${run.phase} · phase ${duration(run.phase_elapsed_ms)} · total ${duration(run.elapsed_ms)}`,
    `  run=${run.run_id}${run.task_id ? ` task=${run.task_id}` : ""}${run.slot ? ` slot=${run.slot}` : ""}${run.last_event.source_sha256 ? ` code=${run.last_event.source_sha256.slice(0, 12)}` : ""}`,
    `  last confirmed: ${last ? `${last.phase} at ${new Date(last.at).toISOString()}` : "none recorded"}`,
    `  ${run.state === "failed" || run.state === "cancelled" ? "last error" : "expectation"}: ${run.state === "failed" || run.state === "cancelled" ? `${run.phase} ${run.state}; see original tool result` : PHASE_EXPECTATIONS[run.phase]}`,
  ];
}

export function formatDoctor(result: DoctorResult): string {
  const diagnostics = result.diagnostics;
  return [
    `Environment: ${result.environment_health} · Execution: ${result.execution_health}`,
    `Loaded package: ${diagnostics.provenance.package_root}`,
    `Source fingerprint: ${diagnostics.provenance.source_sha256 ?? "unavailable"}`,
    `Captured: ${new Date(diagnostics.provenance.captured_at).toISOString()} (runtime creation; not worker model evidence)`,
    `Lead: ${result.lead_link?.name ?? "unconfirmed"} · backend: ${result.selected_backend ?? "unavailable"}`,
    `Session: ${diagnostics.session?.file ?? "not available"}`,
    ...(diagnostics.configuration?.sources.map((source) => `Config ${source.status}: ${source.path}`) ?? []),
    ...Object.entries(diagnostics.configuration?.configured_extensions ?? {}).map(([role, extensions]) =>
      `Configured extensions (${role}): ${extensions.join(", ") || "none"}`),
    "Worker loaded extensions/provider/model: not observed by these checks.",
    ...(result.lead_link_error ? [`Lead/host error: ${result.lead_link_error}`] : []),
    ...diagnostics.findings.flatMap((finding) => [
      `${finding.severity.toUpperCase()} ${finding.code}${finding.role ? ` (${finding.role})` : ""}: ${finding.evidence}`,
      `  Next check: ${finding.next_check}`,
    ]),
    ...(diagnostics.findings.length === 0 ? ["No current diagnostic findings. This does not validate worker task results."] : []),
    ...currentProgress(diagnostics.runs).flatMap(flowLines),
    ...(diagnostics.persistence_error ? ["WARNING: journal could not be persisted to the session."] : []),
    ...(diagnostics.history_truncated ? ["History: older timeline rows omitted; pending run summaries retained within the run limit."] : []),
    ...(diagnostics.runs_truncated ? ["WARNING: pending run limit exceeded; some unresolved runs are missing."] : []),
    ...(result.report_file ? [`Report: ${result.report_file}`] : []),
  ].join("\n");
}

function renderRuntimeResult(result: RuntimeResult): string {
  if (result.status === "ready") {
    return [
      `${result.role}: ${result.reused ? "reused" : "started"}`,
      `target=${result.link_target}`, `reply_to=${result.lead_link_name}`,
      `group=${result.link_group ?? "plain"}`, `transport=${result.transport}`,
      `backend=${result.backend}`, `scope=${result.scope}`, `host_group=${result.group}`,
      `slot=${result.slot}`, `cwd=${result.cwd}`, `profile=${result.profile}`,
      `link=${result.link.connected === true ? "connected" : result.link.connected === false ? "not connected" : "unknown"}`,
    ].join("\n");
  }
  if ("healthy" in result) return formatDoctor(result);
  const lines = [`Lead: ${result.lead_link?.name ?? "unconfirmed"}`];
  const last = result.diagnostics.recent_events.at(-1);
  if (last) lines.push(`Last observed: ${last.phase}/${last.outcome} at ${new Date(last.at).toISOString()}`);
  if (result.lead_link_error) lines.push(`Lead/host error: ${result.lead_link_error}`);
  for (const role of result.roles) {
    const link = role.link_connected === true ? "on" : role.link_connected === false ? "off" : "unknown";
    lines.push(`${role.role}: process=${role.state} · link=${link} · slot=${role.slot ?? "none"} · target=${role.link_target ?? "unconfirmed"}`);
  }
  if (!result.roles.length) lines.push("No managed worker roles are present or the host could not be inspected.");
  lines.push(...currentProgress(result.diagnostics.runs).flatMap(flowLines));
  if (!result.diagnostics.runs.length) lines.push("No flow history on this session branch; execution is not observed.");
  if (result.diagnostics.persistence_error) lines.push("WARNING: journal persistence failed; history may be incomplete after reload.");
  if (result.diagnostics.history_truncated) lines.push("Older timeline rows omitted; pending run summaries retained within the run limit.");
  if (result.diagnostics.runs_truncated) lines.push("WARNING: pending run limit exceeded; some unresolved runs are missing.");
  return lines.join("\n");
}

export function formatRuntimeResult(result: RuntimeResult): string {
  const rendered = truncateHead(renderRuntimeResult(result), { maxLines: 300, maxBytes: 32_000 });
  if (!rendered.truncated) return rendered.content;
  return `${rendered.content}\n[Display truncated. Full bounded metadata is in tool details or /team-doctor --report.]`;
}
