import { createHash } from "node:crypto";
import { z } from "zod";
import type { CompletedExchange, MemoryConfig } from "./types.js";

const itemSchema = z
  .object({
    content: z.string().min(1),
    document_id: z.string().min(1),
    context: z.string(),
    metadata: z.record(z.string()),
    tags: z.array(z.string()),
    observation_scopes: z.literal("shared"),
    timestamp: z.string().datetime().optional(),
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
    request: z.object({ items: z.array(itemSchema).length(1) }).strict(),
  })
  .strict();

export type CaptureJob = z.infer<typeof jobSchema>;

export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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

export function captureJob(config: MemoryConfig, exchange: CompletedExchange): CaptureJob {
  const identity = [
    exchange.userId,
    exchange.conversationId,
    exchange.userMessageId,
    exchange.responseMessageId,
    exchange.userText,
    exchange.assistantText,
  ];
  // Each committed reply/version has its own source document. A conversation-wide
  // replacement would erase other branches; append would duplicate transport retries.
  const documentId = `librechat:${fingerprint(JSON.stringify(identity))}`;
  const request: CaptureJob["request"] = {
    items: [
      {
        content: [
          exchange.userText.trim() ? `User:\n${exchange.userText}` : "",
          exchange.assistantText.trim() ? `Assistant:\n${exchange.assistantText}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        document_id: documentId,
        context:
          "LibreChat conversation exchange. Assistant statements are responses, not independently verified user facts.",
        metadata: {
          source: "librechat",
          harness: "librechat",
          user_id: exchange.userId,
          conversation_id: exchange.conversationId,
          user_message_id: exchange.userMessageId,
          response_message_id: exchange.responseMessageId,
          ...(exchange.model ? { model: exchange.model } : {}),
        },
        tags: ["source:librechat", `conversation:${fingerprint(exchange.conversationId)}`],
        observation_scopes: "shared",
        ...(exchange.timestamp ? { timestamp: exchange.timestamp } : {}),
      },
    ],
  };
  return jobSchema.parse({
    version: 1,
    operationId: operationUuid(JSON.stringify({ bankId: config.bankId, request })),
    bankId: config.bankId,
    ownerUserId: config.ownerUserId,
    submitted: false,
    attempts: 0,
    nextAttemptAt: 0,
    request,
  });
}
