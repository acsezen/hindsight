import { z } from "zod";

const positive = z.number().int().positive();

export const memoryConfigSchema = z
  .object({
    baseUrl: z.string().url(),
    apiKey: z.string().min(1).optional(),
    bankId: z
      .string()
      .trim()
      .min(1)
      .refine((value) => !/[\\/]/.test(value) && value !== "." && value !== ".."),
    ownerUserId: z.string().trim().min(1),
    outboxDir: z.string().min(1),
    retrieval: z.enum(["recall", "reflect", "pages"]).optional(),
    budget: z.enum(["low", "mid", "high"]).optional(),
    maxContextTokens: positive.optional(),
    maxContextChars: positive.optional(),
    retrievalTimeoutMs: positive.optional(),
    requestTimeoutMs: positive.optional(),
    pollIntervalMs: positive.optional(),
    nativeTools: z.boolean().optional(),
    toolTimeoutMs: positive.optional(),
    requireSensitiveDataProtection: z.boolean().optional(),
  })
  .strict();

export const hindsightConfigSchema = z.union([
  memoryConfigSchema.omit({ apiKey: true }).extend({
    enabled: z.literal(true),
    apiKeyEnv: z.string().min(1).default("HINDSIGHT_API_KEY"),
    outboxDir: z.string().min(1).default("/app/data/hindsight"),
  }),
  // A hard-off section is inert even when no backend is configured yet.
  z.object({ enabled: z.literal(false).default(false) }),
]);
