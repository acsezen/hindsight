import { HindsightMemory } from "./adapter.js";
import { MemoryError } from "./client.js";
import { ConsentStore, turnGeneration } from "./consent.js";
import type { ConsentDatabase, ConsentKey, TurnBasis, TurnKey, TurnRecord } from "./consent.js";
import type { MemoryInspector, MemoryTool, MemoryToolDefinition } from "./tools.js";
import { conversationDocumentId } from "./records.js";
import {
  TranscriptStore,
  branchExchanges,
  exchangeKey,
  exchangeTurns,
  planTranscript,
  visibleText,
  written,
} from "./transcript.js";
import type {
  BranchExchange,
  ExchangeId,
  TranscriptMessage,
  TranscriptRecord,
} from "./transcript.js";
import type { MemoryConfig, MemoryContext, MemoryReporter } from "./types.js";

/** Outstanding appends a record remembers; older ones have long completed or been replaced. */
const MAX_TRACKED_OPS = 32;

/** Plans of one write, before falling back to an append (see `writeTranscript`). */
const MAX_TRANSCRIPT_ATTEMPTS = 3;

/**
 * The message fields the branch walk needs (LibreChat v0.8.8 `messages` schema). Only each content
 * part's type and text: tool results, reasoning and attachments stay in the database.
 */
const messageProjection = {
  _id: 0,
  messageId: 1,
  parentMessageId: 1,
  isCreatedByUser: 1,
  text: 1,
  "content.type": 1,
  "content.text": 1,
  createdAt: 1,
} as const;

function recordFields(record: TranscriptRecord): Omit<TranscriptRecord, "version"> {
  const { version: _version, ...fields } = record;
  return fields;
}

/** `captured` with this exchange in it; the same array when it already was. */
function withCaptured(captured: ExchangeId[], current: ExchangeId): ExchangeId[] {
  return captured.some((exchange) => exchangeKey(exchange) === exchangeKey(current))
    ? captured
    : [...captured, { user: current.user, response: current.response }];
}

/** The `agent.tools` entry that makes a saved agent Hindsight-capable. Never a model tool. */
export const HINDSIGHT_TOOL = "hindsight";

/**
 * Whether LibreChat's generic `tools` agent capability is on for this request: the same
 * `req.config.endpoints.agents.capabilities` list the host gates the read tools on. LibreChat
 * fills in its default capabilities when the YAML omits the key, so an absent list means off.
 */
function toolsCapability(request: object): boolean {
  const capabilities = (
    request as { config?: { endpoints?: { agents?: { capabilities?: unknown } } } }
  ).config?.endpoints?.agents?.capabilities;
  return Array.isArray(capabilities) && capabilities.includes("tools");
}

export interface LibreChatHindsightConfig extends Omit<MemoryConfig, "apiKey"> {
  enabled: boolean;
  apiKeyEnv?: string;
}

export interface LibreChatUser {
  id: string;
  personalization?: { memories?: boolean };
}

export interface LibreChatMessage extends TranscriptMessage {
  conversationId?: string;
  unfinished?: boolean;
  model?: string;
}

export interface LibreChatMemoryContext extends MemoryContext {
  provider: "hindsight";
}

export interface PrepareMemory {
  request: object;
  config?: LibreChatHindsightConfig;
  user: LibreChatUser;
  query?: string;
  messages?: LibreChatMessage[];
  leafId?: string;
  temporary: boolean;
  compaction?: boolean;
  signal?: AbortSignal;
}

export interface HostConversation {
  isTemporary?: boolean | null;
  subagentThread?: unknown;
}

export interface HostGenerationJob {
  status?: string;
  metadata?: { terminalPersistencePending?: boolean } | null;
}

/** Host services for consent; all are owner-scoped reads supplied by LibreChat. */
export interface ConsentDependencies {
  /** The live host database, or undefined before the connection is ready. */
  database(): ConsentDatabase | undefined;
  conversations: {
    get(user: string, conversationId: string): Promise<HostConversation | null | undefined>;
  };
  generations: {
    getJob(conversationId: string): Promise<HostGenerationJob | null | undefined>;
    getCleanupBlockingJobIdsForConversations(
      user: string,
      conversationIds: string[],
      tenantId?: string
    ): Promise<string[]>;
  };
}

/** Trusted per-turn inputs, read by the host before its client starts the run. */
export interface AdmissionInput {
  request: object;
  config?: LibreChatHindsightConfig;
  user: LibreChatUser;
  conversationId: string;
  newConversation: boolean;
  generation: unknown;
  /** False for scheduled fires and agent trigger/event deliveries. */
  interactive: boolean;
  temporary: boolean;
  /** The request's `hindsightMemory` flag: what the sending page displayed. */
  acknowledged: unknown;
}

export interface RestoreInput {
  request: object;
  config?: LibreChatHindsightConfig;
  user: LibreChatUser;
  conversationId: string;
  generation: unknown;
  temporary: boolean;
}

