import { createHash } from "node:crypto";
import { z } from "zod";
import type { BranchExchange, ExchangeId } from "./transcript.js";
import type { MemoryActor, MemoryConfig } from "./types.js";

const itemSchema = z
  .object({
    content: z.string().min(1),
    document_id: z.string().min(1),
    context: z.string(),
    metadata: z.record(z.string()),
    tags: z.array(z.string()),
    observation_scopes: z.literal("shared"),
    timestamp: z.string().datetime().optional(),
    // Absent on jobs queued before conversation documents (2026-11-08): those drain unchanged.
    strategy: z.literal("conversation").optional(),
    update_mode: z.literal("append").optional(),
  })
  .strict();

export const jobSchema = z
  .object({
    version: z.literal(1),
    operationId: z.string().uuid(),
    bankId: z.string().min(1),
    ownerUserId: z.string().min(1),
    submitted: z.boolean(),
    attempts: z.number().int().nonnegative(),
    nextAttemptAt: z.number().nonnegative(),
    /** Submission order within one document; absent on older per-exchange jobs. */
    sequence: z.number().int().nonnegative().optional(),
    request: z.object({ items: z.array(itemSchema).length(1) }).strict(),
  })
  .strict();

export type CaptureJob = z.infer<typeof jobSchema>;

/** One write to a conversation's document, as planned by `planTranscript`. */
export interface TranscriptWrite extends MemoryActor {
  conversationId: string;
  mode: "append" | "replace";
  exchanges: BranchExchange[];
  /** The conversation's first turn: every write's item timestamp, as the extension does. */
  startedAt: string;
  /** What the document held before a replace; part of its operation identity (see below). */
  previous: ExchangeId[];
}

/**
 * The coding-agent extension's retain context, with "the coding agent" replaced by the LibreChat
 * assistant: user turns are the user's words, assistant turns are claims, not established facts.
 */
export const RETAIN_CONTEXT =
  "conversation between the user and an AI assistant in LibreChat: user turns are the user's words and " +
  "decisions, assistant turns are the assistant's. When an assistant turn says something is fixed, true or " +
  'done, record it as the assistant\'s claim ("the assistant said X"), not as an established fact.';

export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function conversationDocumentId(conversationId: string): string {
  return `conversation:${conversationId}`;
}

function operationUuid(value: string): string {
  // UUIDv5 in the URL namespace: identical payloads retain one operation identity.
  const hash = createHash("sha1")
    .update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"))
    .update(value)
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** JSONL, one turn per line: the server's structured chunker never splits a turn. */
function jsonl(exchanges: BranchExchange[]): string {
  return exchanges
    .flatMap((exchange) => exchange.turns)
    .map((turn) => JSON.stringify(turn))
    .join("\n");
}

let lastSequence = 0;

/** Monotonic across calls in this process, so FIFO holds even within one millisecond. */
function nextSequence(): number {
  lastSequence = Math.max(Date.now() * 1000, lastSequence + 1);
  return lastSequence;
}

/**
 * The jobs for one write. A replace is one job holding the whole branch. An append is one job
 * per new exchange, so its content and operation id depend on that exchange alone: a write that
 * is planned again after a lost acknowledgement re-creates the same job, which the outbox and the
 * server both collapse into the original instead of appending the exchange twice.
 */
export function transcriptJobs(config: MemoryConfig, write: TranscriptWrite): CaptureJob[] {
  const documentId = conversationDocumentId(write.conversationId);
  const item = {
    document_id: documentId,
    context: RETAIN_CONTEXT,
    metadata: {
      source: "librechat",
      harness: "librechat",
      user_id: write.userId,
      conversation_id: write.conversationId,
    },
    // `source:chat` + `harness:<id>`, as every conversation the extension retains carries.
    tags: ["source:chat", "harness:librechat"],
    observation_scopes: "shared" as const,
    strategy: "conversation" as const,
    timestamp: write.startedAt,
  };
  const job = (request: CaptureJob["request"], identity: string): CaptureJob =>
    jobSchema.parse({
      version: 1,
      operationId: operationUuid(identity),
      bankId: config.bankId,
      ownerUserId: config.ownerUserId,
      submitted: false,
      attempts: 0,
      nextAttemptAt: 0,
      sequence: nextSequence(),
      request,
    });
  if (write.mode === "replace") {
    const content = jsonl(write.exchanges);
    if (!content) return [];
    const request = { items: [{ ...item, content }] };
    // Content alone repeats when a user returns to an earlier branch (A → B → A), and the
    // server acknowledges an already-completed id without applying it, which would leave B
    // stored. Naming what the document held before keeps each replace distinct (extension #5845).
    return [
      job(request, JSON.stringify({ bankId: config.bankId, request, previous: write.previous })),
    ];
  }
  return write.exchanges
    .filter((exchange) => exchange.turns.length > 0)
    .map((exchange) => {
      const request = {
        items: [{ ...item, content: jsonl([exchange]), update_mode: "append" as const }],
      };
      // The exchange's ids are part of the identity (not the content): two exchanges with the
      // same text are distinct appends, while a re-planned one keeps its id.
      const exchangeId = { user: exchange.user, response: exchange.response };
      return job(request, JSON.stringify({ bankId: config.bankId, request, exchange: exchangeId }));
    });
}
