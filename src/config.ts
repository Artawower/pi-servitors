import type { Role, RoleConfig } from "./types.ts";

export const GROUP_LABEL = "AI SERVITORS";
export const PROFILE_PREFIX = "pi-servitors-";

export const ROLE_CONFIG: Record<Role, RoleConfig> = {
  coder: {
    profile: "pi-servitors-coder",
    runtimeSuffix: "coder",
  },
  reviewer: {
    profile: "pi-servitors-reviewer",
    runtimeSuffix: "reviewer",
  },
  "researcher-code": {
    profile: "pi-servitors-researcher",
    runtimeSuffix: "researcher",
  },
};

export const LINK_STATUS_URL = "http://127.0.0.1:9900/status";
export const LINK_WAIT_MS = 20_000;
export const LINK_POLL_MS = 400;
export const WORKER_START_TIMEOUT_MS = 120_000;
export const SHELL_READY_TIMEOUT_MS = 20_000;