interface RuntimeAgent {
  id?: string;
}

/** The parts of LibreChat's AgentClient that identify this run's reachable agents. */
export interface AdmissionClient {
  options: { agent?: RuntimeAgent | null };
  agentConfigs?: Map<string, RuntimeAgent> | null;
  isCompactionTurn?(): boolean;
}

interface ConsentDecision {
  key: TurnKey;
  enabled: boolean;
  consentVersion: number;
}

export interface PendingAdmission {
  request: object;
  decision: Promise<ConsentDecision | undefined>;
}

interface Admission {
  enabled: boolean;
  basis: TurnBasis;
  consentVersion: number;
  key: ConsentKey;
  agents: WeakSet<object>;
}

export interface ConsentView {
  available: boolean;
  enabled: boolean;
}

export type ConsentUpdate =
  | { ok: true; enabled: boolean }
  | {
      ok: false;
      code:
        | "hindsight_unavailable"
        | "conversation_not_found"
        | "conversation_unsupported"
        | "generation_active"
        | "consent_conflict";
    };

interface MemorySession {
  memory: HindsightMemory;
  user: LibreChatUser;
  temporary: boolean;
  query: string;
  context: Promise<MemoryContext>;
  signal?: AbortSignal;
}

interface ToolExecutionOptions {
  loadTools: (
    names: string[],
    agentId?: string,
    ...args: unknown[]
  ) => Promise<{ loadedTools: Array<{ name: string }> }>;
}

export interface NativeMemoryAgent<T extends { name: string }> {
  id?: string;
  tools: T[];
  toolDefinitions?: MemoryToolDefinition[];
  toolMap?: Map<string, T>;
  toolRegistry?: {
    set(name: string, definition: MemoryToolDefinition): unknown;
    delete(name: string): unknown;
    values?(): Iterable<MemoryToolDefinition>;
  };
}

/** The primary and its reachable (post-pruning) connected agents, without subagents. */
function runtimeAgents(client: AdmissionClient): RuntimeAgent[] {
  return [client.options.agent, ...(client.agentConfigs?.values() ?? [])].filter(
    (agent): agent is RuntimeAgent => agent != null && typeof agent === "object"
  );
}

function addBinding(map: WeakMap<object, WeakSet<object>>, request: object, config: object): void {
  let bound = map.get(request);
  if (!bound) {
    bound = new WeakSet();
    map.set(request, bound);
  }
  bound.add(config);
}

/** Temporary chats and subagent child threads can never hold consent. */
function supported(conversation: HostConversation): boolean {
  return conversation.isTemporary !== true && conversation.subagentThread == null;
}

/** Mirrors LibreChat's code-environment move guard: running, paused, or still persisting. */
function generationActive(job: HostGenerationJob | null | undefined): boolean {
  return (
    job?.status === "running" ||
    job?.status === "requires_action" ||
    job?.metadata?.terminalPersistencePending === true
  );
}

/** Independent, owner-scoped lifecycle bridge; built-in memory settings are not consulted. */
export class LibreChatMemory {
  private readonly sessions = new WeakMap<object, MemorySession>();
  private readonly runtimes = new Map<string, Promise<HindsightMemory>>();
  private readonly attachedAgents = new WeakMap<
    object,
    {
      request: object;
      session: MemorySession;
      names: Set<string>;
      tools: Set<{ name: string }>;
    }
  >();
  private readonly requestAgents = new WeakMap<object, Map<string, object>>();
  /** Runtime agent configs bound as Hindsight-capable, per request. */
  private readonly bindings = new WeakMap<object, WeakSet<object>>();
  /** The subset bound by a server-loaded agent's Tool Library entry (never a model chat). */
  private readonly entryBindings = new WeakMap<object, WeakSet<object>>();
  /** The single consent input for prepare, tools, context and capture. Absent is Off. */
  private readonly admissions = new WeakMap<object, Admission>();
  private store?: Promise<ConsentStore>;
  private transcripts?: Promise<TranscriptStore>;
  /** The write in progress per conversation (see `serialize`). */
  private readonly writing = new Map<string, Promise<void>>();

  constructor(
    private readonly getSecret: (name: string) => string | undefined,
    private readonly report: MemoryReporter,
    private readonly consent?: ConsentDependencies
  ) {}

  private isOwner(
    config: LibreChatHindsightConfig | undefined,
    user: LibreChatUser | undefined
  ): config is LibreChatHindsightConfig {
    return config?.enabled === true && user?.id === config.ownerUserId;
  }

  private consentStore(): Promise<ConsentStore> {
    if (this.store) return this.store;
    const database = this.consent?.database();
    if (!database) return Promise.reject(new MemoryError("consent_store_unavailable"));
    const opening = ConsentStore.open(database);
    this.store = opening;
    // A failed open (for example index creation) is retried by a later turn; meanwhile all turns are Off.
    opening.catch(() => {
      if (this.store === opening) this.store = undefined;
    });
    return opening;
  }

