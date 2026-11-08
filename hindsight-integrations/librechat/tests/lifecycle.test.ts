import { createServer } from "node:http";
import { DynamicStructuredTool } from "@librechat/agents/langchain/tools";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HINDSIGHT_TOOL,
  HindsightMemory,
  LibreChatMemory,
  MemoryError,
  consentHandlers,
  visibleText,
} from "../src/index.js";
import type { Db } from "mongodb";
import type {
  AdmissionClient,
  BranchExchange,
  ConsentDependencies,
  HostConversation,
  HostGenerationJob,
  LibreChatHindsightConfig,
  MemoryConfig,
  MemoryEvent,
  MemoryTool,
  MemoryToolDefinition,
  NativeMemoryAgent,
  TranscriptWrite,
} from "../src/index.js";

interface RequestRecord {
  path: string;
  authorization?: string;
  body: Record<string, unknown>;
}

interface RetainBody {
  operation_id: string;
  async: boolean;
  items: Array<{
    content: string;
    document_id: string;
    metadata: Record<string, string>;
    tags: string[];
    context: string;
    strategy?: string;
    update_mode?: string;
    timestamp?: string;
  }>;
}

let directory: string;
let baseUrl: string;
let requests: RequestRecord[];
let operations: Map<string, RetainBody>;
let operationStatus: "processing" | "completed" | "failed";
let recallStatus: number;
let reflectStatus: number;
let delayReflect: boolean;
let loseAcknowledgment: boolean;
let missingOperation: boolean;
let bankProtected: boolean;
let requiredToken: string | undefined;
let server: ReturnType<typeof createServer>;
let memories: HindsightMemory[];
let bridges: LibreChatMemory[];
let clock: number;
let events: MemoryEvent[];
let mongo: MongoMemoryServer;
let mongoClient: MongoClient;
let database: Db;
let conversations: Map<string, HostConversation>;
let jobs: Map<string, HostGenerationJob>;
let blockingJobs: string[];
let existingDocuments: Set<string>;
let knowledgeTree: { roots: unknown[] };
let documentProbeStatus: number;
let generation = 1762500000000;

/** Host services as LibreChat supplies them: owner-scoped conversation reads and job state. */
function host(overrides: Partial<ConsentDependencies> = {}): ConsentDependencies {
  return {
    database: () => database,
    conversations: {
      get: async (user, id) => (user === "owner" ? (conversations.get(id) ?? null) : null),
    },
    generations: {
      getJob: async (id) => jobs.get(id) ?? null,
      getCleanupBlockingJobIdsForConversations: async () => blockingJobs,
    },
    ...overrides,
  };
}

function runClient(primary: object, connected: object[] = []): AdmissionClient {
  return {
    options: { agent: primary },
    agentConfigs: new Map(connected.map((agent, index) => [String(index), agent])),
  };
}

interface TurnOptions {
  request?: object;
  conversationId?: string;
  newConversation?: boolean;
  acknowledged?: unknown;
  /** Agents the host bound: the primary first. */
  primary?: object;
  primarySource?: { tools?: unknown } | null;
  ephemeralPrimary?: boolean;
  connected?: Array<{ agent: object; tools: unknown[] }>;
  user?: { id: string };
  interactive?: boolean;
  temporary?: boolean;
  generation?: unknown;
}

/** Drive one turn through the host's sequence: bind, begin admission, admit. */
async function admitTurn(
  instance: LibreChatMemory,
  config: LibreChatHindsightConfig,
  options: TurnOptions = {}
) {
  const request = options.request ?? {};
  const primary = options.primary ?? { id: "ephemeral-primary", tools: [] };
  instance.bindAgent(
    request,
    primary,
    options.primarySource ?? null,
    options.ephemeralPrimary ?? true
  );
  for (const { agent, tools } of options.connected ?? []) {
    instance.bindAgent(request, agent, { tools });
  }
  const pending = instance.beginAdmission({
    request,
    config,
    user: options.user ?? { id: "owner" },
    conversationId: options.conversationId ?? "convo",
    newConversation: options.newConversation ?? false,
    generation: options.generation ?? generation++,
    interactive: options.interactive ?? true,
    temporary: options.temporary ?? false,
    acknowledged: "acknowledged" in options ? options.acknowledged : true,
  });
  await instance.admit(
    pending,
    runClient(
      primary,
      (options.connected ?? []).map(({ agent }) => agent)
    )
  );
  return request;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  mongoClient = await MongoClient.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoClient?.close();
  await mongo?.stop();
});

/** Authorized adapter calls carry explicit consent; omission is Off. */
const owner = { userId: "owner", hindsightEnabled: true };

const firstExchange: BranchExchange = {
  user: "user-message-one",
  response: "reply-one",
  turns: [
    {
      role: "user",
      content: "Our recovery marker is MAPLE-73921. Preserve Turkish: dağıtım.",
      timestamp: "2026-11-08T09:00:00.000Z",
    },
    {
      role: "assistant",
      content: "I recorded the recovery marker.",
      timestamp: "2026-11-08T09:00:05.000Z",
    },
  ],
};

/** One planned append of the first exchange to conversation-one's document. */
const write: TranscriptWrite = {
  ...owner,
  conversationId: "conversation-one",
  mode: "append",
  exchanges: [firstExchange],
  startedAt: "2026-11-08T09:00:00.000Z",
  previous: [],
};

function exchangeNumber(index: number): BranchExchange {
  return {
    user: `user-${index}`,
    response: `reply-${index}`,
    turns: [
      {
        role: "user",
        content: `Question ${index}`,
        timestamp: `2026-11-08T10:00:${String(index).padStart(2, "0")}.000Z`,
      },
      {
        role: "assistant",
        content: `Answer ${index}`,
        timestamp: `2026-11-08T10:00:${String(index).padStart(2, "0")}.500Z`,
      },
    ],
  };
}

function configuration(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    baseUrl,
    apiKey: "synthetic-adapter-test-token",
    bankId: "librechat-private",
    ownerUserId: "owner",
    outboxDir: directory,
    pollIntervalMs: 60000,
    requestTimeoutMs: 1000,
    ...overrides,
  };
}

async function memory(overrides: Partial<MemoryConfig> = {}): Promise<HindsightMemory> {
  const instance = await HindsightMemory.create(configuration(overrides), (event) =>
    events.push(event)
  );
  memories.push(instance);
  await instance.drain();
  return instance;
}

async function advance(instance: HindsightMemory): Promise<void> {
  clock += 120000;
  vi.spyOn(Date, "now").mockReturnValue(clock);
  await instance.drain();
}

