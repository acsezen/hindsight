import { createClient, createConfig, sdk } from "@vectorize-io/hindsight-client";
import { z } from "zod";
import type {
  DocumentResponse,
  KnowledgePageResponse,
  KnowledgePageSearchResponse,
  KnowledgeTreeResponse,
  RecallResponse,
  ReflectResponse,
} from "@vectorize-io/hindsight-client";
import type { MemoryConfig } from "./types.js";
import type { CaptureJob } from "./records.js";

export class MemoryError extends Error {
  constructor(
    public readonly code: string,
    public readonly status?: number
  ) {
    // Upstream errors may contain submitted text or credentials. Never expose them.
    super(code);
    this.name = "MemoryError";
  }
}

function unwrap<T>(result: { data?: T; response?: Response }): T {
  if (result.data == null) {
    throw new MemoryError("hindsight_request_failed", result.response?.status);
  }
  return result.data;
}

export class MemoryClient {
  private readonly client;

  constructor(
    private readonly config: MemoryConfig,
    private readonly getApiKey?: () => string | undefined
  ) {
    const url = new URL(config.baseUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    ) {
      throw new MemoryError("unsafe_hindsight_url");
    }
    this.client = createClient(
      createConfig({
        baseUrl: config.baseUrl.replace(/\/$/, ""),
        headers: {
          "User-Agent": "hindsight-librechat/0.1.0",
        },
        // Never forward a backend credential to a redirect target.
        fetch: (request) => {
          const target = new URL(
            typeof request === "string"
              ? request
              : request instanceof URL
                ? request.href
                : request.url
          );
          const path = decodeURIComponent(target.pathname);
          const prefix = `${decodeURIComponent(url.pathname).replace(/\/$/, "")}/v1/default/banks/${config.bankId}/`;
          if (
            target.origin !== url.origin ||
            !path.startsWith(prefix) ||
            path.length <= prefix.length ||
            path.split("/").some((part) => part === "." || part === "..")
          ) {
            throw new MemoryError("bank_scope_violation");
          }
          const key = this.getApiKey ? this.getApiKey() : this.config.apiKey;
          if (this.getApiKey && !key) throw new MemoryError("missing_hindsight_api_key");
          const headers = new Headers(request instanceof Request ? request.headers : undefined);
          if (key) headers.set("Authorization", `Bearer ${key}`);
          else headers.delete("Authorization");
          return fetch(request, { headers, redirect: "error" });
        },
      })
    );
  }

  async recall(query: string, signal: AbortSignal): Promise<string> {
    const result = await this.recallData(query, signal);
    return result.results.map((fact) => `- ${fact.text}`).join("\n");
  }

  async recallData(query: string, signal: AbortSignal): Promise<RecallResponse> {
    return unwrap(
      await sdk.recallMemories({
        client: this.client,
        path: { bank_id: this.config.bankId },
        body: {
          query,
          budget: this.config.budget ?? "low",
          max_tokens: this.config.maxContextTokens ?? 2048,
        },
        signal,
      })
    );
  }

  async reflect(query: string, signal: AbortSignal): Promise<string> {
    return (await this.reflectData(query, signal)).text;
  }

  async reflectData(query: string, signal: AbortSignal): Promise<ReflectResponse> {
    return unwrap(
      await sdk.reflect({
        client: this.client,
        path: { bank_id: this.config.bankId },
        body: {
          query,
          budget: this.config.budget ?? "low",
          max_tokens: this.config.maxContextTokens ?? 2048,
        },
        signal,
      })
    );
  }

  async knowledgeTree(signal: AbortSignal): Promise<KnowledgeTreeResponse> {
    return unwrap(
      await sdk.getKnowledgeBaseTree({
        client: this.client,
        path: { bank_id: this.config.bankId },
        signal,
      })
    );
  }

  async searchPages(query: string, signal: AbortSignal): Promise<KnowledgePageSearchResponse> {
    return unwrap(
      await sdk.searchKnowledgeBase({
        client: this.client,
        path: { bank_id: this.config.bankId },
        query: { q: query, limit: 3 },
        signal,
      })
    );
  }

  async readPage(pageId: string, signal: AbortSignal): Promise<KnowledgePageResponse | null> {
    const response = await sdk.getKnowledgePage({
      client: this.client,
      path: { bank_id: this.config.bankId, page_id: pageId },
      signal,
    });
    return response.response?.status === 404 ? null : unwrap(response);
  }

  async document(documentId: string, signal: AbortSignal): Promise<DocumentResponse | null> {
    const response = await sdk.getDocument({
      client: this.client,
      path: { bank_id: this.config.bankId, document_id: documentId },
      signal,
    });
    return response.response?.status === 404 ? null : unwrap(response);
  }

  async pages(query: string, signal: AbortSignal): Promise<string> {
    const result = unwrap(
      await sdk.searchKnowledgeBase({
        client: this.client,
        path: { bank_id: this.config.bankId },
        query: { q: query, limit: 3 },
        signal,
      })
    );
    const pages = await Promise.all(
      result.results.map(async (page) => {
        const full = unwrap(
          await sdk.getKnowledgePage({
            client: this.client,
            path: { bank_id: this.config.bankId, page_id: page.id },
            signal,
          })
        );
        const body = full.body ?? full.markdown;
        return body ? `# ${full.name}\n${body}` : "";
      })
    );
    return pages.filter(Boolean).join("\n\n");
  }

  private async requireProtection(signal: AbortSignal): Promise<void> {
    if (this.config.requireSensitiveDataProtection === false) return;
    const bank = unwrap(
      await sdk.getBankConfig({
        client: this.client,
        path: { bank_id: this.config.bankId },
        signal,
      })
    );
    const policy = z
      .object({
        enabled: z.literal(true),
        rules: z.array(
          z.object({ on: z.union([z.string(), z.array(z.string())]), action: z.string() })
        ),
      })
      .safeParse(bank.config.memory_defense);
    const protectedBank =
      bank.bank_id === this.config.bankId &&
      policy.success &&
      policy.data.rules.some(
        (rule) =>
          (Array.isArray(rule.on)
            ? rule.on.includes("sensitive_data")
            : rule.on === "sensitive_data") && ["redact", "block"].includes(rule.action)
      );
    if (!protectedBank) throw new MemoryError("bank_protection_required", 503);
  }

  async submit(job: CaptureJob, signal: AbortSignal): Promise<void> {
    // A typo/new bank must not silently auto-create an unprotected memory store.
    await this.requireProtection(signal);
    const result = unwrap(
      await sdk.retainMemories({
        client: this.client,
        path: { bank_id: this.config.bankId },
        body: { ...job.request, async: true, operation_id: job.operationId },
        signal,
      })
    );
    if (
      result.success !== true ||
      result.async !== true ||
      result.bank_id !== this.config.bankId ||
      result.operation_id !== job.operationId
    ) {
      throw new MemoryError("invalid_retain_acknowledgment");
    }
  }

  async poll(operationId: string, signal: AbortSignal): Promise<string> {
    const response = await sdk.getOperationStatus({
      client: this.client,
      path: { bank_id: this.config.bankId, operation_id: operationId },
      signal,
    });
    if (response.response?.status === 404) return "not_found";
    const result = unwrap(response);
    if (result.operation_id !== operationId) {
      throw new MemoryError("invalid_operation_acknowledgment");
    }
    return result.status;
  }
}
