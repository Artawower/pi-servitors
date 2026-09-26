import type { Role } from "../types.ts";

export type DelegationPacket = {
  taskId: string;
  replyTo: string;
  role: Role | null;
};

const ROLE_SET = new Set<Role>(["coder", "reviewer", "researcher-code"]);

function firstField(text: string, name: string): string | null {
  const pattern = new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, "im");
  const match = pattern.exec(text);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

export function parseDelegationPacket(message: string): DelegationPacket | null {
  const taskId = firstField(message, "TASK_ID");
  const replyTo = firstField(message, "REPLY_TO");
  if (!taskId || !replyTo) return null;

  const rawRole = firstField(message, "ROLE")?.toLowerCase() ?? null;
  const role = rawRole && ROLE_SET.has(rawRole as Role) ? (rawRole as Role) : null;

  return { taskId, replyTo, role };
}

export function callbackTaskIds(message: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const pattern = /^\s*TASK_ID:\s*(.+?)\s*$/gim;

  for (const match of message.matchAll(pattern)) {
    const taskId = match[1]?.trim();
    if (!taskId || seen.has(taskId)) continue;
    seen.add(taskId);
    result.push(taskId);
  }

  return result;
}

export function looksLikePiLinkDelivery(message: string): boolean {
  return /\[Link:\s*\d+\s+message\(s\)\s+received\]/i.test(message);
}

/**
 * Extract visible text from Pi agent messages without depending on a concrete
 * message union. This intentionally accepts unknown so it survives Pi custom
 * message representation changes.
 */
export function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return message.map(messageText).filter(Boolean).join("\n");
  if (!message || typeof message !== "object") return "";

  const record = message as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (Array.isArray(record.content)) return messageText(record.content);
  if (record.message) return messageText(record.message);
  return "";
}

/**
 * Pi custom messages sent with triggerTurn currently bypass before_agent_start.
 * The context event still contains the delivered [Link: ...] message before the
 * provider call, so use it as the authoritative completion observation point.
 */
export function callbackTaskIdsFromContext(messages: readonly unknown[]): string[] {
  // `context` contains the full conversation history. Only the newest visible
  // message can be the trigger for the turn we are about to run; scanning the
  // whole history would re-complete a newly reused TASK_ID because an older
  // pi-link callback remains in context.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messageText(messages[index]);
    if (!text) continue;
    return looksLikePiLinkDelivery(text) ? callbackTaskIds(text) : [];
  }

  return [];
}
