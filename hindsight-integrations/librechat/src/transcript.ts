import { createHash } from "node:crypto";
import { z } from "zod";
import { MemoryError } from "./client.js";
import type { ConsentCollection, ConsentDatabase, ConsentKey } from "./consent.js";

/**
 * One conversation, one Hindsight document — the official coding-agent extension's design
 * (`conversation:<session>` documents written as a JSONL transcript under the `conversation`
 * strategy, extended with `update_mode: "append"` and replaced when the history was rewritten).
 *
 * Until 2026-11-08 every LibreChat exchange was its own document, so extraction saw one
 * question/answer pair at a time and could not tell which of several proposals finally won.
 * LibreChat histories are trees (regenerate and edit create sibling branches), so the document
 * always holds the ACTIVE branch: the admitted exchanges from the root to the newest reply.
 */
export interface TranscriptTurn {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

/** A user message and the reply to it, by their LibreChat message ids. */
export interface ExchangeId {
  user: string;
  response: string;
}

export interface BranchExchange extends ExchangeId {
  turns: TranscriptTurn[];
}

/** Message fields the branch walk reads (LibreChat's `messages` collection, v0.8.8 schema). */
export interface TranscriptMessage {
  messageId?: string;
  parentMessageId?: string;
  isCreatedByUser?: boolean;
  text?: string;
  content?: Array<{ type?: string; text?: string | { value?: string } }>;
  createdAt?: string | Date;
}

/** What the document holds for one exchange: its ids and a digest of the text it was written with. */
export interface WrittenExchange extends ExchangeId {
  digest: string;
}

export const exchangeKey = (exchange: ExchangeId): string =>
  `${exchange.user}\n${exchange.response}`;

/**
 * The visible text an exchange was written with (timestamps excluded). LibreChat's Continue and
 * in-place edits keep the reply's message id and change its text, so ids alone would call the
 * document current while it holds the old text.
 */
export function exchangeDigest(exchange: BranchExchange): string {
  return createHash("sha256")
    .update(JSON.stringify(exchange.turns.map((turn) => [turn.role, turn.content])))
    .digest("hex")
    .slice(0, 32);
}

export function written(exchange: BranchExchange): WrittenExchange {
  return { user: exchange.user, response: exchange.response, digest: exchangeDigest(exchange) };
}

const holds = (entry: WrittenExchange, exchange: BranchExchange): boolean =>
  exchangeKey(entry) === exchangeKey(exchange) && entry.digest === exchangeDigest(exchange);

/** Visible text only; never tool results, reasoning, media or skill primes. */
export function visibleText(message: TranscriptMessage): string {
  if (message.text?.trim()) return message.text;
  return (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => (typeof part.text === "string" ? part.text : (part.text?.value ?? "")))
    .join("\n");
}

function timestamp(value: string | Date | undefined): string | undefined {
  if (value == null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** The exchange's turns, skipping an empty side the way the per-exchange capture did. */
export function exchangeTurns(
  user: TranscriptMessage,
  response: TranscriptMessage
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const userText = visibleText(user);
  const assistantText = visibleText(response);
  if (userText.trim())
    turns.push({ role: "user", content: userText, timestamp: timestamp(user.createdAt) });
  if (assistantText.trim())
    turns.push({
      role: "assistant",
      content: assistantText,
      timestamp: timestamp(response.createdAt),
    });
  return turns.map((turn) => (turn.timestamp ? turn : { role: turn.role, content: turn.content }));
}

/**
 * The exchanges on the branch that ends with `current`, oldest first. `history` is the
 * conversation's messages; the walk starts at the current user message's parent, so the current
 * pair needs no stored copy. Returns undefined when the walk cannot reach the root (a message is
 * missing), so the caller can fall back to an append instead of shrinking the document.
 */
export function branchExchanges(
  history: TranscriptMessage[],
  user: TranscriptMessage,
  response: TranscriptMessage
): BranchExchange[] | undefined {
  const byId = new Map<string, TranscriptMessage>();
  for (const message of history) if (message.messageId) byId.set(message.messageId, message);
  const path: TranscriptMessage[] = [];
  const visited = new Set<string>();
  let id = user.parentMessageId;
  // LibreChat roots a conversation at the all-zero parent id.
  while (id && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(id)) {
    if (visited.has(id)) return undefined;
    visited.add(id);
    const message = byId.get(id);
    if (!message) return undefined;
    path.push(message);
    id = message.parentMessageId;
  }
  path.reverse();
  const exchanges: BranchExchange[] = [];
  for (let index = 0; index + 1 < path.length; index++) {
    const ask = path[index];
    const reply = path[index + 1];
    if (
      ask.isCreatedByUser === true &&
      reply.isCreatedByUser !== true &&
      reply.parentMessageId === ask.messageId &&
      ask.messageId &&
      reply.messageId
    ) {
      exchanges.push({
        user: ask.messageId,
        response: reply.messageId,
        turns: exchangeTurns(ask, reply),
      });
    }
  }
  exchanges.push({
    user: user.messageId ?? "",
    response: response.messageId ?? "",
    turns: exchangeTurns(user, response),
  });
  return exchanges;
}

export interface TranscriptRecord {
  documentId: string;
  /** Every exchange ever captured here (ids only): a branch the user returns to keeps them. */
  captured: ExchangeId[];
  /** What the document holds, in order (ids and a text digest — no conversation text is kept). */
  written: WrittenExchange[];
  /**
   * The document holds content this record cannot account for (it existed before the record
   * did, e.g. after a rollback and roll-forward). Such a document is only ever appended to:
   * replacing it from what we know would delete what we do not.
   */
  partial: boolean;
  /** A replace was claimed and its outcome is unknown: the next write replaces again. */
  dirty: boolean;
  /** Appends since the last replace whose outcome is not yet known; a blocked one is a gap. */
  ops: string[];
  /** The conversation's first turn, the item timestamp of every write (as the extension does). */
  startedAt: string;
  version: number;
}

export type TranscriptPlan =
  | { mode: "replace"; exchanges: BranchExchange[] }
  | { mode: "append"; exchanges: BranchExchange[] }
  | { mode: "skip" };

/**
 * The extension's planRetain, over LibreChat's branch: append while what the document holds is a
 * prefix of the active branch's admitted exchanges, replace when it is not (a regenerated or
 * edited turn, a branch switch, a blocked append, an unconfirmed replace). Every uncertain case
 * that could shrink a document resolves to an append instead.
 */
export function planTranscript(input: {
  record: TranscriptRecord | null;
  branch: BranchExchange[] | undefined;
  current: BranchExchange;
  documentExists: boolean;
  blocked: boolean;
}): TranscriptPlan {
  const { record, branch, current } = input;
  const held = record?.written ?? [];
  // A retried completion of an exchange the document already holds, with the same text.
  if (held.some((entry) => holds(entry, current)) && !record?.dirty && !input.blocked) {
    return { mode: "skip" };
  }
  if (!record) {
    if (input.documentExists) return { mode: "append", exchanges: [current] };
    return { mode: "replace", exchanges: [current] };
  }
  if (record.partial || !branch) return { mode: "append", exchanges: [current] };
  const captured = new Set([...record.captured, current].map(exchangeKey));
  const desired = branch.filter((exchange) => captured.has(exchangeKey(exchange)));
  if (record.dirty || input.blocked) return { mode: "replace", exchanges: desired };
  // A continued or edited reply keeps its ids but not its text: that breaks the prefix too.
  const prefix =
    held.length <= desired.length && held.every((entry, index) => holds(entry, desired[index]));
  if (!prefix) return { mode: "replace", exchanges: desired };
  const fresh = desired.slice(held.length);
  return fresh.length ? { mode: "append", exchanges: fresh } : { mode: "skip" };
}

const exchangeRow = z.object({ user: z.string(), response: z.string() }).strict();
const writtenRow = exchangeRow.extend({ digest: z.string() }).strict();
const recordRow = z.object({
  documentId: z.string().min(1),
  captured: z.array(exchangeRow),
  written: z.array(writtenRow),
  partial: z.boolean(),
  dirty: z.boolean(),
  ops: z.array(z.string()),
  startedAt: z.string(),
  version: z.number().int().positive(),
});
const recordProjection = {
  _id: 0,
  documentId: 1,
  captured: 1,
  written: 1,
  partial: 1,
  dirty: 1,
  ops: 1,
  startedAt: 1,
  version: 1,
} as const;

type RecordFields = Omit<TranscriptRecord, "version">;

/**
 * Per-conversation transcript state, next to the consent and turn records it depends on (Mongo is
 * durable and covered by LibreChat's backups; the outbox volume is neither shared nor backed up).
 */
export class TranscriptStore {
  private constructor(private readonly records: ConsentCollection) {}

  static async open(database: ConsentDatabase): Promise<TranscriptStore> {
    const records = database.collection("hindsighttranscripts");
    await records.createIndex(
      { user: 1, conversationId: 1 },
      { unique: true, name: "hindsight_transcript_conversation" }
    );
    return new TranscriptStore(records);
  }

  async read(key: ConsentKey): Promise<TranscriptRecord | null> {
    const row = await this.records.findOne(
      { user: key.user, conversationId: key.conversationId },
      { projection: recordProjection }
    );
    if (row == null) return null;
    const parsed = recordRow.safeParse(row);
    if (!parsed.success) throw new MemoryError("transcript_record_invalid");
    return parsed.data;
  }

  /** Compare-and-set on `version`; false when another writer got there first. */
  async write(
    key: ConsentKey,
    next: RecordFields,
    expected: TranscriptRecord | null
  ): Promise<boolean> {
    const filter = { user: key.user, conversationId: key.conversationId };
    if (expected === null) {
      try {
        await this.records.insertOne({ ...filter, ...next, version: 1, updatedAt: new Date() });
        return true;
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 11000) return false;
        throw error;
      }
    }
    const result = await this.records.updateOne(
      { ...filter, version: expected.version },
      { $set: { ...next, updatedAt: new Date() }, $inc: { version: 1 } }
    );
    return result.matchedCount === 1;
  }
}
