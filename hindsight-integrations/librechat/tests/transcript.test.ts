import { describe, expect, it } from "vitest";
import { branchExchanges, exchangeTurns, planTranscript, written } from "../src/transcript.js";
import type { BranchExchange, TranscriptMessage, TranscriptRecord } from "../src/transcript.js";

const ROOT = "00000000-0000-0000-0000-000000000000";
const byId = new Map<string, TranscriptMessage>();

/** A linear history u1 → r1 → u2 → r2 …, with optional siblings added by each test. */
function message(
  messageId: string,
  parentMessageId: string,
  isCreatedByUser: boolean,
  minute: number,
  text = `${isCreatedByUser ? "ask" : "answer"} ${messageId}`
): TranscriptMessage {
  const created = {
    messageId,
    parentMessageId,
    isCreatedByUser,
    text,
    createdAt: new Date(Date.UTC(2026, 10, 8, 9, minute)),
  };
  byId.set(messageId, created);
  return created;
}

/** The document's entry for the exchange that `response` answers, as it was written. */
function entry(response: string) {
  const reply = byId.get(response)!;
  const user = byId.get(reply.parentMessageId!)!;
  return written({
    user: user.messageId!,
    response,
    turns: exchangeTurns(user, reply),
  });
}

const u1 = message("u1", ROOT, true, 0);
const r1 = message("r1", "u1", false, 1);
const u2 = message("u2", "r1", true, 2);
const r2 = message("r2", "u2", false, 3);
const u3 = message("u3", "r2", true, 4);
const r3 = message("r3", "u3", false, 5);
const linear = [u1, r1, u2, r2, u3, r3];

const ids = (exchanges: BranchExchange[]) => exchanges.map((exchange) => exchange.response);

