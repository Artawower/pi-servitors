import { ROLES, type Role } from "../types.ts";
import { inspectServitorConfig, resolveRoleExtensions, type ConfigSource, type ServitorConfig } from "../runtime/servitor-config.ts";

export type WorkerConfiguration = {
  source: "settings" | "constructor_override";
  sources: ConfigSource[];
  environment_extensions_present: boolean;
  configured_extensions: Record<Role, string[]>;
  observation: "launch configuration only; loaded worker extensions and model are not observed";
};

function extensionLabel(spec: string): string {
  if (spec.includes("://") || /[?\r\n]|(?:token|password|api[_-]?key)=/i.test(spec)) {
    return "[remote/credential-bearing extension spec omitted]";
  }
  return spec.slice(0, 512);
}

export function inspectWorkerConfiguration(
  cwd: string,
  env: NodeJS.ProcessEnv,
  overrides?: ServitorConfig,
): WorkerConfiguration {
  const inspected = overrides ? null : inspectServitorConfig(cwd, env);
  const config = overrides ?? inspected?.config ?? {};
  const configured = Object.fromEntries(ROLES.map((role) => [
    role, resolveRoleExtensions(config, role).slice(0, 50).map(extensionLabel),
  ])) as Record<Role, string[]>;
  return {
    source: overrides ? "constructor_override" : "settings",
    sources: inspected?.sources ?? [],
    environment_extensions_present: inspected?.environment_extensions_present ?? false,
    configured_extensions: configured,
    observation: "launch configuration only; loaded worker extensions and model are not observed",
  };
}