  private transcriptStore(): Promise<TranscriptStore> {
    if (this.transcripts) return this.transcripts;
    const database = this.consent?.database();
    if (!database) return Promise.reject(new MemoryError("consent_store_unavailable"));
    const opening = TranscriptStore.open(database);
    this.transcripts = opening;
    opening.catch(() => {
      if (this.transcripts === opening) this.transcripts = undefined;
    });
    return opening;
  }

  private reportFailure(error: unknown, fallback: string): void {
    this.report({
      code: error instanceof MemoryError ? error.code : fallback,
      status: error instanceof MemoryError ? error.status : undefined,
    });
  }

  /**
   * Record whether a runtime agent config may use Hindsight this run. Only a
   * model chat's ephemeral primary or a server-loaded agent carrying the
   * `hindsight` tool entry qualifies; anything never bound is excluded.
   *
   * The entry is a Tool Library item, governed like a plugin by LibreChat's
   * `tools` capability: with that capability off the client hides it and it
   * does nothing here, as the stock loader skips plugin entries. Like any
   * agent tool it is on in every chat with that agent; only a model chat's
   * ephemeral primary uses the per-chat switch, even if its tool list (which
   * can come from the request) names the entry. A model chat keeps memory
   * without `tools`; it only loses the read tools.
   */
  bindAgent(
    request: object,
    config: object | null | undefined,
    source: { tools?: unknown } | null | undefined,
    ephemeralPrimary = false
  ): void {
    if (config == null) return;
    const marked =
      Array.isArray(source?.tools) &&
      source.tools.includes(HINDSIGHT_TOOL) &&
      toolsCapability(request);
    if (!ephemeralPrimary && !marked) return;
    addBinding(this.bindings, request, config);
    if (!ephemeralPrimary) addBinding(this.entryBindings, request, config);
  }

  /**
   * Start the fenced consent read while the host initializes its client. The
   * returned decision never rejects; a failure is reported and becomes Off.
   */
  beginAdmission(input: AdmissionInput): PendingAdmission {
    this.admissions.delete(input.request);
    return {
      request: input.request,
      decision: this.decide(input).catch((error) => {
        this.reportFailure(error, "consent_store_unavailable");
        return undefined;
      }),
    };
  }

  private async decide(input: AdmissionInput): Promise<ConsentDecision | undefined> {
    // Return before any database work for turns that can never use Hindsight.
    if (!this.isOwner(input.config, input.user) || !input.interactive || input.temporary) return;
    const generation = turnGeneration(input.generation);
    if (!generation || !input.conversationId) {
      this.report({ code: "consent_turn_invalid" });
      return;
    }
    const key = { user: input.user.id, conversationId: input.conversationId, generation };
    const store = await this.consentStore();
    const state =
      input.newConversation && input.acknowledged === true
        ? await this.admitDraft(store, key)
        : await store.admit(key);
    // The request can only narrow consent: without the page's confirmation the turn is Off.
    return {
      key,
      enabled: input.acknowledged === true && state.enabled,
      consentVersion: state.version,
    };
  }

  /**
   * A new chat's first turn may persist the page's local On choice. A
   * server-generated id can collide with an existing chat (a reused client
   * request id), so the draft is honored only when no row exists and the
   * conversation did not exist before this request.
   */
  private async admitDraft(store: ConsentStore, key: ConsentKey) {
    const [existing, conversation] = await Promise.all([
      store.read(key),
      this.consent!.conversations.get(key.user, key.conversationId),
    ]);
    if (!existing && conversation) {
      this.report({ code: "consent_draft_existing_conversation" });
    } else if (!existing) {
      await store.insertDraft(key);
    }
    return store.admit(key);
  }

  /** Finish admission once capability is known; writes the immutable turn record. */
  async admit(pending: PendingAdmission, client: AdmissionClient): Promise<void> {
    let key: TurnKey | undefined;
    try {
      const decision = await pending.decision;
      if (!decision) return;
      key = decision.key;
      const bound = this.bindings.get(pending.request);
      const primary = client.options.agent;
      const capableIds = runtimeAgents(client)
        .filter((agent) => bound?.has(agent) && typeof agent.id === "string")
        .map((agent) => agent.id as string);
      // A saved agent's entry is on like its other tools; a model chat needs its switch.
      const basis: TurnBasis =
        primary != null && this.entryBindings.get(pending.request)?.has(primary) === true
          ? "agent"
          : "consent";
      const enabled =
        (basis === "agent" || decision.enabled) &&
        primary != null &&
        bound?.has(primary) === true &&
        client.isCompactionTurn?.() !== true;
      const store = await this.consentStore();
      const record = await store.recordTurn(decision.key, {
        enabled,
        consentVersion: decision.consentVersion,
        capableAgentIds: enabled ? capableIds : [],
        basis,
      });
      this.settle(pending.request, decision.key, record, client);
    } catch (error) {
      this.admissions.delete(pending.request);
      this.reportFailure(error, "consent_store_unavailable");
      // The record may have committed before the failure; keep resume Off too.
      // If the withdrawal also fails, a later resume follows the committed
      // record: the On that this request's page confirmed against stored On
      // consent (permission recovery, not a widening). Capture still requires
      // the consent version to be unchanged.
      if (key) await this.withdrawTurn(key);
    }
  }

