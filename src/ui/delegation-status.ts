import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { DelegationTracker } from "../delegation/tracker.ts";
import type { LinkSnapshot } from "../types.ts";
import type { LinkStatusProvider } from "../runtime/contracts.ts";
import {
  buildDelegationCards,
  DelegationGridComponent,
  formatElapsed,
  type DelegationCard,
} from "./delegation-grid.ts";

export { formatElapsed } from "./delegation-grid.ts";

const STATUS_KEY = "pi-servitors";
const WIDGET_KEY = "pi-servitors-waiting";

export function buildDelegationStatus(cards: readonly DelegationCard[]): string | undefined {
  if (cards.length === 0) return undefined;
  const summary = cards
    .map((card) => `${card.role ?? "worker"} ${formatElapsed(card.elapsedMs)}`)
    .join(" · ");
  return `workers ${cards.length} active · ${summary}`;
}

/**
 * UI-only local polling. This reads pi-link's localhost /status endpoint and
 * never invokes the Lead model, so it does not reintroduce orchestration polling.
 */
export class DelegationStatusView {
  private telemetryTimer: NodeJS.Timeout | null = null;
  private animationTimer: NodeJS.Timeout | null = null;
  private ui: ExtensionUIContext | null = null;
  private requestRender: (() => void) | null = null;
  private linkSnapshot: LinkSnapshot | null = null;
  private cards: DelegationCard[] = [];
  private refreshing = false;
  private mounted = false;

  private readonly tracker: DelegationTracker;
  private readonly link: Pick<LinkStatusProvider, "snapshot">;
  private readonly telemetryIntervalMs: number;
  private readonly animationIntervalMs: number;

  constructor(
    tracker: DelegationTracker,
    link: Pick<LinkStatusProvider, "snapshot">,
    telemetryIntervalMs = 500,
    animationIntervalMs = 95,
  ) {
    this.tracker = tracker;
    this.link = link;
    this.telemetryIntervalMs = telemetryIntervalMs;
    this.animationIntervalMs = animationIntervalMs;
  }

  render(ui: ExtensionUIContext): void {
    this.ui = ui;
    const active = this.tracker.snapshot();
    if (active.length === 0) {
      this.clearVisuals(ui);
      return;
    }

    this.cards = buildDelegationCards(active, this.linkSnapshot);
    ui.setStatus(STATUS_KEY, buildDelegationStatus(this.cards));
    this.mountWidget(ui);
    this.ensureTimers();
    void this.refreshTelemetry();
  }

  clear(ui?: ExtensionUIContext): void {
    const target = ui ?? this.ui;
    this.stopTimers();
    this.ui = null;
    this.requestRender = null;
    this.linkSnapshot = null;
    this.cards = [];
    this.mounted = false;
    if (!target) return;
    target.setStatus(STATUS_KEY, undefined);
    target.setWidget(WIDGET_KEY, undefined);
  }

  private clearVisuals(ui: ExtensionUIContext): void {
    this.stopTimers();
    this.cards = [];
    this.linkSnapshot = null;
    this.requestRender = null;
    this.mounted = false;
    ui.setStatus(STATUS_KEY, undefined);
    ui.setWidget(WIDGET_KEY, undefined);
  }

  private mountWidget(ui: ExtensionUIContext): void {
    if (this.mounted) {
      this.requestRender?.();
      return;
    }

    this.mounted = true;
    ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        this.requestRender = () => tui.requestRender();
        return new DelegationGridComponent(() => this.cards, theme);
      },
      { placement: "aboveEditor" },
    );
  }

  private ensureTimers(): void {
    if (!this.animationTimer) {
      this.animationTimer = setInterval(() => {
        const active = this.tracker.snapshot();
        if (active.length === 0) {
          if (this.ui) this.clearVisuals(this.ui);
          return;
        }
        this.cards = buildDelegationCards(active, this.linkSnapshot);
        this.requestRender?.();
      }, this.animationIntervalMs);
      this.animationTimer.unref?.();
    }

    if (!this.telemetryTimer) {
      this.telemetryTimer = setInterval(() => {
        const active = this.tracker.snapshot();
        if (active.length === 0) {
          if (this.ui) this.clearVisuals(this.ui);
          return;
        }
        this.cards = buildDelegationCards(active, this.linkSnapshot);
        if (this.ui) this.ui.setStatus(STATUS_KEY, buildDelegationStatus(this.cards));
        void this.refreshTelemetry();
      }, this.telemetryIntervalMs);
      this.telemetryTimer.unref?.();
    }
  }

  private stopTimers(): void {
    if (this.animationTimer) {
      clearInterval(this.animationTimer);
      this.animationTimer = null;
    }
    if (this.telemetryTimer) {
      clearInterval(this.telemetryTimer);
      this.telemetryTimer = null;
    }
  }

  private async refreshTelemetry(): Promise<void> {
    if (this.refreshing || this.tracker.snapshot().length === 0) return;
    this.refreshing = true;
    try {
      this.linkSnapshot = await this.link.snapshot(Math.max(250, this.telemetryIntervalMs));
    } catch {
      // Keep the previous telemetry. The tracker remains authoritative for tasks.
    } finally {
      this.refreshing = false;
    }

    const active = this.tracker.snapshot();
    if (active.length === 0) {
      if (this.ui) this.clearVisuals(this.ui);
      return;
    }
    this.cards = buildDelegationCards(active, this.linkSnapshot);
    if (this.ui) this.ui.setStatus(STATUS_KEY, buildDelegationStatus(this.cards));
    this.requestRender?.();
  }
}
