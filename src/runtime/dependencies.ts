import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROLE_CONFIG } from "../config.ts";
import { RuntimeFailure } from "../errors.ts";
import type { Role } from "../types.ts";

export type RuntimeDependency = {
  name: "pi-link" | "pi-open-agents";
  extensionPath: string;
};

export class RuntimeDependencies {
  readonly packageRoot: string;
  readonly piLink: RuntimeDependency;
  readonly openAgents: RuntimeDependency;

  constructor(packageRoot = fileURLToPath(new URL("../../", import.meta.url))) {
    this.packageRoot = packageRoot;
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

  buildPiArgs(role: Role, linkName: string): string[] {
    return [
      "-ne",
      "-e",
      this.openAgents.extensionPath,
      "-e",
      this.piLink.extensionPath,
      "--no-skills",
      "--no-prompt-templates",
      "--agent",
      ROLE_CONFIG[role].profile,
      "--link-name",
      linkName,
    ];
  }
}
