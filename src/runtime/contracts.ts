import type { LinkConnection, LinkSnapshot, Role } from "../types.ts";

export interface LinkStatusProvider {
  snapshot(timeoutMs?: number): Promise<LinkSnapshot>;
  names(snapshot: LinkSnapshot): Set<string>;
  connection(name: string, snapshot: LinkSnapshot): LinkConnection;
  waitFor(
    name: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<LinkConnection>;
}

export interface WorkerProfileStore {
  sync(role: Role): Promise<string>;
  status(): Promise<Array<Record<string, unknown>>>;
}

export interface WorkerDependencySet {
  assertAvailable(): Promise<void>;
  status(): Promise<Array<Record<string, unknown> & { exists: boolean }>>;
  buildPiArgs(role: Role, linkName: string): string[];
}

export interface RuntimeMutex {
  withLock<T>(key: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T>;
}
