import { z } from "zod";
import type { MemoryClient } from "./client.js";
import type { MemoryConfig, QueueStatus } from "./types.js";

export interface MemoryToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: "string"; description: string }>;
    required: string[];
    additionalProperties: false;
  };
}

export interface MemoryTool extends MemoryToolDefinition {
  schema: z.ZodObject<Record<string, z.ZodString>, "strict">;
  func: (input: unknown) => Promise<string>;
}

export type MemoryInspector = (text: string) => void;

export function readTools(
  client: MemoryClient,
  config: MemoryConfig,
  inspect: MemoryInspector,
  parentSignal: AbortSignal,
  deliveryStatus: () => Promise<QueueStatus>
): MemoryTool[] {
  function tool(
    name: string,
    description: string,
    fields: Record<string, string>,
    execute: (input: Record<string, string>, signal: AbortSignal) => Promise<unknown>
  ): MemoryTool {
    const schema = z
      .object(Object.fromEntries(Object.keys(fields).map((key) => [key, z.string().min(1)])))
      .strict();
    return {
      name,
      description,
      schema,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(fields).map(([key, text]) => [
            key,
            { type: "string" as const, description: text },
          ])
        ),
        required: Object.keys(fields),
        additionalProperties: false,
      },
      func: async (input) => {
        const args = schema.parse(input);
        inspect(JSON.stringify(args));
        const deadline = AbortSignal.timeout(config.toolTimeoutMs ?? 330000);
        const signal = AbortSignal.any([parentSignal, deadline]);
        signal.throwIfAborted();
        const result = JSON.stringify(await execute(args, signal));
        signal.throwIfAborted();
        inspect(result);
        return result;
      },
    };
  }
  return [
    tool(
      "hindsight_recall",
      "Search this user's private Hindsight memories. Conversation capture is automatic.",
      { query: "Memory search query" },
      (args, signal) => client.recallData(args.query, signal)
    ),
    tool(
      "hindsight_reflect",
      "Reason over private memories to explain past decisions or synthesize context.",
      { query: "Question to reason about" },
      (args, signal) => client.reflectData(args.query, signal)
    ),
    tool(
      "hindsight_list_knowledge_pages",
      "List the knowledge pages in the private memory bank.",
      {},
      (_args, signal) => client.knowledgeTree(signal)
    ),
    tool(
      "hindsight_search_knowledge_pages",
      "Find knowledge pages relevant to the current task.",
      { query: "Knowledge-page search query" },
      (args, signal) => client.searchPages(args.query, signal)
    ),
    tool(
      "hindsight_read_knowledge_page",
      "Read a private knowledge page by its ID.",
      { pageId: "Knowledge-page ID" },
      (args, signal) => client.readPage(args.pageId, signal)
    ),
    tool(
      "hindsight_get_document",
      "Read an original source document from the private bank.",
      { documentId: "Source document ID" },
      (args, signal) => client.document(args.documentId, signal)
    ),
    tool(
      "hindsight_delivery_status",
      "Check this adapter's pending and blocked delivery counts, not global server consolidation.",
      {},
      () => deliveryStatus()
    ),
    tool(
      "hindsight_diagnose",
      "Inspect safe adapter configuration and delivery state; never returns credential values.",
      {},
      async () => ({
        bankId: config.bankId,
        baseUrl: config.baseUrl,
        apiKeyConfigured: Boolean(config.apiKey),
        retrieval: config.retrieval ?? "recall",
        sensitiveDataProtectionRequired: config.requireSensitiveDataProtection !== false,
        delivery: await deliveryStatus(),
      })
    ),
  ];
}
