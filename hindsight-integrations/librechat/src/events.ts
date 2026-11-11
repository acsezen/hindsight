import type { MemoryEvent } from "./types.js";

/** Events of the background delivery worker: they belong to the owner, not to the request that woke it. */
const DELIVERY_CODES = new Set([
  "capture_completed",
  "capture_blocked",
  "capture_retry_pending",
  "invalid_outbox_record",
  "outbox_unavailable",
]);

/** Events that report success; every other event reports something that did not happen. */
const SUCCESS_CODES = new Set(["capture_completed"]);

export interface MemoryLogEntry {
  level: "info" | "warn";
  /** One line: `[hindsight-memory] <code> operation=<id> status=<n> reason=<code>`. */
  message: string;
  /** A delivery event, which the host logs without the waking request's context. */
  delivery: boolean;
}

/** Event fields are codes, ids and numbers; anything else is replaced, so a value cannot forge a line. */
function token(value: string | number): string {
  return String(value).replace(/[^\w.:-]/g, "_");
}

/** How a host should log a memory event. Hosts whose log format drops metadata still see every field. */
export function memoryLogEntry(event: MemoryEvent): MemoryLogEntry {
  const fields = [token(event.code)];
  if (event.operationId) fields.push(`operation=${token(event.operationId)}`);
  if (event.status !== undefined) fields.push(`status=${token(event.status)}`);
  if (event.reason) fields.push(`reason=${token(event.reason)}`);
  return {
    level: SUCCESS_CODES.has(event.code) ? "info" : "warn",
    message: `[hindsight-memory] ${fields.join(" ")}`,
    delivery: DELIVERY_CODES.has(event.code),
  };
}