function record(responses: string[], overrides: Partial<TranscriptRecord> = {}): TranscriptRecord {
  const held = responses.map(entry);
  return {
    documentId: "conversation:c",
    captured: held.map(({ user, response }) => ({ user, response })),
    written: held,
    partial: false,
    dirty: false,
    ops: [],
    startedAt: "2026-11-08T09:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

function plan(
  history: TranscriptMessage[],
  user: TranscriptMessage,
  reply: TranscriptMessage,
  existing: TranscriptRecord | null,
  options: { documentExists?: boolean; blocked?: boolean } = {}
) {
  const branch = branchExchanges(history, user, reply);
  const current = branch?.at(-1) ?? {
    user: user.messageId!,
    response: reply.messageId!,
    turns: [],
  };
  return planTranscript({
    record: existing,
    branch,
    current,
    documentExists: options.documentExists ?? false,
    blocked: options.blocked ?? false,
  });
}

describe("branchExchanges", () => {
  it("walks the active branch from the root and pairs each question with its answer", () => {
    const branch = branchExchanges(linear, u3, r3);
    expect(ids(branch!)).toEqual(["r1", "r2", "r3"]);
    expect(branch![0].turns).toEqual([
      { role: "user", content: "ask u1", timestamp: "2026-11-08T09:00:00.000Z" },
      { role: "assistant", content: "answer r1", timestamp: "2026-11-08T09:01:00.000Z" },
    ]);
  });

  it("follows a regenerated or edited branch, not its siblings", () => {
    const r2b = message("r2b", "u2", false, 6);
    const u3b = message("u3b", "r2b", true, 7);
    const r3b = message("r3b", "u3b", false, 8);
    expect(ids(branchExchanges([...linear, r2b, u3b, r3b], u3b, r3b)!)).toEqual([
      "r1",
      "r2b",
      "r3b",
    ]);
  });

  it("gives up rather than guessing when a message on the path is missing", () => {
    expect(branchExchanges([u1, r1, r2, u3, r3], u3, r3)).toBeUndefined();
  });
});

describe("planTranscript", () => {
  it("starts a new conversation's document with a replace", () => {
    expect(plan([], u1, r1, null)).toMatchObject({ mode: "replace" });
  });

  it("appends the new exchange while the document holds a prefix of the branch", () => {
    const result = plan(linear, u3, r3, record(["r1", "r2"]));
    expect(result.mode).toBe("append");
    expect(result.mode === "append" && ids(result.exchanges)).toEqual(["r3"]);
  });

  it("replaces the document when the last answer was regenerated", () => {
    const r3b = message("r3b", "u3", false, 9);
    const result = plan([...linear, r3b], u3, r3b, record(["r1", "r2", "r3"]));
    expect(result.mode).toBe("replace");
    expect(result.mode === "replace" && ids(result.exchanges)).toEqual(["r1", "r2", "r3b"]);
  });

  it("replaces the document when an earlier message was edited into a new branch", () => {
    const u2b = message("u2b", "r1", true, 9);
    const r2b = message("r2b", "u2b", false, 10);
    const result = plan([...linear, u2b, r2b], u2b, r2b, record(["r1", "r2", "r3"]));
    expect(result.mode).toBe("replace");
    expect(result.mode === "replace" && ids(result.exchanges)).toEqual(["r1", "r2b"]);
  });

  it("keeps an exchange that was never admitted (an Off turn) out of the document", () => {
    // r2 happened while consent was Off: it is on the branch but was never captured.
    const result = plan(linear, u3, r3, record(["r1"]));
    expect(result.mode).toBe("append");
    expect(result.mode === "append" && ids(result.exchanges)).toEqual(["r3"]);
    const r3b = message("r3b", "u3", false, 9);
    const regenerated = plan([...linear, r3b], u3, r3b, record(["r1", "r3"]));
    expect(regenerated.mode === "replace" && ids(regenerated.exchanges)).toEqual(["r1", "r3b"]);
  });

  it("brings back captured exchanges when the user returns to an earlier branch", () => {
    const r2b = message("r2b", "u2", false, 9);
    const switched = record(["r1", "r2b"], {
      captured: [
        { user: "u1", response: "r1" },
        { user: "u2", response: "r2" },
        { user: "u2", response: "r2b" },
      ],
    });
    const result = plan([...linear, r2b], u3, r3, switched);
    expect(result.mode === "replace" && ids(result.exchanges)).toEqual(["r1", "r2", "r3"]);
  });

  it("replaces after a blocked append or an unconfirmed replace instead of building on a gap", () => {
    expect(plan(linear, u3, r3, record(["r1", "r2"]), { blocked: true }).mode).toBe("replace");
    expect(plan(linear, u3, r3, record(["r1", "r2"], { dirty: true })).mode).toBe("replace");
  });

  it("never shrinks a document it has no record of: it appends instead", () => {
    const result = plan(linear, u3, r3, null, { documentExists: true });
    expect(result.mode).toBe("append");
    expect(result.mode === "append" && ids(result.exchanges)).toEqual(["r3"]);
  });

  it("only appends to a partial document, even when the branch changed", () => {
    const r3b = message("r3b", "u3", false, 9);
    const partial = record(["r3"], { partial: true });
    expect(plan([...linear, r3b], u3, r3b, partial).mode).toBe("append");
  });

  it("appends rather than replacing when the branch cannot be read", () => {
    const result = plan([u1, r1, r2, u3, r3], u3, r3, record(["r1", "r2"]));
    expect(result.mode).toBe("append");
  });

  it("skips a retried completion of an exchange the document already holds", () => {
    expect(plan(linear, u3, r3, record(["r1", "r2", "r3"])).mode).toBe("skip");
  });

  it("replaces when a reply was continued or edited in place (same ids, new text)", () => {
    const held = record(["r1", "r2", "r3"]);
    const continued = { ...r3, text: "answer r3, continued with the rest of the reply" };
    const result = plan(
      linear.map((m) => (m.messageId === "r3" ? continued : m)),
      u3,
      continued,
      held
    );
    expect(result.mode).toBe("replace");
    expect(result.mode === "replace" && result.exchanges.at(-1)?.turns.at(-1)?.content).toBe(
      continued.text
    );
  });
});