  private async withdrawTurn(key: TurnKey): Promise<void> {
    try {
      await (await this.consentStore()).withdrawTurn(key);
    } catch (error) {
      this.reportFailure(error, "consent_turn_withdraw_failed");
    }
  }

  /** Resume uses only the recorded decision, narrowed to agents still capable now. */
  async restore(input: RestoreInput, client: AdmissionClient): Promise<void> {
    this.admissions.delete(input.request);
    try {
      if (!this.isOwner(input.config, input.user) || input.temporary) return;
      const generation = turnGeneration(input.generation);
      if (!generation) return;
      const key = { user: input.user.id, conversationId: input.conversationId, generation };
      const record = await (await this.consentStore()).readTurn(key);
      if (record) this.settle(input.request, key, record, client);
    } catch (error) {
      this.reportFailure(error, "consent_store_unavailable");
    }
  }

  private settle(request: object, key: TurnKey, record: TurnRecord, client: AdmissionClient): void {
    const bound = this.bindings.get(request);
    const recorded = new Set(record.capableAgentIds);
    const agents = new WeakSet<object>();
    for (const agent of runtimeAgents(client)) {
      if (bound?.has(agent) && typeof agent.id === "string" && recorded.has(agent.id)) {
        agents.add(agent);
      }
    }
    const primary = client.options.agent;
    // An agent-basis record stays on only while the primary still carries the entry.
    const basisHolds =
      record.basis !== "agent" ||
      (primary != null && this.entryBindings.get(request)?.has(primary) === true);
    this.admissions.set(request, {
      enabled: record.enabled && primary != null && agents.has(primary) && basisHolds,
      basis: record.basis,
      consentVersion: record.consentVersion,
      key: { user: key.user, conversationId: key.conversationId },
      agents,
    });
  }

  private agentAllowed(request: object, agent: object): boolean {
    const admission = this.admissions.get(request);
    return admission?.enabled === true && admission.agents.has(agent);
  }

  available(
    config: LibreChatHindsightConfig | undefined,
    user: LibreChatUser | undefined
  ): boolean {
    return this.consent !== undefined && this.isOwner(config, user);
  }

  async readConsent(
    config: LibreChatHindsightConfig | undefined,
    user: LibreChatUser | undefined,
    conversationId: string
  ): Promise<ConsentView> {
    if (!this.available(config, user)) return { available: false, enabled: false };
    const store = await this.consentStore();
    const [conversation, state] = await Promise.all([
      this.consent!.conversations.get(user!.id, conversationId),
      store.read({ user: user!.id, conversationId }),
    ]);
    if (!conversation || !supported(conversation)) return { available: false, enabled: false };
    return { available: true, enabled: state?.enabled === true };
  }

  /**
   * Owner-only toggle. Refused while the conversation has an active, paused or
   * persisting generation; the compare-and-set loses to any turn admitted after
   * the state was read.
   */
  async updateConsent(
    config: LibreChatHindsightConfig | undefined,
    user: (LibreChatUser & { tenantId?: unknown }) | undefined,
    conversationId: string,
    enabled: boolean
  ): Promise<ConsentUpdate> {
    if (!this.available(config, user)) return { ok: false, code: "hindsight_unavailable" };
    const owner = user!.id;
    const store = await this.consentStore();
    const key = { user: owner, conversationId };
    const [conversation, expected] = await Promise.all([
      this.consent!.conversations.get(owner, conversationId),
      store.read(key),
    ]);
    if (!conversation) return { ok: false, code: "conversation_not_found" };
    if (!supported(conversation)) return { ok: false, code: "conversation_unsupported" };
    const tenantId =
      typeof user!.tenantId === "string" && user!.tenantId !== "" ? user!.tenantId : undefined;
    const [job, blocking] = await Promise.all([
      this.consent!.generations.getJob(conversationId),
      this.consent!.generations.getCleanupBlockingJobIdsForConversations(
        owner,
        [conversationId],
        tenantId
      ),
    ]);
    if (generationActive(job) || blocking.length > 0) {
      return { ok: false, code: "generation_active" };
    }
    const change = await store.replace(key, enabled, expected);
    return change === "conflict" ? { ok: false, code: "consent_conflict" } : { ok: true, enabled };
  }

