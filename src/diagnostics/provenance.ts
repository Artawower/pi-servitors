import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type RuntimeProvenance = {
  package_root: string;
  version: string | null;
  source_sha256: string | null;
  captured_at: number;
  fingerprint_scope: "package.json and src files at runtime creation; not worker code or model evidence";
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name) ? [file] : [];
  });
}

export function captureProvenance(
  root = fileURLToPath(new URL("../../", import.meta.url)),
): RuntimeProvenance {
  const result: RuntimeProvenance = {
    package_root: root, version: null, source_sha256: null, captured_at: Date.now(),
    fingerprint_scope: "package.json and src files at runtime creation; not worker code or model evidence",
  };
  try {
    const packageFile = path.join(root, "package.json");
    const metadata = JSON.parse(readFileSync(packageFile, "utf8")) as Record<string, unknown>;
    result.version = typeof metadata.version === "string" ? metadata.version : null;
    const hash = createHash("sha256");
    for (const file of [packageFile, ...sourceFiles(path.join(root, "src"))].sort()) {
      hash.update(path.relative(root, file)).update("\0").update(readFileSync(file, "utf8")).update("\0");
    }
    result.source_sha256 = hash.digest("hex");
  } catch {
    result.source_sha256 = null;
  }
  return result;
}