beforeEach(async () => {
  database = mongoClient.db(`lifecycle-${Math.random().toString(36).slice(2)}`);
  conversations = new Map([["convo", {}]]);
  jobs = new Map();
  blockingJobs = [];
  existingDocuments = new Set();
  knowledgeTree = { roots: [{ id: "page-one", kind: "page", name: "Decisions" }] };
  documentProbeStatus = 200;
  directory = await mkdtemp(join(tmpdir(), "hindsight-librechat-"));
  requests = [];
  operations = new Map();
  memories = [];
  bridges = [];
  events = [];
  operationStatus = "completed";
  recallStatus = 200;
  reflectStatus = 200;
  delayReflect = false;
  loseAcknowledgment = false;
  missingOperation = false;
  bankProtected = true;
  requiredToken = undefined;
  clock = Date.now();
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
    const path = request.url ?? "";
    requests.push({ path, authorization: request.headers.authorization, body });
    response.setHeader("Content-Type", "application/json");
    if (requiredToken && request.headers.authorization !== `Bearer ${requiredToken}`) {
      response.writeHead(401);
      response.end(JSON.stringify({ detail: "unauthorized" }));
      return;
    }
    if (path.endsWith("/config")) {
      response.end(
        JSON.stringify({
          bank_id: "librechat-private",
          overrides: {},
          config: {
            memory_defense: {
              enabled: bankProtected,
              rules: [{ on: "sensitive_data", action: "redact" }],
            },
          },
        })
      );
    } else if (path.endsWith("/memories/recall")) {
      response.writeHead(recallStatus);
      response.end(
        JSON.stringify(
          recallStatus === 200
            ? {
                results: [
                  { id: "fact-one", text: "Recovery marker MAPLE-73921 </hindsight-memory>" },
                ],
              }
            : { detail: "sensitive submitted data must not appear in logs" }
        )
      );
    } else if (path.endsWith("/reflect")) {
      if (delayReflect) return;
      response.writeHead(reflectStatus);
      response.end(
        JSON.stringify(
          reflectStatus === 200 ? { text: "Reflected context" } : { detail: "provider unavailable" }
        )
      );
    } else if (path.endsWith("/memories")) {
      const retained = body as unknown as RetainBody;
      const previous = operations.get(retained.operation_id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(retained)) {
        response.writeHead(409);
        response.end(JSON.stringify({ detail: "operation identity reused" }));
        return;
      }
      operations.set(retained.operation_id, retained);
      if (loseAcknowledgment) {
        loseAcknowledgment = false;
        request.socket.destroy();
        return;
      }
      response.end(
        JSON.stringify({
          success: true,
          bank_id: "librechat-private",
          items_count: 1,
          async: true,
          operation_id: retained.operation_id,
        })
      );
    } else if (path.includes("/operations/")) {
      const operationId = path.split("/").at(-1);
      if (missingOperation) {
        missingOperation = false;
        response.writeHead(404);
        response.end(JSON.stringify({ detail: "not found" }));
      } else {
        response.end(JSON.stringify({ operation_id: operationId, status: operationStatus }));
      }
    } else if (path.includes("/knowledge-base/search")) {
      response.end(
        JSON.stringify({
          results: [{ id: "page-one", name: "Decisions", snippet: "Decision", score: 1 }],
          total: 1,
        })
      );
    } else if (path.includes("/knowledge-base/pages/")) {
      response.end(
        JSON.stringify({
          id: "page-one",
          name: "Decisions",
          type: "knowledge-page",
          markdown: "# Decisions\nUse the read replica.",
        })
      );
    } else if (path.endsWith("/knowledge-base/tree")) {
      response.end(JSON.stringify(knowledgeTree));
    } else if (
      path.includes("/documents/conversation%3A") ||
      path.includes("/documents/conversation:")
    ) {
      const documentId = decodeURIComponent(path.split("/documents/")[1] ?? "");
      if (documentProbeStatus !== 200) {
        response.writeHead(documentProbeStatus);
        response.end(JSON.stringify({ detail: "unavailable" }));
      } else if (existingDocuments.has(documentId)) {
        response.end(JSON.stringify({ id: documentId, original_text: "Earlier transcript" }));
      } else {
        response.writeHead(404);
        response.end(JSON.stringify({ detail: "Document not found" }));
      }
    } else if (path.includes("/documents/")) {
      response.end(JSON.stringify({ id: "document-one", original_text: "Original source text" }));
    } else {
      response.writeHead(404);
      response.end(JSON.stringify({ detail: "unexpected endpoint" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("Missing fixture address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await Promise.all([
    ...memories.map((instance) => instance.close()),
    ...bridges.map((bridge) => bridge.close()),
  ]);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe("automatic native lifecycle", () => {
  it("recalls scoped context before generation and treats it as data", async () => {
    const instance = await memory();
    const context = await instance.retrieve(owner, "Which recovery marker?");
    expect(context.status).toBe("available");
    expect(context.text).toContain("MAPLE-73921");
    expect(context.text).toContain("&lt;/hindsight-memory&gt;");
    expect(requests[0].path).toBe("/v1/default/banks/librechat-private/memories/recall");
    expect(requests[0].authorization).toBe("Bearer synthetic-adapter-test-token");
  });

  it("fails open on retrieval errors without logging upstream content", async () => {
    recallStatus = 503;
    const instance = await memory();
    expect((await instance.retrieve(owner, "private query")).status).toBe("unavailable");
    expect(JSON.stringify(events)).not.toContain("sensitive submitted");
    expect(JSON.stringify(events)).not.toContain("private query");
  });

  it("falls back from failed reflection to raw recall", async () => {
    reflectStatus = 503;
    const instance = await memory({ retrieval: "reflect" });
    expect((await instance.retrieve(owner, "marker")).source).toBe("recall");
    expect(requests.map((request) => request.path)).toEqual([
      "/v1/default/banks/librechat-private/reflect",
      "/v1/default/banks/librechat-private/memories/recall",
      "/v1/default/banks/librechat-private/knowledge-base/tree",
    ]);
  });

  it("frames retrieved memory the extension's way and adds the knowledge-page tool guide", async () => {
    const instance = await memory();
    const context = await instance.retrieve(owner, "marker");
    expect(context.text).toContain("First judge relevance");
    expect(context.text).toContain("> 🧠 **From Hindsight memory**");
    expect(context.text).not.toContain("<hindsight-knowledge>");
    expect(context.guide).toContain("1 knowledge page covers this user's memory");
    expect(context.guide).toContain("hindsight_search_knowledge_pages(query)");
    // The page count is cached: a second turn does not re-read the tree.
    await instance.retrieve(owner, "marker again");
    expect(
      requests.filter((request) => request.path.endsWith("/knowledge-base/tree"))
    ).toHaveLength(1);
  });

  it("keeps the tool guide out when native tools are off, and still offers it when recall fails", async () => {
    const withoutTools = await memory({ nativeTools: false });
    expect((await withoutTools.retrieve(owner, "marker")).guide).toBeUndefined();
    recallStatus = 503;
    const failing = await memory();
    const context = await failing.retrieve(owner, "marker");
    expect(context.status).toBe("unavailable");
    expect(context.text).toBe("");
    expect(context.guide).toContain("<hindsight-knowledge>");
  });

  it("counts knowledge pages inside folders", async () => {
    knowledgeTree = {
      roots: [
        {
          id: "folder-one",
          kind: "folder",
          name: "People",
          children: [
            { id: "page-a", kind: "page", name: "User Profile" },
            {
              id: "folder-two",
              kind: "folder",
              name: "Work",
              children: [{ id: "page-b", kind: "page", name: "Current Projects" }],
            },
          ],
        },
      ],
    };
    const instance = await memory();
    expect((await instance.retrieve(owner, "marker")).guide).toContain(
      "2 knowledge pages cover this user's memory"
    );
  });

  it("reserves time for recall after a reflection deadline", async () => {
    delayReflect = true;
    const instance = await memory({ retrieval: "reflect", retrievalTimeoutMs: 300 });
    expect((await instance.retrieve(owner, "marker")).source).toBe("recall");
  });

  it("loads full knowledge pages, including the deployed markdown response shape", async () => {
    const instance = await memory({ retrieval: "pages" });
    const context = await instance.retrieve(owner, "database policy");
    expect(context.source).toBe("pages");
    expect(context.text).toContain("Use the read replica.");
  });

  it.each([
    { userId: "another-user", hindsightEnabled: true },
    { userId: "owner", temporary: true, hindsightEnabled: true },
    { userId: "owner", hindsightEnabled: false },
    { userId: "owner" },
  ])("does not read, retain or bind tools for excluded actors: %j", async (actor) => {
    const instance = await memory();
    expect((await instance.retrieve(actor, "private")).status).toBe("skipped");
    expect(
      (await instance.capture({ ...write, hindsightEnabled: undefined, ...actor })).status
    ).toBe("skipped");
    expect(instance.tools(actor, () => {})).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it("does not queue a write without visible text", async () => {
    const instance = await memory();
    const empty = { ...firstExchange, turns: [] };
    expect((await instance.capture({ ...write, exchanges: [empty] })).status).toBe("skipped");
    expect((await instance.capture({ ...write, mode: "replace", exchanges: [empty] })).status).toBe(
      "skipped"
    );
    expect((await instance.status()).pending).toBe(0);
  });

  it("retains complete user-only exchanges without inventing assistant text", async () => {
    const instance = await memory();
    await instance.capture({
      ...write,
      exchanges: [{ ...firstExchange, turns: [firstExchange.turns[0]] }],
    });
    await advance(instance);
    expect([...operations.values()][0].items[0].content).toBe(
      JSON.stringify(firstExchange.turns[0])
    );
  });

  it("writes the extension's conversation shape: one document, JSONL turns, conversation strategy", async () => {
    const instance = await memory();
    await instance.capture({ ...write, mode: "replace" });
    await instance.capture({ ...write, exchanges: [exchangeNumber(2)] });
    // One submission per document per pass: the append follows the replace on the next pass.
    await advance(instance);
    await advance(instance);
    const [replace, append] = [...operations.values()].map((operation) => operation.items[0]);
    for (const item of [replace, append]) {
      expect(item.document_id).toBe("conversation:conversation-one");
      expect(item.strategy).toBe("conversation");
      expect(item.tags).toEqual(["source:chat", "harness:librechat"]);
      expect(item.metadata.harness).toBe("librechat");
      expect(item.timestamp).toBe(write.startedAt);
      expect(item.context).toContain("assistant turns are the assistant's");
    }
    expect(replace.update_mode).toBeUndefined();
    expect(replace.content.split("\n").map((line) => JSON.parse(line))).toEqual(
      firstExchange.turns
    );
    expect(append.update_mode).toBe("append");
    expect(append.content.split("\n").map((line) => JSON.parse(line))).toEqual(
      exchangeNumber(2).turns
    );
  });

  it("splits an append into one job per exchange so a re-planned append keeps its identity", async () => {
    const instance = await memory();
    const both = await instance.capture({
      ...write,
      exchanges: [exchangeNumber(1), exchangeNumber(2)],
    });
    const second = await instance.capture({ ...write, exchanges: [exchangeNumber(2)] });
    expect(both.operationIds).toHaveLength(2);
    expect(second.operationIds).toEqual([both.operationIds[1]]);
    expect((await instance.status()).pending).toBe(2);
  });

  it("gives a replace a new identity when the document held something else before (A → B → A)", async () => {
    const instance = await memory();
    const a = await instance.capture({ ...write, mode: "replace" });
    const back = await instance.capture({
      ...write,
      mode: "replace",
      previous: [{ user: "user-b", response: "reply-b" }],
    });
    expect(back.operationIds[0]).not.toBe(a.operationIds[0]);
  });

  it("submits one document's jobs in the order they were written, behind a stuck earlier job", async () => {
    operationStatus = "processing";
    const instance = await memory();
    loseAcknowledgment = true;
    await instance.capture({ ...write, exchanges: [exchangeNumber(1)] });
    await instance.capture({ ...write, exchanges: [exchangeNumber(2)] });
    await instance.capture({ ...write, conversationId: "conversation-two" });
    await advance(instance);
    const submitted = () =>
      requests
        .filter((request) => request.path.endsWith("/memories"))
        .map((request) => (request.body as unknown as RetainBody).items[0]);
    // The first append lost its acknowledgement: the second waits, another document does not.
    expect(submitted().map((item) => item.content)).toEqual([
      expect.stringContaining("Question 1"),
      expect.stringContaining("MAPLE-73921"),
    ]);
    // The retry of the first append goes out; the second waits for the pass after it.
    await advance(instance);
    await advance(instance);
    const order = submitted()
      .filter((item) => item.document_id === "conversation:conversation-one")
      .map((item) => item.content.match(/Question \d/)?.[0]);
    expect(order).toEqual(["Question 1", "Question 1", "Question 2"]);
  });

  it("drops a document's unsubmitted appends when a replace supersedes them", async () => {
    const instance = await memory();
    bankProtected = false;
    await instance.capture({ ...write, exchanges: [exchangeNumber(1)] });
    await instance.capture({ ...write, conversationId: "conversation-two" });
    await instance.capture({
      ...write,
      mode: "replace",
      exchanges: [exchangeNumber(1), exchangeNumber(2)],
    });
    expect((await instance.status()).pending).toBe(2);
    bankProtected = true;
    await advance(instance);
    const items = [...operations.values()].map((operation) => operation.items[0]);
    expect(items.filter((item) => item.update_mode === "append")).toHaveLength(1);
    expect(items.find((item) => item.update_mode === undefined)?.content).toContain("Question 2");
  });

  it("reports where each operation stands so the planner can see a blocked append", async () => {
    operationStatus = "failed";
    const instance = await memory();
    const queued = await instance.capture(write);
    await advance(instance);
    const states = await instance.operationStates([...queued.operationIds, "never-queued"]);
    expect(states.get(queued.operationIds[0])).toBe("blocked");
    expect(states.get("never-queued")).toBe("missing");
  });

  it("does not send raw content to an unprotected bank and automatically resumes after protection is enabled", async () => {
    const instance = await memory();
    bankProtected = false;
    await instance.capture(write);
    await advance(instance);
    expect(operations.size).toBe(0);
    expect((await instance.status()).pending).toBe(1);
    expect(events.some((event) => event.reason === "bank_protection_required")).toBe(true);
    bankProtected = true;
    await advance(instance);
    expect(operations.size).toBe(1);
    expect((await instance.status()).pending).toBe(0);
  });

  it("recovers rejected credentials from the current backend source without losing queued data", async () => {
    let token = "synthetic-stale-token";
    requiredToken = "synthetic-rotated-token";
    const instance = await HindsightMemory.create(
      configuration(),
      (event) => events.push(event),
      () => token
    );
    memories.push(instance);
    await instance.capture(write);
    await advance(instance);
    expect((await instance.status()).pending).toBe(1);
    expect((await instance.status()).blocked).toBe(0);
    expect(operations.size).toBe(0);
    token = requiredToken;
    await advance(instance);
    expect(operations.size).toBe(1);
    expect((await instance.status()).pending).toBe(0);
  });

  it("does not starve pending jobs beyond the per-pass batch", async () => {
    operationStatus = "processing";
    const instance = await memory();
    for (let index = 0; index < 40; index++) {
      await instance.capture({ ...write, conversationId: `conversation-${index}` });
    }
    await advance(instance);
    expect(operations.size).toBe(32);
    await advance(instance);
    expect(operations.size).toBe(40);
  });

  it("does not count async submission as completion", async () => {
    operationStatus = "processing";
    const instance = await memory();
    await instance.capture(write);
    await advance(instance);
    expect(await instance.status()).toEqual({ pending: 1, blocked: 0 });
    expect(await readdir(join(directory, "completed"))).toHaveLength(0);
    operationStatus = "completed";
    await advance(instance);
    expect(await instance.status()).toEqual({ pending: 0, blocked: 0 });
    expect(events.some((event) => event.code === "capture_completed")).toBe(true);
  });

  it("deduplicates replayed delivery before and after completion", async () => {
    const instance = await memory();
    const first = await instance.capture(write);
    const repeated = await instance.capture(write);
    expect(first.operationIds).toEqual(repeated.operationIds);
    await advance(instance);
    expect((await instance.capture(write)).status).toBe("completed");
    expect(operations.size).toBe(1);
  });

  it("retries a lost acknowledgment using exactly the original operation and payload", async () => {
    const instance = await memory();
    loseAcknowledgment = true;
    await instance.capture(write);
    await advance(instance);
    expect((await instance.status()).pending).toBe(1);
    await advance(instance);
    const writes = requests.filter((request) => request.path.endsWith("/memories"));
    expect(writes).toHaveLength(2);
    expect(writes[0].body).toEqual(writes[1].body);
    expect(operations.size).toBe(1);
    expect((await instance.status()).pending).toBe(0);
  });

  it("recovers a pending operation across process-instance restarts", async () => {
    operationStatus = "processing";
    const first = await memory();
    const queued = await first.capture(write);
    await advance(first);
    await first.close();
    operationStatus = "completed";
    const second = await memory();
    await advance(second);
    expect((await second.capture(write)).operationIds).toEqual(queued.operationIds);
    expect((await second.status()).pending).toBe(0);
    expect(operations.size).toBe(1);
  });

  it("resubmits an expected missing operation, rather than permanently blocking it", async () => {
    const instance = await memory();
    missingOperation = true;
    await instance.capture(write);
    await advance(instance);
    await advance(instance);
    expect(await instance.status()).toEqual({ pending: 0, blocked: 0 });
    expect(operations.size).toBe(1);
  });

  it("keeps terminal failures visible and does not claim or retry them as successful", async () => {
    operationStatus = "failed";
    const instance = await memory();
    await instance.capture(write);
    await advance(instance);
    expect(await instance.status()).toEqual({ pending: 0, blocked: 1 });
    expect(events.some((event) => event.code === "capture_completed")).toBe(false);
  });

  it("keeps outbox data private and never persists the backend credential", async () => {
    const instance = await memory();
    const queued = await instance.capture(write);
    const path = join(directory, "pending", `${queued.operationIds[0]}.json`);
    const content = await readFile(path, "utf8");
    expect(content).toContain("MAPLE-73921");
    expect(content).not.toContain("synthetic-adapter-test-token");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "pending"))).mode & 0o777).toBe(0o700);
  });

  it("refuses to reroute persisted work to another bank or owner", async () => {
    const instance = await memory();
    await instance.capture(write);
    await instance.close();
    await expect(memory({ bankId: "another-bank" })).rejects.toThrow("outbox_identity_changed");
  });

  it("rejects credentials embedded in URLs and remote plaintext transport", async () => {
    await expect(memory({ baseUrl: "https://user:password@example.invalid" })).rejects.toThrow(
      "unsafe_hindsight_url"
    );
    await expect(memory({ baseUrl: "http://remote.example.invalid" })).rejects.toThrow(
      "unsafe_hindsight_url"
    );
  });
});

function bridgeConfig(overrides: Partial<MemoryConfig> = {}): LibreChatHindsightConfig {
  const { apiKey: _apiKey, ...options } = configuration(overrides);
  return { ...options, enabled: true };
}

/** `null` builds a bridge whose host supplied no consent services. */
function newBridge(dependencies: ConsentDependencies | null = host()): LibreChatMemory {
  const instance = new LibreChatMemory(
    () => "synthetic-adapter-test-token",
    (event) => events.push(event),
    dependencies ?? undefined
  );
  bridges.push(instance);
  return instance;
}

/** Store the conversation's consent through the owner's toggle API. */
async function enableConsent(instance: LibreChatMemory, conversationId = "convo") {
  conversations.set(conversationId, conversations.get(conversationId) ?? {});
  expect(
    await instance.updateConsent(bridgeConfig(), { id: "owner" }, conversationId, true)
  ).toEqual({ ok: true, enabled: true });
}

describe("LibreChat native request bridge", () => {
  /** An On turn: stored consent, the page's confirmation and a capable primary agent. */
  async function bridge(primary: object = { id: "primary", tools: [] }, connected: object[] = []) {
    const instance = newBridge();
    const config = bridgeConfig();
    await enableConsent(instance);
    const request = await admitTurn(instance, config, {
      primary,
      connected: connected.map((agent) => ({ agent, tools: [HINDSIGHT_TOOL] })),
    });
    const input = { request, user: { id: "owner" }, query: "marker", temporary: false, config };
    return { instance, request, input };
  }

  /** Admit another On request for the same conversation, as the next turn would. */
  function nextTurn(instance: LibreChatMemory, config: LibreChatHindsightConfig, agent: object) {
    return admitTurn(instance, config, { primary: agent });
  }

  it("uses its own configuration and remains inactive unless explicitly enabled", async () => {
    const { instance, input } = await bridge();
    expect((await instance.prepare(input))?.provider).toBe("hindsight");
    expect(await instance.prepare({ ...input, config: undefined })).toBeUndefined();
    expect(
      await instance.prepare({ ...input, config: { ...input.config, enabled: false } })
    ).toBeUndefined();
  });

  it("continues recalling and retaining when the user disables built-in memory in settings", async () => {
    const { instance, request, input } = await bridge();
    const user = Object.freeze({
      id: "owner",
      personalization: Object.freeze({ memories: false }),
    });
    const context = await instance.prepare({ ...input, user });
    expect(context?.status).toBe("available");
    expect(user.personalization.memories).toBe(false);
    await instance.complete(
      request,
      { messageId: "user-one", conversationId: "convo", isCreatedByUser: true, text: "User fact" },
      {
        messageId: "reply-one",
        parentMessageId: "user-one",
        conversationId: "convo",
        isCreatedByUser: false,
        text: "Final reply",
      },
      { unfinished: false, compaction: false }
    );
    expect(await readdir(join(directory, "pending"))).toHaveLength(1);
  });

  it("captures only final visible text after the host finalizes a complete exchange", async () => {
    const { instance, request, input } = await bridge();
    await instance.prepare(input);
    expect(operations.size).toBe(0);
    const user = {
      messageId: "user-one",
      conversationId: "convo",
      isCreatedByUser: true,
      text: "raw user text",
      content: [{ type: "image_url", image_url: "data:image/png;base64,not-captured" }],
    };
    const response = {
      messageId: "reply-one",
      parentMessageId: "user-one",
      conversationId: "convo",
      isCreatedByUser: false,
      text: "",
      content: [
        { type: "text", text: "Final visible answer" },
        { type: "think", think: "hidden reasoning" },
        { type: "tool_call", output: "tool-result-not-captured" },
      ],
    };
    await instance.complete(request, user, response, { unfinished: false, compaction: false });
    const files = await readdir(join(directory, "pending"));
    expect(files).toHaveLength(1);
    const payload = await readFile(join(directory, "pending", files[0]), "utf8");
    expect(payload).toContain("raw user text");
    expect(payload).toContain("Final visible answer");
    expect(payload).not.toContain("hidden reasoning");
    expect(payload).not.toContain("tool-result-not-captured");
    expect(payload).not.toContain("data:image");
    expect(payload).not.toContain("hindsight-memory");
    expect(payload).not.toContain("hindsight-knowledge");
    expect(user.text).toBe("raw user text");
  });

  it("does not capture without an owner-scoped prepared request", async () => {
    const { instance } = await bridge();
    await instance.complete({}, {}, {}, { unfinished: false, compaction: false });
    expect(operations.size).toBe(0);
  });

  it.each([
    { unfinished: true, compaction: false },
    { unfinished: false, compaction: true },
  ])("skips unfinished and internal compaction turns: %j", async (options) => {
    const { instance, request, input } = await bridge();
    await instance.prepare(input);
    await instance.complete(request, {}, {}, options);
    expect(await readdir(join(directory, "pending"))).toHaveLength(0);
  });

  it("adds independently inspected context and preserves existing snapshots unchanged", async () => {
    const primary = { id: "primary", tools: [] };
    const { instance, request, input } = await bridge(primary);
    const context = await instance.prepare(input);
    const parts = ["existing context"];
    const inspection = new Set<string>();
    const agentInspection: string[] = [];
    instance.appendAgentContext(request, primary, context, parts, inspection, agentInspection);
    expect(parts).toEqual(["existing context", context?.text]);
    expect(inspection.has(context!.text)).toBe(true);
    expect(agentInspection).toEqual([context?.text]);
    const existing = [{ scope: "shared", withoutKeys: "unchanged built-in context" }];
    const snapshots = instance.snapshots(context, existing);
    expect(snapshots[0]).toBe(existing[0]);
    expect(snapshots[1]).toEqual({ scope: "hindsight", withoutKeys: context?.text });
    expect(existing).toHaveLength(1);
  });

  it("resolves request-and-agent-bound tools through the upstream execution loader", async () => {
    const agent: NativeMemoryAgent<DynamicStructuredTool> = { id: "primary", tools: [] };
    const { instance, request, input } = await bridge(agent);
    await instance.prepare(input);
    instance.attachTools(
      request,
      [agent],
      (tool) => new DynamicStructuredTool(tool),
      () => {},
      true
    );
    const ordinary = new DynamicStructuredTool({
      name: "ordinary",
      description: "Existing host tool",
      schema: agent.tools[0].schema,
      func: async () => "ordinary result",
    });
    const configurable = { untouched: true };
    const upstream = vi.fn(async (names: string[], _agentId?: string, ..._rest: unknown[]) => ({
      loadedTools: names.includes("ordinary") ? [ordinary] : [],
      configurable,
    }));
    const options = { loadTools: upstream };
    instance.wrapToolExecution(request, options);
    const signal = new AbortController().signal;
    const result = await options.loadTools(
      ["hindsight_recall", "ordinary"],
      "primary",
      {},
      {},
      signal,
      undefined
    );
    expect(upstream).toHaveBeenCalledWith(
      ["hindsight_recall", "ordinary"],
      "primary",
      {},
      {},
      signal,
      undefined
    );
    expect(result.configurable).toBe(configurable);
    expect(result.loadedTools.map((tool) => tool.name)).toEqual(["ordinary", "hindsight_recall"]);
    expect(await result.loadedTools[1].invoke({ query: "marker" })).toContain("MAPLE-73921");
    expect((await options.loadTools(["hindsight_recall"], "unbound")).loadedTools).toEqual([]);
    const foreign = { loadTools: upstream };
    instance.wrapToolExecution({}, foreign);
    expect((await foreign.loadTools(["hindsight_recall"], "primary")).loadedTools).toEqual([]);
    const oldTool = result.loadedTools[1];
    const nextRequest = await nextTurn(instance, input.config, agent);
    await instance.prepare({ ...input, request: nextRequest });
    instance.attachTools(
      nextRequest,
      [agent],
      (tool) => new DynamicStructuredTool(tool),
      () => {},
      true
    );
    expect((await options.loadTools(["hindsight_recall"], "primary")).loadedTools).toEqual([]);
    await expect(oldTool.invoke({ query: "marker" })).rejects.toThrow("memory_session_expired");
  });

  it("preserves upstream results and failures without a bound requested tool", async () => {
    const { instance, request } = await bridge();
    const result = { loadedTools: [], configurable: { untouched: true } };
    const failure = new Error("upstream_loader_failed");
    const options = {
      loadTools: vi.fn(async (names: string[]) => {
        if (names.includes("failure")) throw failure;
        return result;
      }),
    };
    instance.wrapToolExecution(request, options);
    expect(await options.loadTools(["ordinary"])).toBe(result);
    await expect(options.loadTools(["failure"])).rejects.toBe(failure);
  });

  it("fails closed on executable and schema name collisions", async () => {
    const agent: NativeMemoryAgent<DynamicStructuredTool> = { id: "primary", tools: [] };
    const collisions: NativeMemoryAgent<DynamicStructuredTool>[] = [
      { id: "collision-definitions", tools: [] },
      { id: "collision-registry", tools: [] },
    ];
    const { instance, request, input } = await bridge(agent, collisions);
    await instance.prepare(input);
    const factory = (tool: MemoryTool) => new DynamicStructuredTool(tool);
    instance.attachTools(request, [agent], factory, () => {}, true);
    const options = {
      loadTools: async (_names: string[], _agentId?: string) => ({ loadedTools: [agent.tools[0]] }),
    };
    instance.wrapToolExecution(request, options);
    await expect(options.loadTools(["hindsight_recall"], "primary")).rejects.toThrow(
      "hindsight_tool_name_conflict"
    );
    for (const [index, registry] of [false, true].entries()) {
      const definition = agent.toolDefinitions![0];
      const collision = Object.assign(
        collisions[index],
        registry
          ? { toolRegistry: new Map([[definition.name, definition]]) }
          : { toolDefinitions: [definition] }
      );
      expect(() => instance.attachTools(request, [collision], factory, () => {}, true)).toThrow(
        "hindsight_tool_name_conflict"
      );
    }
  });

  it("propagates the SDK per-call abort signal into the Hindsight request", async () => {
    const agent: NativeMemoryAgent<DynamicStructuredTool> = { id: "primary", tools: [] };
    const { instance, request, input } = await bridge(agent);
    await instance.prepare(input);
    instance.attachTools(
      request,
      [agent],
      (tool) => new DynamicStructuredTool(tool),
      () => {},
      true
    );
    delayReflect = true;
    const controller = new AbortController();
    const tool = agent.tools.find((entry) => entry.name === "hindsight_reflect")!;
    const pending = tool.invoke({ query: "why" }, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await rejected;
  });

  it.each(["owner", "temporary", "compaction", "capability", "nativeTools"])(
    "does not resolve private tools when the %s gate excludes them",
    async (gate) => {
      const agent: NativeMemoryAgent<DynamicStructuredTool> = { id: "primary", tools: [] };
      const { instance, request, input } = await bridge(agent);
      await instance.prepare({
        ...input,
        user: gate === "owner" ? { id: "not-owner" } : input.user,
        temporary: gate === "temporary",
        compaction: gate === "compaction",
        config: { ...input.config, nativeTools: gate !== "nativeTools" },
      });
      instance.attachTools(
        request,
        [agent],
        (tool) => new DynamicStructuredTool(tool),
        () => {},
        gate !== "capability"
      );
      const options = {
        loadTools: async (_names: string[], _agentId?: string) => ({
          loadedTools: [] as DynamicStructuredTool[],
        }),
      };
      instance.wrapToolExecution(request, options);
      expect((await options.loadTools(["hindsight_recall"], "primary")).loadedTools).toEqual([]);
    }
  );

  it("binds eight native read tools for direct invocation through the real tool implementation", async () => {
    const inspect = vi.fn();
    const registry = new Map<string, MemoryToolDefinition>();
    const agent: NativeMemoryAgent<DynamicStructuredTool> = {
      id: "primary",
      tools: [],
      toolMap: new Map(),
      toolDefinitions: [],
      toolRegistry: registry,
    };
    const { instance, request, input } = await bridge(agent);
    await instance.prepare(input);
    const factory = (definition: MemoryTool) => new DynamicStructuredTool(definition);
    instance.attachTools(request, [agent], factory, inspect, true);
    instance.attachTools(request, [agent], factory, inspect, true);
    expect(agent.tools).toHaveLength(8);
    expect(agent.toolMap?.size).toBe(8);
    expect(agent.toolDefinitions).toHaveLength(8);
    expect(registry.size).toBe(8);
    const calls = [
      ["hindsight_recall", { query: "marker" }, "MAPLE-73921"],
      ["hindsight_reflect", { query: "why" }, "Reflected context"],
      ["hindsight_list_knowledge_pages", {}, "Decisions"],
      ["hindsight_search_knowledge_pages", { query: "database" }, "Decisions"],
      ["hindsight_read_knowledge_page", { pageId: "page-one" }, "read replica"],
      ["hindsight_get_document", { documentId: "document-one" }, "Original source"],
      ["hindsight_delivery_status", {}, "pending"],
      ["hindsight_diagnose", {}, "apiKeyConfigured"],
    ] as const;
    for (const [name, args, expected] of calls) {
      const tool = agent.toolMap!.get(name)!;
      const output = await tool.invoke(args);
      expect(output).toContain(expected);
      expect(output).not.toContain("synthetic-adapter-test-token");
    }
    expect(inspect).toHaveBeenCalledTimes(16);
    expect(
      requests.every((record) => record.path.startsWith("/v1/default/banks/librechat-private/"))
    ).toBe(true);
    expect(JSON.stringify(agent.toolDefinitions)).not.toContain("synthetic-adapter-test-token");
  });

  it("rejects bank overrides and applies the host inspection policy before native tool I/O", async () => {
    const agent: NativeMemoryAgent<DynamicStructuredTool> = { id: "primary", tools: [] };
    const { instance, request, input } = await bridge(agent);
    await instance.prepare(input);
    const inspect = (text: string) => {
      if (text.includes("forbidden")) throw new Error("policy_blocked");
    };
    instance.attachTools(
      request,
      [agent],
      (definition) => new DynamicStructuredTool(definition),
      inspect,
      true
    );
    const tool = agent.tools.find((entry) => entry.name === "hindsight_recall")!;
    const before = requests.length;
    await expect(tool.invoke({ query: "forbidden" })).rejects.toThrow("policy_blocked");
    await expect(tool.invoke({ query: "allowed", bankId: "another-bank" })).rejects.toThrow();
    expect(requests).toHaveLength(before);
  });

  it("removes private tool bindings when an agent is reused for another request", async () => {
    const agent: NativeMemoryAgent<DynamicStructuredTool> = {
      id: "primary",
      tools: [],
      toolMap: new Map(),
      toolRegistry: new Map(),
    };
    const { instance, request, input } = await bridge(agent);
    await instance.prepare(input);
    const factory = (definition: MemoryTool) => new DynamicStructuredTool(definition);
    instance.attachTools(request, [agent], factory, () => {}, true);
    const oldTool = agent.tools[0];
    await instance.prepare({ ...input, user: { id: "not-owner" } });
    await expect(oldTool.invoke({ query: "private" })).rejects.toThrow("memory_session_expired");
    instance.attachTools(request, [agent], factory, () => {}, true);
    expect(agent.tools).toHaveLength(0);
    expect(agent.toolMap?.size).toBe(0);
    expect(agent.toolDefinitions).toHaveLength(0);
    const nextRequest = await nextTurn(instance, input.config, agent);
    await instance.prepare({ ...input, request: nextRequest });
    instance.attachTools(nextRequest, [agent], factory, () => {}, true);
    expect(agent.tools).toHaveLength(8);
    expect(agent.tools[0]).not.toBe(oldTool);
    expect(instance.requiresFreshRun(input.config, input.user)).toBe(true);
    expect(instance.requiresFreshRun(input.config, { id: "not-owner" })).toBe(false);
  });

  it("does not let a document ID escape its configured bank at the HTTP boundary", async () => {
    const instance = await memory();
    const tool = instance
      .tools(owner, () => {})
      .find((entry) => entry.name === "hindsight_get_document")!;
    await expect(tool.func({ documentId: "../../another-bank/config" })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("keeps optional native tools off when the host's tools capability is disabled", async () => {
    const agent: NativeMemoryAgent<DynamicStructuredTool> = { id: "primary", tools: [] };
    const { instance, request, input } = await bridge(agent);
    const context = await instance.prepare(input);
    instance.attachTools(
      request,
      [agent],
      (definition) => new DynamicStructuredTool(definition),
      () => {},
      false
    );
    expect(agent.tools).toHaveLength(0);
    expect(context?.status).toBe("available");
  });

  it("recovers the active branch's user query for regenerate and continue", async () => {
    const { instance } = await bridge();
    const messages = [
      { messageId: "user-a", text: "Branch A", isCreatedByUser: true },
      { messageId: "user-b", text: "Branch B", isCreatedByUser: true },
      { messageId: "reply-a", parentMessageId: "user-a", isCreatedByUser: false },
    ];
    expect(instance.query(undefined, messages, "reply-a")).toBe("Branch A");
    expect(instance.query("New query", messages, "reply-a")).toBe("New query");
    expect(instance.query(undefined, messages, "missing")).toBe("");
  });

  it("does not turn a committed answer into a chat error when capture validation fails", async () => {
    const { instance, request, input } = await bridge();
    await instance.prepare(input);
    await expect(
      instance.complete(request, {}, {}, { unfinished: false, compaction: false })
    ).resolves.toBeUndefined();
    expect(events.some((event) => event.code === "invalid_exchange_roles")).toBe(true);
  });

  it("captures a resumed completion without an earlier retrieval session", async () => {
    const { instance, input } = await bridge();
    await instance.finalize(
      input,
      {
        messageId: firstExchange.user,
        conversationId: "convo",
        text: firstExchange.turns[0].content,
      },
      {
        messageId: firstExchange.response,
        conversationId: "convo",
        parentMessageId: firstExchange.user,
        isCreatedByUser: false,
        text: firstExchange.turns[1].content,
      },
      { unfinished: false, compaction: false, userMetadata: true }
    );
    // Only the "does this conversation already have a document?" probe: no retrieval.
    expect(requests.map((request) => request.path)).toEqual([
      "/v1/default/banks/librechat-private/documents/conversation%3Aconvo",
    ]);
    expect(
      (await readdir(join(directory, "pending"))).filter((name) => name.endsWith(".json"))
    ).toHaveLength(1);
  });

  it("honors authoritative temporary-chat state rather than a false resume body flag", async () => {
    const { instance } = await bridge();
    expect(
      instance.temporary({
        resolvedConversation: { isTemporary: true },
        body: { isTemporary: false },
      })
    ).toBe(true);
    expect(
      instance.temporary({
        _agentEventBindingRetention: { isTemporary: true },
        body: { isTemporary: false },
      })
    ).toBe(true);
    expect(instance.temporary({ body: { isTemporary: false } })).toBe(false);
  });

  it("does not inject or retain internal compaction turns", async () => {
    const { instance, input } = await bridge();
    expect(await instance.prepare({ ...input, compaction: true })).toBeUndefined();
    await instance.finalize(input, {}, {}, { unfinished: false, compaction: true });
    expect(requests).toHaveLength(0);
    expect(await readdir(directory)).toEqual([]);
  });

  it("cancels read tools and retrieval when the adapter closes", async () => {
    const instance = await memory();
    const tool = instance.tools(owner, () => {})[0];
    await instance.close();
    await expect(tool.func({ query: "marker" })).rejects.toThrow();
    expect((await instance.retrieve(owner, "marker")).status).toBe("skipped");
    expect(requests).toHaveLength(0);
  });

  it("extracts text blocks only, including structured visible text", () => {
    expect(
      visibleText({
        content: [
          { type: "text", text: { value: "visible" } },
          { type: "think", text: "hidden" },
        ],
      })
    ).toBe("visible");
  });
});

describe("per-conversation consent", () => {
  const userMessage = {
    messageId: "user-one",
    conversationId: "convo",
    isCreatedByUser: true,
    text: "User fact",
  };
  const reply = {
    messageId: "reply-one",
    parentMessageId: "user-one",
    conversationId: "convo",
    isCreatedByUser: false,
    text: "Final reply",
  };
  const finished = { unfinished: false, compaction: false };

  function input(request: object, config: LibreChatHindsightConfig) {
    return { request, user: { id: "owner" }, query: "marker", temporary: false, config };
  }

  async function pendingJobs(): Promise<string[]> {
    try {
      return (await readdir(join(directory, "pending"))).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
  }

  function turnRecords() {
    return database
      .collection("hindsightturns")
      .find({}, { projection: { _id: 0 } })
      .toArray();
  }

  /** Run a whole turn the way the host does and report what Hindsight did. */
  async function runTurn(
    instance: LibreChatMemory,
    config: LibreChatHindsightConfig,
    options: TurnOptions = {}
  ) {
    const primary: NativeMemoryAgent<DynamicStructuredTool> = { id: "primary", tools: [] };
    const request = await admitTurn(instance, config, { primary, ...options });
    const context = await instance.prepare(input(request, config));
    const agent = (options.primary as NativeMemoryAgent<DynamicStructuredTool>) ?? primary;
    instance.attachTools(
      request,
      [agent],
      (tool) => new DynamicStructuredTool(tool),
      () => {},
      true
    );
    await instance.finalize(input(request, config), userMessage, reply, finished);
    return { request, context, agent };
  }

  it("keeps a turn Off without stored consent, making no Hindsight request and no capture", async () => {
    const instance = newBridge();
    const { context, agent } = await runTurn(instance, bridgeConfig());
    expect(context).toBeUndefined();
    expect(agent.tools).toHaveLength(0);
    expect(await pendingJobs()).toEqual([]);
    expect(requests).toEqual([]);
    expect(await turnRecords()).toEqual([
      expect.objectContaining({ enabled: false, capableAgentIds: [] }),
    ]);
    expect(await database.collection("hindsightconsents").findOne({})).toMatchObject({
      enabled: false,
    });
  });

  it.each([undefined, false, "true", 1])(
    "requires the page's confirmation: stored On with flag %j is Off",
    async (acknowledged) => {
      const instance = newBridge();
      await enableConsent(instance);
      const { context } = await runTurn(instance, bridgeConfig(), { acknowledged });
      expect(context).toBeUndefined();
      expect(await pendingJobs()).toEqual([]);
      expect(requests).toEqual([]);
    }
  );

  it("uses Hindsight on a saved agent only when its server-loaded tools carry the marker", async () => {
    const instance = newBridge();
    const config = bridgeConfig();
    await enableConsent(instance);
    const plain = await runTurn(instance, config, {
      primary: { id: "saved", tools: [] },
      ephemeralPrimary: false,
      primarySource: { tools: ["web_search"] },
    });
    expect(plain.context).toBeUndefined();
    expect(plain.agent.tools).toHaveLength(0);
    expect(requests).toEqual([]);
    expect(await turnRecords()).toEqual([
      expect.objectContaining({ enabled: false, capableAgentIds: [] }),
    ]);
    const capable = await runTurn(instance, config, {
      primary: { id: "saved", tools: [] },
      ephemeralPrimary: false,
      primarySource: { tools: ["web_search", HINDSIGHT_TOOL] },
    });
    expect(capable.context?.status).toBe("available");
    expect(capable.agent.tools).toHaveLength(8);
    expect(await pendingJobs()).toHaveLength(1);
  });

  it.each([{ user: { id: "not-owner" } }, { temporary: true }, { interactive: false }])(
    "never reads or writes consent for an excluded turn: %j",
    async (options) => {
      const instance = newBridge();
      await enableConsent(instance);
      const { context } = await runTurn(instance, bridgeConfig(), options);
      expect(context).toBeUndefined();
      expect(await turnRecords()).toEqual([]);
      expect(await database.collection("hindsightconsents").findOne({})).toMatchObject({
        fence: 0,
      });
      expect(requests).toEqual([]);
    }
  );

  it("persists a new chat's first-turn On choice before any Hindsight request", async () => {
    const instance = newBridge();
    const config = bridgeConfig();
    conversations.delete("fresh");
    const request = await admitTurn(instance, config, {
      conversationId: "fresh",
      newConversation: true,
    });
    expect(requests).toEqual([]);
    expect(
      await database.collection("hindsightconsents").findOne({ conversationId: "fresh" })
    ).toMatchObject({ enabled: true, version: 1 });
    expect((await instance.prepare(input(request, config)))?.status).toBe("available");
  });

  it("keeps a new chat Off when the page did not choose On, storing no On consent", async () => {
    const instance = newBridge();
    conversations.delete("fresh");
    const { context } = await runTurn(instance, bridgeConfig(), {
      conversationId: "fresh",
      newConversation: true,
      acknowledged: false,
    });
    expect(context).toBeUndefined();
    expect(await database.collection("hindsightconsents").countDocuments({ enabled: true })).toBe(
      0
    );
  });

  it("does not let a reused request id switch an existing chat On through the new-chat path", async () => {
    const instance = newBridge();
    const { context } = await runTurn(instance, bridgeConfig(), {
      conversationId: "convo",
      newConversation: true,
    });
    expect(context).toBeUndefined();
    expect(await database.collection("hindsightconsents").countDocuments({ enabled: true })).toBe(
      0
    );
    expect(events.map((event) => event.code)).toContain("consent_draft_existing_conversation");
  });

  it("scopes context and tools to capable agents and keeps the host tools gate", async () => {
    const instance = newBridge();
    const config = bridgeConfig();
    await enableConsent(instance);
    const primary: NativeMemoryAgent<DynamicStructuredTool> = { id: "primary", tools: [] };
    const marked: NativeMemoryAgent<DynamicStructuredTool> = { id: "marked", tools: [] };
    const plain: NativeMemoryAgent<DynamicStructuredTool> = { id: "plain", tools: [] };
    const request = await admitTurn(instance, config, {
      primary,
      connected: [
        { agent: marked, tools: [HINDSIGHT_TOOL] },
        { agent: plain, tools: ["web_search"] },
      ],
    });
    const context = await instance.prepare(input(request, config));
    const factory = (tool: MemoryTool) => new DynamicStructuredTool(tool);
    instance.attachTools(request, [primary, marked, plain], factory, () => {}, true);
    expect([primary, marked, plain].map((agent) => agent.tools.length)).toEqual([8, 8, 0]);
    const injected = () =>
      [primary, marked, plain].map((agent) => {
        const parts: string[] = [];
        instance.appendAgentContext(request, agent, context, parts, new Set(), []);
        return parts;
      });
    // Memory plus the knowledge-page tool guide for each capable agent with the tools attached.
    expect(injected().map((parts) => parts.length)).toEqual([2, 2, 0]);
    expect(injected()[0][1]).toContain("<hindsight-knowledge>");
    expect(await turnRecords()).toEqual([
      expect.objectContaining({ enabled: true, capableAgentIds: ["primary", "marked"] }),
    ]);

    instance.attachTools(request, [primary, marked, plain], factory, () => {}, false);
    expect([primary, marked, plain].map((agent) => agent.tools.length)).toEqual([0, 0, 0]);
    // With the host's tools gate off the guide would name tools the agent does not have.
    expect(injected().map((parts) => parts.length)).toEqual([1, 1, 0]);
    expect((await instance.prepare(input(request, config)))?.status).toBe("available");
  });

  it("removes stale tools when an On turn's agent object is reused by an Off turn", async () => {
    const instance = newBridge();
    const config = bridgeConfig();
    await enableConsent(instance);
    const agent: NativeMemoryAgent<DynamicStructuredTool> = { id: "primary", tools: [] };
    const { request } = await runTurn(instance, config, { primary: agent });
    expect(agent.tools).toHaveLength(8);
    const oldTool = agent.tools[0];
    const before = requests.length;
    const off = await admitTurn(instance, config, { primary: agent, acknowledged: false });
    await instance.prepare(input(off, config));
    instance.attachTools(
      off,
      [agent],
      (tool) => new DynamicStructuredTool(tool),
      () => {},
      true
    );
    expect(agent.tools).toHaveLength(0);
    expect(agent.toolDefinitions).toHaveLength(0);
    await expect(oldTool.invoke({ query: "private" })).rejects.toThrow("memory_session_expired");
    expect(requests.length).toBe(before);
    expect(request).not.toBe(off);
  });

  it("restores a paused turn only from its record, narrowed to agents still capable", async () => {
    const instance = newBridge();
    const config = bridgeConfig();
    await enableConsent(instance);
    const marked = { id: "marked" };
    const turn = 1762500123456;
    await admitTurn(instance, config, {
      primary: { id: "primary" },
      connected: [{ agent: marked, tools: [HINDSIGHT_TOOL] }],
      generation: turn,
    });

    // After restart: new runtime configs; "marked" lost the tool, "added" gained it.
    const resumed = {};
    const primary = { id: "primary" };
    const lost = { id: "marked" };
    const gained = { id: "gained" };
    instance.bindAgent(resumed, primary, null, true);
    instance.bindAgent(resumed, gained, { tools: [HINDSIGHT_TOOL] });
    instance.bindAgent(resumed, lost, { tools: [] });
    await instance.restore(
      {
        request: resumed,
        config,
        user: { id: "owner" },
        conversationId: "convo",
        generation: String(turn),
        temporary: false,
      },
      runClient(primary, [lost, gained])
    );
    const visible = [primary, lost, gained].map((agent) => {
      const parts: string[] = [];
      instance.appendAgentContext(
        resumed,
        agent,
        { provider: "hindsight", status: "available", text: "context" },
        parts,
        new Set(),
        []
      );
      return parts.length;
    });
    expect(visible).toEqual([1, 0, 0]);

    const missing = {};
    instance.bindAgent(missing, primary, null, true);
    await instance.restore(
      {
        request: missing,
        config,
        user: { id: "owner" },
        conversationId: "convo",
        generation: turn + 1,
        temporary: false,
      },
      runClient(primary)
    );
    expect(await instance.prepare(input(missing, config))).toBeUndefined();
  });

  it("skips capture when consent changed after the turn was admitted", async () => {
    const instance = newBridge();
    const config = bridgeConfig();
    await enableConsent(instance);
    const request = await admitTurn(instance, config);
    await instance.prepare(input(request, config));
    // Toggles are refused during a run; simulate a race that slipped past the guard.
    await database
      .collection("hindsightconsents")
      .updateOne({ conversationId: "convo" }, { $inc: { version: 1 } });
    await instance.finalize(input(request, config), userMessage, reply, finished);
    expect(await pendingJobs()).toEqual([]);
    expect(events.map((event) => event.code)).toContain("capture_skipped_consent_changed");
  });

  it("fails closed without breaking the chat when the consent store is unavailable", async () => {
    const instance = newBridge(host({ database: () => undefined }));
    const { context } = await runTurn(instance, bridgeConfig());
    expect(context).toBeUndefined();
    expect(requests).toEqual([]);
    expect(events.map((event) => event.code)).toContain("consent_store_unavailable");

    const unconfigured = newBridge(null);
    expect(unconfigured.available(bridgeConfig(), { id: "owner" })).toBe(false);
    expect((await runTurn(unconfigured, bridgeConfig())).context).toBeUndefined();
  });

  it("does not fail terminal persistence when the consent check at capture fails", async () => {
    const instance = newBridge();
    const config = bridgeConfig();
    await enableConsent(instance);
    const request = await admitTurn(instance, config);
    await instance.prepare(input(request, config));
    await database
      .collection("hindsightconsents")
      .updateOne({ conversationId: "convo" }, { $set: { enabled: "corrupt" } });
    await expect(
      instance.finalize(input(request, config), userMessage, reply, finished)
    ).resolves.toBeUndefined();
    expect(await pendingJobs()).toEqual([]);
    expect(events.map((event) => event.code)).toContain("consent_record_invalid");
  });

  it("never captures an exchange from a conversation other than the admitted one", async () => {
    const instance = newBridge();
    const config = bridgeConfig();
    await enableConsent(instance);
    await enableConsent(instance, "other");
    const request = await admitTurn(instance, config, { conversationId: "convo" });
    await instance.prepare(input(request, config));
    const elsewhere = { ...userMessage, conversationId: "other" };
    const elsewhereReply = { ...reply, conversationId: "other" };
    await instance.finalize(input(request, config), elsewhere, elsewhereReply, finished);
    expect(await pendingJobs()).toEqual([]);
    expect(events.map((event) => event.code)).toContain("capture_conversation_mismatch");
  });

  /** Wrap the turn collection so a write commits but its acknowledgement is lost. */
  function lostAcknowledgement(failReadBack: boolean, failWithdraw = false): ConsentDependencies {
    return host({
      database: () => ({
        collection(name: string) {
          const real = database.collection(name);
          if (name !== "hindsightturns") return real;
          let pendingFailure = true;
          let failRead = failReadBack;
          let failUpdate = failWithdraw;
          return {
            createIndex: (...args: Parameters<typeof real.createIndex>) =>
              real.createIndex(...args),
            updateOne: async (...args: Parameters<typeof real.updateOne>) => {
              if (failUpdate) {
                failUpdate = false;
                throw new Error("withdraw failed");
              }
              return real.updateOne(...args);
            },
            findOneAndUpdate: (...args: Parameters<typeof real.findOneAndUpdate>) =>
              real.findOneAndUpdate(...args),
            find: (...args: Parameters<typeof real.find>) => real.find(...args),
            insertOne: async (document: Record<string, unknown>) => {
              await real.insertOne(document);
              if (pendingFailure) {
                pendingFailure = false;
                throw new Error("acknowledgement lost");
              }
            },
            findOne: async (...args: Parameters<typeof real.findOne>) => {
              if (failRead) {
                failRead = false;
                throw new Error("read failed");
              }
              return real.findOne(...args);
            },
          };
        },
      }),
    });
  }

  it.each([
    ["read back succeeds", false, false, "available", "available"],
    ["read back also fails", true, false, undefined, undefined],
    // Permission recovery: the committed record is the On the page confirmed.
    ["read back and withdrawal fail", true, true, undefined, "available"],
  ] as const)(
    "keeps a turn and its resume defined when a record write commits but fails (%s)",
    async (_label, failReadBack, failWithdraw, expected, resumedExpected) => {
      const instance = newBridge(lostAcknowledgement(failReadBack, failWithdraw));
      const config = bridgeConfig();
      await enableConsent(instance);
      const primary = { id: "primary" };
      const turn = 1762500777777;
      const request = await admitTurn(instance, config, { primary, generation: turn });
      expect((await instance.prepare(input(request, config)))?.status).toBe(expected);

      const resumed = {};
      instance.bindAgent(resumed, primary, null, true);
      await instance.restore(
        {
          request: resumed,
          config,
          user: { id: "owner" },
          conversationId: "convo",
          generation: turn,
          temporary: false,
        },
        runClient(primary)
      );
      expect((await instance.prepare(input(resumed, config)))?.status).toBe(resumedExpected);
      if (failWithdraw) {
        expect(events.map((event) => event.code)).toContain("consent_turn_withdraw_failed");
      }
    }
  );

  it("keeps delivering previously authorized captures after a restart, during an Off turn", async () => {
    const config = bridgeConfig({ pollIntervalMs: 60000 });
    const first = newBridge();
    await enableConsent(first);
    bankProtected = false;
    const request = await admitTurn(first, config);
    await first.prepare(input(request, config));
    await first.finalize(input(request, config), userMessage, reply, finished);
    expect(await pendingJobs()).toHaveLength(1);
    await first.close();
    expect(operations.size).toBe(0);

    // The owner switches the chat Off; a restarted process runs an Off turn.
    expect(await first.updateConsent(config, { id: "owner" }, "convo", false)).toEqual({
      ok: true,
      enabled: false,
    });
    bankProtected = true;
    requests = [];
    const restarted = newBridge();
    const { context } = await runTurn(restarted, config, { acknowledged: true });
    expect(context).toBeUndefined();
    await vi.waitFor(() => expect(operations.size).toBe(1));
    const paths = requests.map((record) => record.path);
    expect(paths.some((path) => path.endsWith("/memories/recall"))).toBe(false);
    expect(paths.some((path) => path.endsWith("/reflect"))).toBe(false);
    expect(paths.filter((path) => path.endsWith("/memories"))).toHaveLength(1);
  });
});

describe("consent toggle", () => {
  const owner = { id: "owner" };

  it("reports availability and state only to the owner", async () => {
    const instance = newBridge();
    const config = bridgeConfig();
    expect(instance.available(config, owner)).toBe(true);
    expect(instance.available(config, { id: "someone" })).toBe(false);
    expect(instance.available({ ...config, enabled: false }, owner)).toBe(false);
    expect(await instance.readConsent(config, owner, "convo")).toEqual({
      available: true,
      enabled: false,
    });
    await enableConsent(instance);
    expect(await instance.readConsent(config, owner, "convo")).toEqual({
      available: true,
      enabled: true,
    });
    expect(await instance.readConsent(config, { id: "someone" }, "convo")).toEqual({
      available: false,
      enabled: false,
    });
    expect(await instance.updateConsent(config, { id: "someone" }, "convo", true)).toEqual({
      ok: false,
      code: "hindsight_unavailable",
    });
  });

  it.each([
    ["missing", undefined, "conversation_not_found"],
    ["temporary", { isTemporary: true }, "conversation_unsupported"],
    [
      "subagent thread",
      { subagentThread: { parentConversationId: "parent" } },
      "conversation_unsupported",
    ],
  ] as const)("refuses consent for a %s conversation", async (_label, conversation, code) => {
    const instance = newBridge();
    if (conversation) conversations.set("target", conversation);
    expect(await instance.updateConsent(bridgeConfig(), owner, "target", true)).toEqual({
      ok: false,
      code,
    });
    expect(await database.collection("hindsightconsents").countDocuments()).toBe(0);
    if (conversation) {
      expect(await instance.readConsent(bridgeConfig(), owner, "target")).toEqual({
        available: false,
        enabled: false,
      });
    }
  });

  it.each([
    { status: "running" },
    { status: "requires_action" },
    { status: "complete", metadata: { terminalPersistencePending: true } },
    "cleanup",
  ] as const)("refuses to change consent while a generation is active: %j", async (job) => {
    const instance = newBridge();
    if (job === "cleanup") blockingJobs = ["job-one"];
    else jobs.set("convo", job);
    expect(await instance.updateConsent(bridgeConfig(), owner, "convo", true)).toEqual({
      ok: false,
      code: "generation_active",
    });
    expect(await database.collection("hindsightconsents").countDocuments()).toBe(0);
  });

  it("loses the compare-and-set to a turn admitted after the state was read", async () => {
    let instance: LibreChatMemory;
    const config = bridgeConfig();
    instance = newBridge(
      host({
        generations: {
          getJob: async () => {
            // A turn is admitted between the toggle's read and its write.
            await admitTurn(instance, config);
            return null;
          },
          getCleanupBlockingJobIdsForConversations: async () => [],
        },
      })
    );
    await enableConsent(newBridge());
    expect(await instance.updateConsent(config, owner, "convo", false)).toEqual({
      ok: false,
      code: "consent_conflict",
    });
    expect(await instance.readConsent(config, owner, "convo")).toEqual({
      available: true,
      enabled: true,
    });
  });

  it.each([
    ["an Off turn without the page confirmation", true, { acknowledged: false }],
    ["a turn in a chat with no stored consent", false, {}],
  ] as const)(
    "also loses the compare-and-set to %s admitted mid-toggle",
    async (_label, stored, turnOptions) => {
      const config = bridgeConfig();
      let instance: LibreChatMemory;
      instance = newBridge(
        host({
          generations: {
            getJob: async () => {
              await admitTurn(instance, config, turnOptions);
              return null;
            },
            getCleanupBlockingJobIdsForConversations: async () => [],
          },
        })
      );
      if (stored) await enableConsent(newBridge());
      expect(await instance.updateConsent(config, owner, "convo", !stored)).toEqual({
        ok: false,
        code: "consent_conflict",
      });
      expect((await instance.readConsent(config, owner, "convo")).enabled).toBe(stored);
    }
  );

  it("changes the consent version on each real change and not on a repeat", async () => {
    const instance = newBridge();
    const config = bridgeConfig();
    const consents = database.collection("hindsightconsents");
    await enableConsent(instance);
    await enableConsent(instance);
    expect(await consents.findOne({})).toMatchObject({ enabled: true, version: 1 });
    expect(await instance.updateConsent(config, owner, "convo", false)).toEqual({
      ok: true,
      enabled: false,
    });
    expect(await consents.findOne({})).toMatchObject({ enabled: false, version: 2 });
  });

  it("maps HTTP requests to stable status codes without exposing errors", async () => {
    const instance = newBridge();
    const handlers = consentHandlers(instance);
    const config = { config: { config: { hindsight: bridgeConfig() } } };
    const call = async (
      handler: "availability" | "read" | "update",
      request: Partial<Parameters<typeof handlers.read>[0]>
    ) => {
      let status = 0;
      let body: unknown;
      const response = {
        status(code: number) {
          status = code;
          return response;
        },
        json(value: unknown) {
          body = value;
          return value;
        },
      };
      await handlers[handler]({ params: {}, ...config, user: owner, ...request }, response);
      return { status, body };
    };
    expect(await call("availability", {})).toEqual({ status: 200, body: { available: true } });
    expect(await call("read", { params: { conversationId: "convo" } })).toEqual({
      status: 200,
      body: { available: true, enabled: false },
    });
    expect(await call("read", { params: {} })).toEqual({
      status: 404,
      body: { code: "conversation_not_found" },
    });
    for (const body of [{ enabled: "true" }, { enabled: true, extra: 1 }, undefined]) {
      expect(await call("update", { params: { conversationId: "convo" }, body })).toEqual({
        status: 400,
        body: { code: "invalid_consent_request" },
      });
    }
    expect(
      await call("update", { params: { conversationId: "convo" }, body: { enabled: true } })
    ).toEqual({ status: 200, body: { enabled: true } });
    expect(
      await call("update", { params: { conversationId: "gone" }, body: { enabled: true } })
    ).toEqual({ status: 404, body: { code: "conversation_not_found" } });
    expect(
      await call("update", {
        params: { conversationId: "convo" },
        body: { enabled: false },
        user: { id: "someone" },
      })
    ).toEqual({ status: 403, body: { code: "hindsight_unavailable" } });
    jobs.set("convo", { status: "running" });
    expect(
      await call("update", { params: { conversationId: "convo" }, body: { enabled: false } })
    ).toEqual({ status: 409, body: { code: "generation_active" } });

    const broken = consentHandlers(newBridge(host({ database: () => undefined })));
    let status = 0;
    let payload: unknown;
    const response = {
      status(code: number) {
        status = code;
        return response;
      },
      json(value: unknown) {
        payload = value;
        return value;
      },
    };
    await broken.read({ params: { conversationId: "convo" }, ...config, user: owner }, response);
    expect({ status, payload }).toEqual({
      status: 503,
      payload: { code: "consent_store_unavailable" },
    });
  });
});

describe("conversation documents", () => {
  const ROOT = "00000000-0000-0000-0000-000000000000";
  const finished = { unfinished: false, compaction: false };
  let minute: number;

  beforeEach(() => {
    minute = 0;
  });

  /** A message as the host stores it before it finalizes the turn. */
  function stored(messageId: string, parentMessageId: string, isCreatedByUser: boolean) {
    return {
      messageId,
      parentMessageId,
      conversationId: "convo",
      user: "owner",
      isCreatedByUser,
      text: `${isCreatedByUser ? "ask" : "answer"} ${messageId}`,
      createdAt: new Date(Date.UTC(2026, 10, 8, 9, minute++)),
    };
  }

  /** One turn through the host's sequence; both messages are saved before finalization. */
  async function turn(
    instance: LibreChatMemory,
    user: ReturnType<typeof stored>,
    reply: ReturnType<typeof stored>,
    config = bridgeConfig()
  ) {
    const messages = database.collection("messages");
    for (const message of [user, reply]) {
      if (!(await messages.findOne({ messageId: message.messageId }))) {
        await messages.insertOne({ ...message });
      }
    }
    const request = await admitTurn(instance, config, { conversationId: "convo" });
    const input = { request, user: { id: "owner" }, query: "marker", temporary: false, config };
    await instance.prepare(input);
    await instance.finalize(input, user, reply, finished);
  }

  /** The queued writes, oldest first: with the bank unprotected nothing is submitted. */
  async function queued() {
    const names = (await readdir(join(directory, "pending"))).filter((name) =>
      name.endsWith(".json")
    );
    const jobs = await Promise.all(
      names.map(async (name) =>
        JSON.parse(await readFile(join(directory, "pending", name), "utf8"))
      )
    );
    return jobs
      .sort((a, b) => a.sequence - b.sequence)
      .map((job) => {
        const item = job.request.items[0];
        return {
          documentId: item.document_id as string,
          mode: (item.update_mode ?? "replace") as string,
          answers: (item.content as string)
            .split("\n")
            .map((line) => JSON.parse(line) as { role: string; content: string })
            .filter((turn) => turn.role === "assistant")
            .map((turn) => turn.content.replace("answer ", "")),
        };
      });
  }

  const u1 = () => stored("u1", ROOT, true);
  const r1 = () => stored("r1", "u1", false);
  const u2 = () => stored("u2", "r1", true);
  const r2 = () => stored("r2", "u2", false);
  const u3 = () => stored("u3", "r2", true);
  const r3 = () => stored("r3", "u3", false);

  it("keeps a conversation in one document: the first turn starts it, later turns append", async () => {
    bankProtected = false;
    const instance = newBridge();
    await enableConsent(instance);
    await turn(instance, u1(), r1());
    await turn(instance, u2(), r2());
    expect(await queued()).toEqual([
      { documentId: "conversation:convo", mode: "replace", answers: ["r1"] },
      { documentId: "conversation:convo", mode: "append", answers: ["r2"] },
    ]);
  });

  it("replaces the document with the active branch when an answer is regenerated", async () => {
    bankProtected = false;
    const instance = newBridge();
    await enableConsent(instance);
    const question = u2();
    await turn(instance, u1(), r1());
    await turn(instance, question, r2());
    await turn(instance, question, stored("r2b", "u2", false));
    // The replace re-sends the branch, so the unsubmitted writes before it were dropped.
    expect(await queued()).toEqual([
      { documentId: "conversation:convo", mode: "replace", answers: ["r1", "r2b"] },
    ]);
  });

  it("rebuilds the document when an earlier write was blocked, rather than appending past the gap", async () => {
    operationStatus = "failed";
    // A short delivery interval, so the first write is submitted and comes back failed.
    const config = bridgeConfig({ pollIntervalMs: 20 });
    const instance = newBridge();
    await enableConsent(instance);
    await turn(instance, u1(), r1(), config);
    await vi.waitFor(async () =>
      expect((await readdir(join(directory, "blocked"))).length).toBe(1)
    );
    bankProtected = false;
    await turn(instance, u2(), r2(), config);
    expect(await queued()).toEqual([
      { documentId: "conversation:convo", mode: "replace", answers: ["r1", "r2"] },
    ]);
  });

  it("appends to a document that exists without a record instead of shrinking it", async () => {
    bankProtected = false;
    existingDocuments.add("conversation:convo");
    const instance = newBridge();
    await enableConsent(instance);
    await turn(instance, u1(), r1());
    await turn(instance, u2(), r2());
    await turn(instance, u2(), stored("r2b", "u2", false));
    expect((await queued()).map((write) => write.mode)).toEqual(["append", "append", "append"]);
    expect(await database.collection("hindsighttranscripts").findOne({})).toMatchObject({
      partial: true,
    });
  });

  it("still queues the first exchange when Hindsight cannot be asked whether the document exists", async () => {
    bankProtected = false;
    documentProbeStatus = 503;
    const instance = newBridge();
    await enableConsent(instance);
    await turn(instance, u1(), r1());
    expect(await queued()).toEqual([
      { documentId: "conversation:convo", mode: "append", answers: ["r1"] },
    ]);
    expect(await database.collection("hindsighttranscripts").findOne({})).toMatchObject({
      partial: true,
    });
    expect(events.map((event) => event.code)).toContain("transcript_probe_unavailable");
  });

  it("replaces the document when a reply is continued under the same message id", async () => {
    bankProtected = false;
    const instance = newBridge();
    await enableConsent(instance);
    const question = u1();
    const cut = r1();
    await turn(instance, question, cut);
    await database
      .collection("messages")
      .updateOne({ messageId: "r1" }, { $set: { text: "answer r1 continued" } });
    await turn(instance, question, { ...cut, text: "answer r1 continued" });
    expect(await queued()).toEqual([
      { documentId: "conversation:convo", mode: "replace", answers: ["r1 continued"] },
    ]);
  });

  it("never puts a turn taken while consent was Off into the document", async () => {
    bankProtected = false;
    const instance = newBridge();
    await enableConsent(instance);
    await turn(instance, u1(), r1());
    expect(await instance.updateConsent(bridgeConfig(), { id: "owner" }, "convo", false)).toEqual({
      ok: true,
      enabled: false,
    });
    await turn(instance, u2(), r2());
    await enableConsent(instance);
    const question = u3();
    await turn(instance, question, r3());
    await turn(instance, question, stored("r3b", "u3", false));
    expect(await queued()).toEqual([
      { documentId: "conversation:convo", mode: "replace", answers: ["r1", "r3b"] },
    ]);
  });
});
