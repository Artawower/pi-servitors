import { LINK_POLL_MS, LINK_STATUS_URL, LINK_WAIT_MS } from "../config.ts";
import { RuntimeFailure } from "../errors.ts";
import type { LinkConnection, LinkSnapshot, LinkTerminal } from "../types.ts";

export type FetchLike = typeof fetch;

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

export function parseLinkStatusPayload(payload: unknown): LinkTerminal[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RuntimeFailure("pi-link /status returned a non-object JSON payload");
  }
  const terminals = (payload as Record<string, unknown>).terminals;
  if (!Array.isArray(terminals)) {
    throw new RuntimeFailure("pi-link /status payload has no terminals list");
  }
  return terminals
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .flatMap((item) => {
      const name = item.name;
      if (typeof name !== "string" || !name) return [];
      const cwd = typeof item.cwd === "string" && item.cwd ? item.cwd : undefined;
      return [{ ...item, name, ...(cwd ? { cwd } : {}) } satisfies LinkTerminal];
    });
}

export class PiLinkStatusClient {
  private readonly fetchImpl: FetchLike;
  private readonly statusUrl: string;

  constructor(fetchImpl: FetchLike = fetch, statusUrl = LINK_STATUS_URL) {
    this.fetchImpl = fetchImpl;
    this.statusUrl = statusUrl;
  }

  async snapshot(timeoutMs = 2_000): Promise<LinkSnapshot> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("pi-link status timeout")), timeoutMs);
    try {
      const response = await this.fetchImpl(this.statusUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (response.status === 426) {
        return {
          supported: false,
          reachable: true,
          reason: "hub_status_unsupported",
          terminals: [],
        };
      }
      if (!response.ok) {
        return {
          supported: null,
          reachable: true,
          reason: `http_${response.status}`,
          terminals: [],
        };
      }
      try {
        const terminals = parseLinkStatusPayload(await response.json());
        return { supported: true, reachable: true, reason: null, terminals };
      } catch (error) {
        return {
          supported: false,
          reachable: true,
          reason: `invalid_status_payload: ${String(error)}`,
          terminals: [],
        };
      }
    } catch (error) {
      return {
        supported: null,
        reachable: false,
        reason: `unreachable: ${String(error)}`,
        terminals: [],
      };
    } finally {
      clearTimeout(timer);
    }
  }

  names(snapshot: LinkSnapshot): Set<string> {
    return snapshot.supported === true
      ? new Set(snapshot.terminals.map((terminal) => terminal.name))
      : new Set();
  }

  connection(name: string, snapshot: LinkSnapshot): LinkConnection {
    return {
      connected: snapshot.supported === true ? this.names(snapshot).has(name) : null,
      verifier: "pi-link-http-status",
      status_supported: snapshot.supported,
      status_reachable: snapshot.reachable,
      reason: snapshot.reason,
    };
  }

  async waitFor(
    name: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<LinkConnection> {
    const timeoutMs = options.timeoutMs ?? LINK_WAIT_MS;
    const deadline = Date.now() + timeoutMs;
    let last = await this.snapshot();
    while (Date.now() < deadline) {
      const info = this.connection(name, last);
      if (info.connected === true) return info;
      if (last.reachable && last.supported === false) return info;
      await sleep(LINK_POLL_MS, options.signal);
      last = await this.snapshot();
    }
    return this.connection(name, last);
  }
}
