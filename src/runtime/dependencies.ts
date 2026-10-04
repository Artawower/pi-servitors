import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROLE_CONFIG } from "../config.ts";
import { RuntimeFailure } from "../errors.ts";
import type { Role } from "../types.ts";
import {
  loadServitorConfig,
  resolveRoleExtensions,
  type ServitorConfig,
} from "./servitor-config.ts";

export type RuntimeDependency = {
  name: "pi-link" | "pi-open-agents";
  extensionPath: string;
};

export class RuntimeDependencies {
  readonly packageRoot: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly configOverrides: ServitorConfig | undefined;
  readonly piLink: RuntimeDependency;
  readonly openAgents: RuntimeDependency;

  constructor(
    packageRoot = fileURLToPath(new URL("../../", import.meta.url)),
    env: NodeJS.ProcessEnv = process.env,
    configOverrides?: ServitorConfig,
  ) {
    this.packageRoot = packageRoot;
    this.env = env;
    this.configOverrides = configOverrides;
    this.piLink = {
      name: "pi-link",
      extensionPath: path.join(packageRoot, "node_modules", "pi-link", "index.ts"),
    };
    this.openAgents = {
      name: "pi-open-agents",
      extensionPath: path.join(packageRoot, "node_modules", "pi-open-agents", "index.ts"),
    };
  }

  all(): RuntimeDependency[] {
    return [this.piLink, this.openAgents];
  }

  async status(): Promise<Array<RuntimeDependency & { exists: boolean }>> {
    return Promise.all(
      this.all().map(async (dependency) => {
        try {
          await access(dependency.extensionPath);
          return { ...dependency, exists: true };
        } catch {
          return { ...dependency, exists: false };
        }
      }),
    );
  }

  async assertAvailable(): Promise<void> {
    const missing = (await this.status()).filter((dependency) => !dependency.exists);
    if (missing.length > 0) {
      throw new RuntimeFailure(
        "missing bundled Pi dependencies: " +
          missing.map((dependency) => `${dependency.name} (${dependency.extensionPath})`).join(", ") +
          ". For a local checkout run `npm install`; npm/git Pi installs install these automatically.",
      );
    }
  }

  buildPiArgs(role: Role, linkName: string, cwd: string = process.cwd()): string[] {
    const config = this.configOverrides ?? loadServitorConfig(cwd, this.env);
    const extraExtensions = resolveRoleExtensions(config, role);

    const args = [
      "-ne",
      "-e",
      this.openAgents.extensionPath,
      "-e",
      this.piLink.extensionPath,
    ];
    for (const ext of extraExtensions) {
      args.push("-e", ext);
    }
    args.push(
      "--no-skills",
      "--no-prompt-templates",
      "--agent",
      ROLE_CONFIG[role].profile,
      "--link-name",
      linkName,
    );
    return args;
  }
}
