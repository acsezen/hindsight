import type { KnowledgeNode } from "@vectorize-io/hindsight-client";
import { memoryConfigSchema } from "./config.js";
import { MemoryClient, MemoryError } from "./client.js";
import { knowledgeGuide, memoryBlock } from "./knowledge.js";
import { RetainOutbox } from "./outbox.js";
import type { OperationState } from "./outbox.js";
import { transcriptJobs } from "./records.js";
import type { TranscriptWrite } from "./records.js";
import { readTools } from "./tools.js";
import type { MemoryInspector, MemoryTool } from "./tools.js";
import type {
  CaptureResult,
  MemoryActor,
  MemoryConfig,
  MemoryContext,
  MemoryReporter,
  QueueStatus,
} from "./types.js";

const PAGE_COUNT_TTL_MS = 10 * 60 * 1000;

export class HindsightMemory {
  private readonly config: MemoryConfig;
  private readonly client: MemoryClient;
  private readonly outbox: RetainOutbox;
  private readonly lifetime = new AbortController();
  private pageCount?: { value: number; at: number };

  private constructor(
    config: MemoryConfig,
    private readonly report: MemoryReporter,
    getApiKey?: () => string | undefined
  ) {
    const parsed = memoryConfigSchema.safeParse(config);
    if (!parsed.success) throw new MemoryError("invalid_memory_configuration");
    this.config = parsed.data;
    this.client = new MemoryClient(this.config, getApiKey);
    this.outbox = new RetainOutbox(this.config, this.client, report);
  }

  static async create(
    config: MemoryConfig,
    report: MemoryReporter = () => {},
    getApiKey?: () => string | undefined
  ): Promise<HindsightMemory> {
    const memory = new HindsightMemory(config, report, getApiKey);
    await memory.outbox.initialize();
    memory.outbox.start();
    return memory;
  }

  /** Consent is explicit: callers pass `hindsightEnabled: true` only for an admitted turn. */
  private allows(actor: MemoryActor): boolean {
    return (
      actor.userId === this.config.ownerUserId &&
      actor.temporary !== true &&
      actor.hindsightEnabled === true
    );
  }

  async retrieve(actor: MemoryActor, query: string, signal?: AbortSignal): Promise<MemoryContext> {
    if (!this.allows(actor) || !query.trim() || signal?.aborted || this.lifetime.signal.aborted) {
      return { text: "", status: "skipped" };
    }
    const mode = this.config.retrieval ?? "recall";
    const deadline = AbortSignal.timeout(this.config.retrievalTimeoutMs ?? 7000);
    const requestSignal = AbortSignal.any([
      this.lifetime.signal,
      deadline,
      ...(signal ? [signal] : []),
    ]);
    const sources = mode === "recall" ? (["recall"] as const) : ([mode, "recall"] as const);
    let unavailable = false;
    let found: { source: (typeof sources)[number]; text: string } | undefined;
    for (const source of sources) {
      try {
        // Reserve part of the total budget for a raw recall if synthesis/pages stall.
        const sourceSignal =
          source !== "recall"
            ? AbortSignal.any([
                requestSignal,
                AbortSignal.timeout(
                  Math.max(1, Math.floor((this.config.retrievalTimeoutMs ?? 7000) * 0.65))
                ),
              ])
            : requestSignal;
        const text = await this.client[source](query, sourceSignal);
        if (!text.trim()) continue;
        found = { source, text };
        break;
      } catch (error) {
        unavailable = true;
        this.report({
          code: "retrieval_unavailable",
          status: error instanceof MemoryError ? error.status : undefined,
        });
        if (requestSignal.aborted) break;
      }
    }
    let text = "";
    if (found) {
      const bounded = found.text.slice(0, this.config.maxContextChars ?? 12000);
      // Escape the record delimiter so stored text cannot close its own data block.
      const escaped = bounded.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      text = memoryBlock(escaped);
    }
    // The tool guide is returned separately: the host adds it only for an agent the read tools
    // were actually attached to (see LibreChatMemory.appendAgentContext).
    let guide: string | undefined;
    if (this.config.nativeTools !== false && !requestSignal.aborted) {
      const pages = await this.knowledgePages(requestSignal);
      if (pages !== undefined) guide = knowledgeGuide(pages);
    }
    // The status reports the memory lookup; the tool guide alone does not make memory available.
    const status = found ? "available" : unavailable ? "unavailable" : "empty";
    return { status, source: found?.source, text, ...(guide ? { guide } : {}) };
  }

  /**
   * The page count for the tool guide. The extension re-reads its roster on a turn cadence; here
   * the bank's page list changes only when pages are created, so a 10-minute cache keeps the tree
   * request off almost every turn. A failed read keeps the last known count (or drops the guide).
   */
  private async knowledgePages(signal: AbortSignal): Promise<number | undefined> {
    if (this.pageCount && Date.now() - this.pageCount.at < PAGE_COUNT_TTL_MS) {
      return this.pageCount.value;
    }
    try {
      const tree = await this.client.knowledgeTree(signal);
      // Pages may sit in folders at any depth.
      const count = (nodes: KnowledgeNode[] = []): number =>
        nodes.reduce((sum, node) => sum + (node.kind === "page" ? 1 : 0) + count(node.children), 0);
      const value = count(tree.roots);
      this.pageCount = { value, at: Date.now() };
      return value;
    } catch {
      return this.pageCount?.value;
    }
  }

  /** Queue one planned write to a conversation's document (see `planTranscript`). */
  async capture(write: TranscriptWrite): Promise<CaptureResult> {
    if (!this.allows(write)) return { status: "skipped", operationIds: [] };
    if (
      !write.conversationId ||
      write.exchanges.some((exchange) => !exchange.user || !exchange.response)
    ) {
      throw new MemoryError("invalid_completed_exchange");
    }
    const jobs = transcriptJobs(this.config, write);
    if (jobs.length === 0) return { status: "skipped", operationIds: [] };
    let status: CaptureResult["status"] = "completed";
    for (const job of jobs) {
      if ((await this.outbox.enqueue(job)) === "queued") status = "queued";
    }
    this.outbox.start();
    return { status, operationIds: jobs.map((job) => job.operationId) };
  }

  /** Whether the bank already holds this document (no record must never shrink it). */
  async documentExists(documentId: string, signal?: AbortSignal): Promise<boolean> {
    const requestSignal = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(this.config.requestTimeoutMs ?? 30000),
      ...(signal ? [signal] : []),
    ]);
    return (await this.client.document(documentId, requestSignal)) !== null;
  }

  operationStates(operationIds: string[]): Promise<Map<string, OperationState>> {
    return this.outbox.states(operationIds);
  }

  tools(actor: MemoryActor, inspect: MemoryInspector, signal?: AbortSignal): MemoryTool[] {
    if (!this.allows(actor) || this.config.nativeTools === false || this.lifetime.signal.aborted)
      return [];
    const requestSignal = signal
      ? AbortSignal.any([signal, this.lifetime.signal])
      : this.lifetime.signal;
    return readTools(this.client, this.config, inspect, requestSignal, () => this.outbox.status());
  }

  /** Run one bounded recovery pass; submissions remain pending until the server completes them. */
  drain(): Promise<void> {
    return this.outbox.drain();
  }

  status(): Promise<QueueStatus> {
    return this.outbox.status();
  }

  close(): Promise<void> {
    this.lifetime.abort();
    return this.outbox.close();
  }
}
