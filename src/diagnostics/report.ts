import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DoctorResult } from "../types.ts";

export async function saveDoctorReport(
  result: DoctorResult,
  directory = path.join(
    process.env.PI_CODING_AGENT_DIR ? path.resolve(process.env.PI_CODING_AGENT_DIR) : path.join(os.homedir(), ".pi", "agent"),
    "servitors", "diagnostics",
  ),
): Promise<string> {
  const report = {
    schema_version: 1,
    created_at: new Date().toISOString(),
    cwd: result.cwd,
    environment_health: result.environment_health,
    execution_health: result.execution_health,
    selected_backend: result.selected_backend,
    lead_identity: result.lead_link?.name ?? null,
    diagnostics: result.diagnostics,
    workers: result.workers,
    dependencies: result.dependencies.map((item) => ({ name: item.name, exists: item.exists })),
    profiles: result.profiles.map((item) => ({
      role: item.role, source: item.source, target: item.target,
      source_exists: item.source_exists, target_exists: item.target_exists, target_synced: item.target_synced,
    })),
    limitations: [
      "Metadata only: no task bodies, prompts, credentials, raw tool errors, terminal output or session transcript.",
      "Task IDs, identities and local paths remain visible; review before sharing.",
      "Sending a task does not confirm worker receipt or execution; a callback does not validate its result.",
      "Missing completion after session restoration is unconfirmed, not proof the old operation is running.",
      "Configured extensions and source fingerprints do not identify the actual worker provider/model.",
    ],
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `report-${Date.now()}-${randomUUID()}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return file;
}