  async prepare(input: PrepareMemory): Promise<LibreChatMemoryContext | undefined> {
    try {
      return await this.prepareContext(input);
    } catch (error) {
      this.report({
        code: error instanceof MemoryError ? error.code : "memory_initialization_unavailable",
        status: error instanceof MemoryError ? error.status : undefined,
      });
      return undefined;
    }
  }

  private allows(
    input: PrepareMemory
  ): input is PrepareMemory & { config: LibreChatHindsightConfig } {
    return (
      input.config?.enabled === true &&
      input.user?.id === input.config.ownerUserId &&
      !input.temporary &&
      !input.compaction
    );
  }

  /**
   * The runtime (and its delivery worker) belongs to the owner, not to a turn:
   * it starts on Off turns too, so previously authorized queued captures keep
   * draining. An Off turn adds no retrieval, tools or capture of its own.
   */
  private runtime(config: LibreChatHindsightConfig): Promise<HindsightMemory> {
    const key = JSON.stringify(config);
    let runtime = this.runtimes.get(key);
    if (!runtime) {
      const apiKey = this.getSecret(config.apiKeyEnv ?? "HINDSIGHT_API_KEY");
      if (!apiKey) throw new MemoryError("missing_hindsight_api_key");
      const { enabled: _enabled, apiKeyEnv: _apiKeyEnv, ...options } = config;
      runtime = HindsightMemory.create({ ...options, apiKey }, this.report, () =>
        this.getSecret(config.apiKeyEnv ?? "HINDSIGHT_API_KEY")
      );
      this.runtimes.set(key, runtime);
      void runtime.catch(() => this.runtimes.delete(key));
    }
    return runtime;
  }

  private async prepareContext(input: PrepareMemory): Promise<LibreChatMemoryContext | undefined> {
    if (!this.allows(input)) {
      this.sessions.delete(input.request);
      return undefined;
    }
    const memory = await this.runtime(input.config);
    if (this.admissions.get(input.request)?.enabled !== true) {
      this.sessions.delete(input.request);
      return undefined;
    }
    const query = this.query(input.query, input.messages, input.leafId);
    let session = this.sessions.get(input.request);
    if (session?.memory !== memory || session.query !== query) {
      session = {
        memory,
        user: input.user,
        temporary: input.temporary,
        query,
        signal: input.signal,
        context: memory.retrieve(
          { userId: input.user.id, hindsightEnabled: true },
          query,
          input.signal
        ),
      };
      this.sessions.set(input.request, session);
    }
    return { provider: "hindsight", ...(await session.context) };
  }

  async complete(
    request: object,
    userMessage: LibreChatMessage,
    response: LibreChatMessage,
    options: { unfinished: boolean; compaction: boolean }
  ): Promise<void> {
    try {
      await this.captureCompleted(request, userMessage, response, options);
    } catch (error) {
      // The host has already committed the answer. Memory failures must not
      // turn a successful chat into a failed terminal publication.
      this.report({
        code: error instanceof MemoryError ? error.code : "capture_storage_unavailable",
        status: error instanceof MemoryError ? error.status : undefined,
      });
    }
  }

  async finalize(
    input: PrepareMemory,
    userMessage: LibreChatMessage | undefined,
    response: LibreChatMessage,
    options: { unfinished: boolean; compaction: boolean; userMetadata?: boolean }
  ): Promise<void> {
    if (!this.allows(input) || this.admissions.get(input.request)?.enabled !== true) {
      this.sessions.delete(input.request);
      return;
    }
    if (options.unfinished || options.compaction) return;
    if (!userMessage) {
      this.report({ code: "capture_skipped_missing_user" });
      return;
    }
    // Resume finalization may have no retrieval session. Initialize delivery
    // independently without querying or injecting after the answer is committed.
    await this.prepare({ ...input, query: "", messages: [], leafId: undefined, signal: undefined });
    // The host's persisted original-user projection deliberately omits its role.
    // Never infer this from a resume request body or override a conflicting role.
    const originalUser =
      options.userMetadata && userMessage?.isCreatedByUser === undefined
        ? { ...userMessage, isCreatedByUser: true }
        : userMessage;
    await this.complete(input.request, originalUser, response, options);
  }

