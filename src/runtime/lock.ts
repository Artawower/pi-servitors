import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeFailure } from "../errors.ts";

const RETRY_MS = 100;
const ACQUIRE_TIMEOUT_MS = 10_000;
const STALE_AFTER_MS = 5 * 60_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class RuntimeLock {
  private readonly root: string;

  constructor(
    root = path.join(
      process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
      "pi-servitors-runtime",
    ),
  ) {
    this.root = root;
  }

  async withLock<T>(key: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true });
    const safe = key.replace(/[^A-Za-z0-9_.-]+/g, "_");
    const lockPath = path.join(this.root, `${safe}.lock`);
    const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;

    while (true) {
      try {
        const handle = await open(lockPath, "wx");
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
        await handle.close();
        try {
          return await fn();
        } finally {
          await rm(lockPath, { force: true });
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        if (await this.isStale(lockPath)) {
          await rm(lockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new RuntimeFailure(`timed out acquiring runtime lock ${lockPath}`);
        }
        await sleep(RETRY_MS, signal);
      }
    }
  }

  private async isStale(lockPath: string): Promise<boolean> {
    try {
      const payload = JSON.parse(await readFile(lockPath, "utf8")) as {
        pid?: number;
        createdAt?: number;
      };
      if (typeof payload.createdAt === "number" && Date.now() - payload.createdAt > STALE_AFTER_MS) {
        return true;
      }
      if (typeof payload.pid === "number") return !processAlive(payload.pid);
      return true;
    } catch {
      try {
        const info = await stat(lockPath);
        return Date.now() - info.mtimeMs > 5_000;
      } catch {
        return true;
      }
    }
  }
}
