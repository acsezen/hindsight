import { describe, expect, it } from "vitest";
import { memoryLogEntry } from "../src/index.js";

describe("memoryLogEntry", () => {
  it("puts every field in the message, since LibreChat's console format drops metadata", () => {
    expect(
      memoryLogEntry({
        code: "capture_retry_pending",
        operationId: "0b6c5f0e-8d1a-4c39-9a51-3f8f4f2b7c10",
        status: 503,
        reason: "hindsight_timeout",
      })
    ).toEqual({
      level: "warn",
      message:
        "[hindsight-memory] capture_retry_pending operation=0b6c5f0e-8d1a-4c39-9a51-3f8f4f2b7c10 status=503 reason=hindsight_timeout",
      delivery: true,
    });
  });

  it("logs a completed capture as info and everything else as a warning", () => {
    expect(memoryLogEntry({ code: "capture_completed", operationId: "op" })).toMatchObject({
      level: "info",
      message: "[hindsight-memory] capture_completed operation=op",
    });
    for (const code of ["capture_blocked", "retrieval_unavailable", "consent_turn_invalid"]) {
      expect(memoryLogEntry({ code }).level).toBe("warn");
    }
  });

  it("marks only the delivery worker's events as delivery", () => {
    const delivery = [
      "capture_completed",
      "capture_blocked",
      "capture_retry_pending",
      "invalid_outbox_record",
      "outbox_unavailable",
    ];
    for (const code of delivery) expect(memoryLogEntry({ code }).delivery).toBe(true);
    for (const code of [
      "retrieval_unavailable",
      "capture_storage_unavailable",
      "capture_skipped_consent_changed",
      "transcript_conflict",
    ]) {
      expect(memoryLogEntry({ code }).delivery).toBe(false);
    }
  });

  it("keeps one line per event whatever a field holds", () => {
    const { message } = memoryLogEntry({
      code: "retrieval_unavailable\nwarn: forged",
      reason: 'a "quoted" {json}',
    });
    expect(message).toBe(
      "[hindsight-memory] retrieval_unavailable_warn:_forged reason=a__quoted___json_"
    );
  });

  it("omits fields that are absent and keeps a zero status", () => {
    expect(memoryLogEntry({ code: "outbox_unavailable" }).message).toBe(
      "[hindsight-memory] outbox_unavailable"
    );
    expect(memoryLogEntry({ code: "retrieval_unavailable", status: 0 }).message).toBe(
      "[hindsight-memory] retrieval_unavailable status=0"
    );
  });
});
