import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROFILE_PREFIX, ROLE_CONFIG } from "../config.ts";
import { RuntimeFailure } from "../errors.ts";
import type { Role } from "../types.ts";

export class ProfileStore {
  readonly packageRoot: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    packageRoot = fileURLToPath(new URL("../../", import.meta.url)),
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.packageRoot = packageRoot;
    this.env = env;
  }

  source(role: Role): string {
    const profile = ROLE_CONFIG[role].profile;
    const source = path.join(this.packageRoot, "agents", `${profile}.md`);
    if (!path.basename(source).startsWith(PROFILE_PREFIX)) {
      throw new RuntimeFailure(`bundled profile is outside reserved namespace: ${source}`);
    }
    return source;
  }

  target(role: Role): string {
    const root = this.env.PI_CODING_AGENT_DIR
      ? path.resolve(this.env.PI_CODING_AGENT_DIR)
      : path.join(os.homedir(), ".pi", "agent");
    return path.join(root, "agents", path.basename(this.source(role)));
  }

  async sync(role: Role): Promise<string> {
    const source = this.source(role);
    const target = this.target(role);
    let content: string;
    try {
      content = await readFile(source, "utf8");
    } catch {
      throw new RuntimeFailure(`bundled profile is missing: ${source}`);
    }

    await mkdir(path.dirname(target), { recursive: true });
    try {
      if ((await readFile(target, "utf8")) === content) return target;
    } catch {
      // Missing or unreadable target: replace it atomically below.
    }

    const temp = path.join(
      path.dirname(target),
      `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
    );
    await writeFile(temp, content, "utf8");
    try {
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
    return target;
  }

  async status(): Promise<Array<Record<string, unknown>>> {
    return Promise.all(
      (["coder", "reviewer", "researcher-code"] as const).map(async (role) => {
        const source = this.source(role);
        const target = this.target(role);
        const sourceExists = await exists(source);
        const targetExists = await exists(target);
        let targetSynced = false;
        if (sourceExists && targetExists) {
          targetSynced = (await readFile(source, "utf8")) === (await readFile(target, "utf8"));
        }
        return {
          role,
          source,
          target,
          source_exists: sourceExists,
          target_exists: targetExists,
          target_synced: targetSynced,
        };
      }),
    );
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