  private async captureCompleted(
    request: object,
    userMessage: LibreChatMessage,
    response: LibreChatMessage,
    options: { unfinished: boolean; compaction: boolean }
  ): Promise<void> {
    const session = this.sessions.get(request);
    const admission = this.admissions.get(request);
    if (!session || admission?.enabled !== true || options.unfinished || options.compaction) {
      return;
    }
    if (userMessage.isCreatedByUser !== true || response.isCreatedByUser !== false) {
      throw new MemoryError("invalid_exchange_roles");
    }
    if (
      !userMessage.messageId ||
      !response.messageId ||
      !response.conversationId ||
      userMessage.conversationId !== response.conversationId ||
      response.parentMessageId !== userMessage.messageId
    )
      throw new MemoryError("invalid_exchange_identity");
    // Consent is per conversation: capture only the admitted conversation, for its owner.
    if (
      response.conversationId !== admission.key.conversationId ||
      session.user.id !== admission.key.user
    ) {
      throw new MemoryError("capture_conversation_mismatch");
    }
    // A model chat's toggles are refused while a turn is active, so a changed
    // version means a race or a bug: capture only what was authorized when the
    // turn started. A saved agent's turn does not depend on the switch.
    if (admission.basis === "consent") {
      const current = await (await this.consentStore()).read(admission.key);
      if (current?.enabled !== true || current.version !== admission.consentVersion) {
        this.report({ code: "capture_skipped_consent_changed" });
        return;
      }
    }
    if (response.unfinished === true) return;
    const key = admission.key;
    await this.serialize(`${key.user}\n${key.conversationId}`, () =>
      this.writeTranscript(session, key, userMessage, response)
    );
  }

  /** One write at a time per conversation, so each plans from the state the previous one left. */
  private async serialize(key: string, task: () => Promise<void>): Promise<void> {
    const run = (this.writing.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
    this.writing.set(key, run);
    try {
      await run;
    } finally {
      if (this.writing.get(key) === run) this.writing.delete(key);
    }
  }

  /**
   * Plan and queue this exchange's write to the conversation document (see `planTranscript`).
   * The branch comes from LibreChat's own message tree, read here rather than taken from the
   * request, so a resumed completion (which has no request history) plans the same way. A
   * compare-and-set lost to another writer re-plans from the newer record; an exchange is never
   * dropped: if every attempt loses, it is appended (which cannot shrink the document) and the
   * record is marked so the next write replaces.
   */
  private async writeTranscript(
    session: MemorySession,
    key: ConsentKey,
    userMessage: LibreChatMessage,
    response: LibreChatMessage
  ): Promise<void> {
    const database = this.consent?.database();
    if (!database) throw new MemoryError("consent_store_unavailable");
    const store = await this.transcriptStore();
    let history: TranscriptMessage[] | undefined;
    const readHistory = async (): Promise<TranscriptMessage[]> =>
      (history ??= (await database
        .collection("messages")
        .find(
          { user: key.user, conversationId: key.conversationId },
          { projection: messageProjection }
        )
        .toArray()) as TranscriptMessage[]);
    const documentId = conversationDocumentId(key.conversationId);
    let current: BranchExchange | undefined;
    for (let attempt = 0; attempt < MAX_TRANSCRIPT_ATTEMPTS; attempt++) {
      const record = await store.read(key);
      let ops = record?.ops ?? [];
      let blocked = false;
      if (ops.length) {
        const states = await session.memory.operationStates(ops);
        blocked = ops.some((id) => states.get(id) === "blocked");
        ops = ops.filter((id) => states.get(id) === "pending");
      }
      // Fast path: the exchange directly continues what the document holds, so walking the
      // branch (a read of every message in the conversation) cannot change the plan.
      const continues =
        record !== null &&
        !record.dirty &&
        !record.partial &&
        !blocked &&
        record.written.at(-1)?.response === userMessage.parentMessageId &&
        userMessage.createdAt !== undefined &&
        response.createdAt !== undefined;
      const stored = continues ? [] : await readHistory();
      // Each turn carries its stored time, so two identical exchanges never share an append
      // identity. Never the wall clock: a re-planned write must produce the same bytes.
      const stamped = (message: LibreChatMessage): LibreChatMessage => ({
        ...message,
        createdAt:
          message.createdAt ?? stored.find((m) => m.messageId === message.messageId)?.createdAt,
      });
      const user = stamped(userMessage);
      const reply = stamped(response);
      current = {
        user: user.messageId ?? "",
        response: reply.messageId ?? "",
        turns: exchangeTurns(user, reply),
      };
      if (current.turns.length === 0) return;
      let documentExists = false;
      if (!record) {
        try {
          documentExists = await session.memory.documentExists(documentId);
        } catch (error) {
          // Unknown is treated as existing: an append can never shrink a document, a replace
          // could. The write is still queued durably instead of being lost to the outage.
          this.report({
            code: "transcript_probe_unavailable",
            status: error instanceof MemoryError ? error.status : undefined,
          });
          documentExists = true;
        }
      }
      const plan = planTranscript({
        record,
        branch: continues ? undefined : branchExchanges(stored, user, reply),
        current,
        documentExists,
        blocked,
      });
      const captured = withCaptured(record?.captured ?? [], current);
      if (plan.mode === "skip") {
        if (record && captured !== record.captured) {
          await store.write(key, { ...recordFields(record), captured, ops }, record);
        }
        return;
      }
      const base = {
        documentId,
        captured,
        partial: record ? record.partial : documentExists,
        startedAt:
          record?.startedAt ?? plan.exchanges[0]?.turns[0]?.timestamp ?? new Date().toISOString(),
      };
      let expected = record;
      if (plan.mode === "replace") {
        // Claim before queueing, as the extension does: a replace whose outcome we never learn
        // resolves to another replace rather than to an append onto an unknown state.
        const claim = { ...base, written: record?.written ?? [], dirty: true, ops };
        if (!(await store.write(key, claim, expected))) continue;
        expected = await store.read(key);
      }
      const result = await session.memory.capture({
        hindsightEnabled: true,
        userId: session.user.id,
        temporary: session.temporary,
        conversationId: key.conversationId,
        mode: plan.mode,
        exchanges: plan.exchanges,
        startedAt: base.startedAt,
        previous: record?.written ?? [],
      });
      const fresh = plan.exchanges.map(written);
      const next = {
        ...base,
        written: plan.mode === "replace" ? fresh : [...(record?.written ?? []), ...fresh],
        dirty: false,
        ops:
          plan.mode === "replace"
            ? result.operationIds
            : [...ops, ...result.operationIds].slice(-MAX_TRACKED_OPS),
      };
      if (!(await store.write(key, next, expected))) await this.keepCaptured(store, key, current);
      return;
    }
    // Every attempt lost its claim to another writer. Queue the exchange anyway as an append.
    if (!current) return;
    await session.memory.capture({
      hindsightEnabled: true,
      userId: session.user.id,
      temporary: session.temporary,
      conversationId: key.conversationId,
      mode: "append",
      exchanges: [current],
      startedAt: current.turns[0]?.timestamp ?? new Date().toISOString(),
      previous: [],
    });
    await this.keepCaptured(store, key, current);
  }

  /**
   * After a lost compare-and-set: keep the exchange in `captured` (later plans filter on it) and
   * mark the record dirty, so the next write rebuilds the document with it.
   */
  private async keepCaptured(
    store: TranscriptStore,
    key: ConsentKey,
    current: ExchangeId
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_TRANSCRIPT_ATTEMPTS; attempt++) {
      const latest = await store.read(key);
      if (!latest) break;
      const next = {
        ...recordFields(latest),
        captured: withCaptured(latest.captured, current),
        dirty: true,
      };
      if (await store.write(key, next, latest)) return;
    }
    this.report({ code: "transcript_conflict" });
  }

