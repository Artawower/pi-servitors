import { createHash } from "node:crypto";
import path from "node:path";
import { ROLE_CONFIG } from "../config.ts";
import { RuntimeFailure } from "../errors.ts";
import type { HostContext, LeadLink, LinkSnapshot, Role, RuntimeContext } from "../types.ts";

export function normalizeSlug(value: string, limit = 10): string {
  let slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  if (!/^[a-z]/.test(slug)) slug = `p-${slug}`;
  return slug.slice(0, limit).replace(/-+$/g, "") || "project";
}

export function buildRuntimeContext(host: HostContext): RuntimeContext {
  const cwd = path.resolve(host.cwd);
  const scopeHash = createHash("sha1")
    .update(`${host.backend}\0${host.scopeId}\0${cwd}`)
    .digest("hex")
    .slice(0, 6);
  return {
    host: { ...host, cwd },
    projectSlug: normalizeSlug(path.basename(cwd)),
    scopeHash,
  };
}

export function runtimeName(ctx: RuntimeContext, role: Role): string {
  const suffix = ROLE_CONFIG[role].runtimeSuffix;
  const value = `psv-${ctx.projectSlug}-${ctx.scopeHash}-${suffix}`;
  if (value.length > 32 || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)) {
    throw new RuntimeFailure(`invalid managed worker name: ${value}`);
  }
  return value;
}

export function slotLabel(ctx: RuntimeContext, role: Role): string {
  return `worker:${ctx.projectSlug}:${ctx.scopeHash}:${ROLE_CONFIG[role].runtimeSuffix}`;
}

export function linkGroup(name: string): string | null {
  const at = name.indexOf("@");
  if (at < 0) return null;
  const group = name.slice(at + 1);
  return group || null;
}

export function linkTarget(ctx: RuntimeContext, role: Role, leadName: string): string {
  const local = runtimeName(ctx, role);
  const group = linkGroup(leadName);
  return group === null ? local : `${local}@${group}`;
}

export function isManagedLinkName(ctx: RuntimeContext, name: string): boolean {
  const local = name.split("@", 1)[0] ?? "";
  return (["coder", "reviewer", "researcher-code"] as const).some(
    (role) => runtimeName(ctx, role) === local,
  );
}

function sameCwd(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  return path.resolve(candidate) === path.resolve(expected);
}

export function inferLeadLink(ctx: RuntimeContext, snapshot: LinkSnapshot): LeadLink {
  if (snapshot.supported !== true) {
    const reason = snapshot.reason || "status_unavailable";
    throw new RuntimeFailure(
      "cannot determine the Lead pi-link group because the running pi-link hub " +
        `does not provide a usable /status snapshot (${reason}). Update/restart ` +
        "pi-link, then reconnect the Lead.",
    );
  }

  const candidates = snapshot.terminals.filter(
    (terminal) =>
      sameCwd(terminal.cwd, ctx.host.cwd) && !isManagedLinkName(ctx, terminal.name),
  );

  if (candidates.length === 0) {
    throw new RuntimeFailure(
      "Lead is not visible on pi-link for this cwd. Connect/name the Lead first " +
        "(for example `pi --link-name lead@my-scope`, or `/link-connect` followed " +
        "by `/link-name lead@my-scope`). pi-servitors does not fall back to the " +
        "terminal backend for agent communication.",
    );
  }

  if (candidates.length > 1) {
    const names = candidates.map((item) => item.name).sort();
    throw new RuntimeFailure(
      "multiple non-managed pi-link terminals are connected in this cwd, so the " +
        `Lead identity is ambiguous: ${JSON.stringify(names)}. Use a unique project/group ` +
        "or close the extra Lead-like terminal before provisioning workers.",
    );
  }

  const terminal = candidates[0];
  if (!terminal) throw new RuntimeFailure("internal error: Lead candidate disappeared");
  return { name: terminal.name, group: linkGroup(terminal.name), terminal };
}

export function wrongGroupTargets(
  ctx: RuntimeContext,
  role: Role,
  snapshot: LinkSnapshot,
): string[] {
  const local = runtimeName(ctx, role);
  return snapshot.terminals
    .map((terminal) => terminal.name)
    .filter((name) => (name.split("@", 1)[0] ?? "") === local)
    .sort();
}
