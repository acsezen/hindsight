import type { Budget } from "@vectorize-io/hindsight-client";

export interface MemoryConfig {
  baseUrl: string;
  apiKey?: string;
  bankId: string;
  ownerUserId: string;
  outboxDir: string;
  retrieval?: "recall" | "reflect" | "pages";
  budget?: Budget;
  maxContextTokens?: number;
  maxContextChars?: number;
  retrievalTimeoutMs?: number;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  nativeTools?: boolean;
  toolTimeoutMs?: number;
  requireSensitiveDataProtection?: boolean;
}

export interface MemoryActor {
  userId: string;
  temporary?: boolean;
  hindsightEnabled?: boolean;
}

export interface MemoryContext {
  text: string;
  status: "available" | "empty" | "unavailable" | "skipped";
  source?: "recall" | "reflect" | "pages";
}

export interface MemoryEvent {
  code: string;
  operationId?: string;
  status?: number;
  reason?: string;
}

export type MemoryReporter = (event: MemoryEvent) => void;

export interface QueueStatus {
  pending: number;
  blocked: number;
}

export interface CaptureResult {
  status: "queued" | "completed" | "skipped";
  operationIds: string[];
}
