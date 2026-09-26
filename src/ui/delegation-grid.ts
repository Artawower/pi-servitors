import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { DelegationSnapshot } from "../delegation/tracker.ts";
import type { LinkSnapshot, LinkTerminal, Role } from "../types.ts";


export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export type WorkerTelemetry = {
  connected: boolean;
  status: string | null;
  sinceSeconds: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
};

export type DelegationCard = DelegationSnapshot & {
  telemetry: WorkerTelemetry;
};

export type ThemeLike = Pick<ExtensionUIContext["theme"], "fg">;
type ThemeColor = Parameters<ThemeLike["fg"]>[0];

function terminalTelemetry(terminal: LinkTerminal | undefined): WorkerTelemetry {
  if (!terminal) {
    return {
      connected: false,
      status: null,
      sinceSeconds: null,
      contextTokens: null,
      contextWindow: null,
    };
  }

  const rawStatus = typeof terminal.status === "string" ? terminal.status : null;
  const sinceSeconds = typeof terminal.sinceSeconds === "number" ? terminal.sinceSeconds : null;
  const context = terminal.context;
  const contextRecord = context && typeof context === "object" && !Array.isArray(context)
    ? (context as Record<string, unknown>)
    : null;
  const tokens = typeof contextRecord?.tokens === "number" ? contextRecord.tokens : null;
  const window = typeof contextRecord?.window === "number"
    ? contextRecord.window
    : typeof contextRecord?.contextWindow === "number"
      ? contextRecord.contextWindow
      : null;

  return {
    connected: true,
    status: rawStatus,
    sinceSeconds,
    contextTokens: tokens,
    contextWindow: window,
  };
}

export function buildDelegationCards(
  active: readonly DelegationSnapshot[],
  link: LinkSnapshot | null,
): DelegationCard[] {
  const terminals = new Map((link?.terminals ?? []).map((terminal) => [terminal.name, terminal]));
  return active.map((item) => ({
    ...item,
    telemetry: terminalTelemetry(terminals.get(item.target)),
  }));
}

function plainTruncate(text: string, width: number): string {
  if (width <= 0) return "";
  const chars = Array.from(text);
  if (chars.length <= width) return text;
  if (width === 1) return "…";
  return `${chars.slice(0, width - 1).join("")}…`;
}

function plainPad(text: string, width: number): string {
  const clipped = plainTruncate(text, width);
  return clipped + " ".repeat(Math.max(0, width - Array.from(clipped).length));
}

function formatTokens(value: number | null): string {
  if (value === null) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(value);
}

function contextPercent(card: DelegationCard): number | null {
  const { contextTokens, contextWindow } = card.telemetry;
  if (contextTokens === null || contextWindow === null || contextWindow <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((contextTokens / contextWindow) * 100)));
}

function roleLabel(role: Role | null): string {
  if (role === "researcher-code") return "researcher";
  return role ?? "worker";
}

function statusLabel(card: DelegationCard): string {
  if (!card.telemetry.connected) return "offline";
  const status = card.telemetry.status;
  if (!status) return "connected";
  if (status === "idle") return "awaiting callback";
  if (status.startsWith("tool:")) return status.slice("tool:".length);
  return status;
}

function activityBar(width: number, frame: number): string {
  if (width <= 0) return "";
  if (width === 1) return "█";

  const center = ((frame % width) + width) % width;
  return Array.from({ length: width }, (_, index) => {
    const direct = Math.abs(index - center);
    const distance = Math.min(direct, width - direct);
    if (distance === 0) return "█";
    if (distance === 1) return "▓";
    if (distance === 2) return "▒";
    if (distance === 3) return "░";
    return "·";
  }).join("");
}

function cardColor(role: Role | null): "accent" | "success" | "warning" {
  if (role === "reviewer") return "warning";
  if (role === "researcher-code") return "success";
  return "accent";
}

function renderCard(
  card: DelegationCard,
  width: number,
  theme: ThemeLike,
  frame: number,
): string[] {
  const safeWidth = Math.max(24, width);
  const inner = safeWidth - 2;
  const color = cardColor(card.role);
  const role = roleLabel(card.role);
  const title = ` ${role} `;
  const top = `╭${title}${"─".repeat(Math.max(0, inner - title.length))}╮`;
  const bottom = `╰${"─".repeat(inner)}╯`;

  const elapsed = formatElapsed(card.elapsedMs);
  const status = statusLabel(card);
  const statusText = `${card.telemetry.connected ? "●" : "○"} ${status}`;
  const statusRoom = Math.max(1, inner - elapsed.length - 1);
  const statusLine = `${plainPad(statusText, statusRoom)} ${elapsed}`;

  const progressText = card.telemetry.connected && card.telemetry.status !== "idle"
    ? activityBar(inner, frame)
    : card.telemetry.connected
      ? "─".repeat(inner)
      : "┄".repeat(inner);

  const percent = contextPercent(card);
  const contextText = card.telemetry.contextWindow === null
    ? "ctx ?"
    : `ctx ${formatTokens(card.telemetry.contextTokens)}/${formatTokens(card.telemetry.contextWindow)}` +
      (percent === null ? "" : ` · ${percent}%`);

  const taskText = `task ${card.taskId}`;

  const border = (text: string) => theme.fg(color, text);
  const body = (text: string, textColor: ThemeColor) =>
    `│${theme.fg(textColor, plainPad(text, inner))}│`;
  return [
    border(top),
    body(statusLine, card.telemetry.connected ? "text" : "error"),
    body(progressText, "accent"),
    body(contextText, "dim"),
    body(taskText, "muted"),
    border(bottom),
  ];
}

export function renderDelegationGrid(
  cards: readonly DelegationCard[],
  width: number,
  theme: ThemeLike,
  frame = Math.floor(Date.now() / 95),
): string[] {
  if (cards.length === 0 || width <= 0) return [];

  const gap = 2;
  const minCardWidth = 30;
  const maxColumns = Math.min(3, cards.length);
  let columns = Math.max(1, Math.min(maxColumns, Math.floor((width + gap) / (minCardWidth + gap))));
  if (columns < 1) columns = 1;

  const cardWidth = Math.max(24, Math.floor((width - gap * (columns - 1)) / columns));
  const output: string[] = [];

  for (let rowStart = 0; rowStart < cards.length; rowStart += columns) {
    const row = cards.slice(rowStart, rowStart + columns);
    const rendered = row.map((card) => renderCard(card, cardWidth, theme, frame));
    const height = Math.max(...rendered.map((lines) => lines.length));

    for (let line = 0; line < height; line++) {
      const parts = rendered.map((lines) => lines[line] ?? " ".repeat(cardWidth));
      output.push(parts.join(" ".repeat(gap)));
    }
  }

  return output;
}

export class DelegationGridComponent {
  private readonly cards: () => readonly DelegationCard[];
  private readonly theme: ThemeLike;

  constructor(cards: () => readonly DelegationCard[], theme: ThemeLike) {
    this.cards = cards;
    this.theme = theme;
  }

  render(width: number): string[] {
    return renderDelegationGrid(this.cards(), width, this.theme);
  }

  invalidate(): void {
    // Stateless render: theme and cards are read fresh on every render.
  }
}
