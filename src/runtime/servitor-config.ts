import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Role } from "../types.ts";

export type ServitorConfig = {
  extensions?: string[];
  roles?: Partial<Record<Role, { extensions?: string[] }>>;
};

function readJsonFile(filePath: string): unknown {
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function normalizeExtensions(items: unknown, baseDir: string): string[] {
  if (!Array.isArray(items)) return [];
  const result: string[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
        result.push(path.resolve(baseDir, trimmed));
      } else {
        result.push(trimmed);
      }
    }
  }
  return result;
}

function normalizeConfig(obj: Record<string, unknown>, baseDir: string): ServitorConfig {
  const extensions = normalizeExtensions(obj.extensions, baseDir);
  const roles: Partial<Record<Role, { extensions?: string[] }>> = {};
  if (obj.roles && typeof obj.roles === "object" && !Array.isArray(obj.roles)) {
    const rolesObj = obj.roles as Record<string, unknown>;
    for (const [roleKey, roleVal] of Object.entries(rolesObj)) {
      if (roleVal && typeof roleVal === "object" && !Array.isArray(roleVal)) {
        const roleExts = normalizeExtensions((roleVal as Record<string, unknown>).extensions, baseDir);
        roles[roleKey as Role] = { extensions: roleExts };
      }
    }
  }
  return {
    ...(extensions.length > 0 ? { extensions } : {}),
    ...(Object.keys(roles).length > 0 ? { roles } : {}),
  };
}

export function parseServitorsJson(raw: unknown, fileDir: string): ServitorConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return normalizeConfig(raw as Record<string, unknown>, fileDir);
}

export function parseSettingsJson(raw: unknown, fileDir: string): ServitorConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const servitors = (raw as Record<string, unknown>).servitors;
  if (!servitors || typeof servitors !== "object" || Array.isArray(servitors)) return {};
  return normalizeConfig(servitors as Record<string, unknown>, fileDir);
}

export function mergeConfigs(configs: readonly ServitorConfig[]): ServitorConfig {
  const commonExtensions: string[] = [];
  const roles: Partial<Record<Role, { extensions?: string[] }>> = {};

  for (const cfg of configs) {
    if (cfg.extensions) {
      commonExtensions.push(...cfg.extensions);
    }
    if (cfg.roles) {
      for (const [role, roleCfg] of Object.entries(cfg.roles)) {
        if (!roles[role as Role]) {
          roles[role as Role] = { extensions: [] };
        }
        if (roleCfg?.extensions) {
          roles[role as Role]!.extensions!.push(...roleCfg.extensions);
        }
      }
    }
  }

  const mergedRoles: Partial<Record<Role, { extensions?: string[] }>> = {};
  for (const [role, roleVal] of Object.entries(roles)) {
    mergedRoles[role as Role] = {
      extensions: Array.from(new Set(roleVal?.extensions ?? [])),
    };
  }

  return {
    extensions: Array.from(new Set(commonExtensions)),
    ...(Object.keys(mergedRoles).length > 0 ? { roles: mergedRoles } : {}),
  };
}

export function resolveRoleExtensions(config: ServitorConfig, role: Role): string[] {
  const common = config.extensions ?? [];
  const roleSpecific = config.roles?.[role]?.extensions ?? [];
  return Array.from(new Set([...common, ...roleSpecific]));
}

export function loadServitorConfig(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): ServitorConfig {
  const configs: ServitorConfig[] = [];

  // 1. Global config from ~/.pi/agent, ~/.pig/agent, or PI_CODING_AGENT_DIR
  const globalDirs = [
    env.PI_CODING_AGENT_DIR ? path.resolve(env.PI_CODING_AGENT_DIR) : null,
    path.join(os.homedir(), ".pi", "agent"),
    path.join(os.homedir(), ".pig", "agent"),
  ].filter((d): d is string => Boolean(d));

  for (const dir of globalDirs) {
    const servitorsFile = path.join(dir, "servitors.json");
    const settingsFile = path.join(dir, "settings.json");

    const servitorsData = readJsonFile(servitorsFile);
    if (servitorsData) {
      configs.push(parseServitorsJson(servitorsData, dir));
    }
    const settingsData = readJsonFile(settingsFile);
    if (settingsData) {
      configs.push(parseSettingsJson(settingsData, dir));
    }
  }

  // 2. Project config from <cwd>/.pi
  const projectPiDir = path.join(cwd, ".pi");
  const projServitorsFile = path.join(projectPiDir, "servitors.json");
  const projSettingsFile = path.join(projectPiDir, "settings.json");

  const projServitorsData = readJsonFile(projServitorsFile);
  if (projServitorsData) {
    configs.push(parseServitorsJson(projServitorsData, projectPiDir));
  }
  const projSettingsData = readJsonFile(projSettingsFile);
  if (projSettingsData) {
    configs.push(parseSettingsJson(projSettingsData, projectPiDir));
  }

  // 3. Environment variable PI_SERVITORS_EXTENSIONS
  const envExts = env.PI_SERVITORS_EXTENSIONS;
  if (envExts) {
    const list = envExts
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 0) {
      configs.push({ extensions: list });
    }
  }

  return mergeConfigs(configs);
}