  query(
    text: string | undefined,
    messages: LibreChatMessage[] | undefined,
    leafId?: string
  ): string {
    if (text?.trim()) return text;
    const byId = new Map((messages ?? []).map((message) => [message.messageId, message]));
    const visited = new Set<string>();
    let id = leafId;
    while (id && !visited.has(id)) {
      visited.add(id);
      const message = byId.get(id);
      if (!message) break;
      if (message.isCreatedByUser === true) return visibleText(message);
      id = message.parentMessageId;
    }
    return "";
  }

  private isCurrentBinding(request: object, agent: object, session: MemorySession): boolean {
    const binding = this.attachedAgents.get(agent);
    return (
      this.sessions.get(request) === session &&
      binding?.request === request &&
      binding.session === session
    );
  }

  /** Compose the host's public loader, keeping its single policy/execution path intact. */
  wrapToolExecution(request: object, options: ToolExecutionOptions): void {
    const original = options.loadTools;
    const memory = this;
    options.loadTools = async function (this: unknown, names, agentId, ...args) {
      const result = await original.call(this, names, agentId, ...args);
      const agent = agentId ? memory.requestAgents.get(request)?.get(agentId) : undefined;
      const binding = agent ? memory.attachedAgents.get(agent) : undefined;
      if (!agent || !binding || !memory.isCurrentBinding(request, agent, binding.session))
        return result;
      const requested = new Set(names);
      const bound = [...binding.tools].filter((tool) => requested.has(tool.name));
      if (bound.length === 0) return result;
      const loaded = new Set(result.loadedTools.map((tool) => tool.name));
      // An ambiguous executable must fail closed, never send private queries to another tool.
      if (bound.some((tool) => loaded.has(tool.name)))
        throw new MemoryError("hindsight_tool_name_conflict");
      return { ...result, loadedTools: [...result.loadedTools, ...bound] };
    };
  }

  attachTools<T extends { name: string }>(
    request: object,
    agents: NativeMemoryAgent<T>[],
    makeTool: (tool: MemoryTool) => T,
    inspect: MemoryInspector,
    allowed: boolean | undefined
  ): void {
    const session = this.sessions.get(request);
    // Every agent passes through this loop, permitted or not, so a reused agent
    // object loses tools bound by an earlier request.
    for (const agent of agents) {
      const permitted = allowed === true && this.agentAllowed(request, agent);
      const previous = this.attachedAgents.get(agent);
      if (previous?.request === request && previous.session === session && permitted) continue;
      if (previous) {
        agent.tools = agent.tools.filter((tool) => !previous.tools.has(tool));
        agent.toolDefinitions = agent.toolDefinitions?.filter(
          (tool) => !previous.names.has(tool.name)
        );
        for (const name of previous.names) {
          agent.toolMap?.delete(name);
          agent.toolRegistry?.delete(name);
        }
        this.attachedAgents.delete(agent);
      }
      if (!session || !permitted) continue;
      const definitions = session.memory.tools(
        { userId: session.user.id, hindsightEnabled: true },
        inspect,
        session.signal
      );
      const names = new Set([
        ...agent.tools.map((tool) => tool.name),
        ...(agent.toolDefinitions ?? []).map((tool) => tool.name),
        ...[...(agent.toolRegistry?.values?.() ?? [])].map((tool) => tool.name),
      ]);
      if (definitions.some((tool) => names.has(tool.name))) {
        throw new MemoryError("hindsight_tool_name_conflict");
      }
      const native = definitions.map((definition) =>
        makeTool({
          ...definition,
          func: async (input, _manager?: unknown, config?: { signal?: AbortSignal }) => {
            if (!this.isCurrentBinding(request, agent, session))
              throw new MemoryError("memory_session_expired");
            // The host supplies a per-call SDK/breaker signal in addition to the request signal.
            const signals = [session.signal, config?.signal].filter(
              (signal): signal is AbortSignal => signal !== undefined
            );
            const tool = session.memory
              .tools(
                { userId: session.user.id, hindsightEnabled: true },
                inspect,
                signals.length ? AbortSignal.any(signals) : undefined
              )
              .find((candidate) => candidate.name === definition.name);
            if (!tool) throw new MemoryError("memory_session_expired");
            const output = await tool.func(input);
            if (!this.isCurrentBinding(request, agent, session))
              throw new MemoryError("memory_session_expired");
            return output;
          },
        })
      );
      agent.tools = [...agent.tools, ...native];
      const serializable = definitions.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      }));
      agent.toolDefinitions = [...(agent.toolDefinitions ?? []), ...serializable];
      for (const tool of native) agent.toolMap?.set(tool.name, tool);
      for (const definition of serializable) agent.toolRegistry?.set(definition.name, definition);
      this.attachedAgents.set(agent, {
        request,
        session,
        names: new Set(native.map((tool) => tool.name)),
        tools: new Set(native),
      });
      if (agent.id) {
        let agentsById = this.requestAgents.get(request);
        if (!agentsById) {
          agentsById = new Map();
          this.requestAgents.set(request, agentsById);
        }
        agentsById.set(agent.id, agent);
      }
    }
  }

  temporary(request: {
    _agentEventBindingRetention?: { isTemporary?: boolean };
    resolvedConversation?: { isTemporary?: boolean };
    body?: { isTemporary?: boolean };
  }): boolean {
    return (
      (request._agentEventBindingRetention?.isTemporary ??
        request.resolvedConversation?.isTemporary ??
        request.body?.isTemporary) === true
    );
  }

  requiresFreshRun(config: LibreChatHindsightConfig | undefined, user: LibreChatUser): boolean {
    // Warm actor graphs retain tool closures. Rebuild this owner's graph so
    // callbacks and cancellation/policy checks belong to the current request.
    return config?.enabled === true && config.ownerUserId === user.id;
  }

  /**
   * Inject recalled context into one capable agent's run context. Previously
   * the block went into the run-wide shared context, which reached every agent
   * in a handoff graph regardless of its own tools.
   */
  appendAgentContext(
    request: object,
    agent: object,
    context: LibreChatMemoryContext | undefined,
    parts: string[],
    inspection: { add(value: string): unknown },
    agentInspection: string[]
  ): void {
    if (!context || !this.agentAllowed(request, agent)) return;
    const blocks = [context.text];
    // The tool guide names the read tools: only an agent this request attached them to gets it.
    const binding = this.attachedAgents.get(agent);
    if (
      context.guide &&
      binding?.request === request &&
      binding.names.has("hindsight_search_knowledge_pages")
    ) {
      blocks.push(context.guide);
    }
    for (const block of blocks.filter(Boolean)) {
      parts.push(block);
      inspection.add(block);
      agentInspection.push(block);
    }
  }

  snapshots(
    context: LibreChatMemoryContext | undefined,
    existing: Array<{ scope: string; withKeys?: string; withoutKeys?: string }>
  ): Array<{ scope: string; withKeys?: string; withoutKeys?: string }> {
    if (!context) return existing;
    return [...existing, { scope: "hindsight", withoutKeys: context.text }];
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.runtimes.values()].map(async (runtime) => (await runtime).close())
    );
    this.runtimes.clear();
    // The host's connection may be replaced after shutdown; reopen on next use.
    this.store = undefined;
  }
}
