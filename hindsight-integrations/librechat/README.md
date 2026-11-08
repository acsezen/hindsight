# @vectorize-io/hindsight-librechat

Native memory lifecycle adapter for self-hosted [LibreChat](https://github.com/danny-avila/LibreChat): automatic per-turn memory injection and durable capture of completed exchanges into one private Hindsight bank, with owner-scoped read-only memory tools on the agent. Hindsight is opt-in per conversation: every chat starts Off.

> **Status: unpublished; pinned integration under validation.** Automatic retrieval and capture have been exercised in a pinned deployment. The dispatch repair passed real-handler, scripted SDK-graph and deployed-image checks; hands-on real-model acceptance remains separate. Earlier direct-tool checks alone did not establish model-invoked execution.
>
> **Per-chat consent is unreleased.** It is covered by synthetic adapter, host and client tests only (stub Hindsight backend, in-memory MongoDB, scripted runs); no image build, browser or real-model acceptance has been performed for it.
>
> The runtime patch targets LibreChat **v0.8.8**, source tag `e8f3be08623663d4ad7f7241e693c94469b63bb0`, framework **4.0.1**, data-provider **0.8.527**. Its five original runtime files were hash-compared with the deployed image. Local core and host regression tests pass; this does not establish repaired-image or real-inference acceptance. The earlier `main` / framework 4.2.1 prototype is not the packaged host patch.

## Design

- **Independent lifecycle gateway.** The adapter does not replace the native memory processor or manage its settings/data. The native `useMemory()` and `memorySchema` definitions remain byte-identical to the target tag. Hindsight has its own top-level `hindsight:` configuration and enablement; the native UI preference does not gate it. Native memory remains user-managed.
- **Retrieval (per turn, fail-open).** `LibreChatMemory.prepare()` queries the fixed private bank (`recall` by default; `reflect` or knowledge pages optional, falling back to raw recall) and returns an escaped `<hindsight-memory>` context block that the host adds to the run context of each Hindsight-capable agent in the run (`appendAgentContext`). Failures report an event and degrade to no memory — a chat turn never fails because of retrieval.
- **Capture (after terminal persistence, never fatal).** `LibreChatMemory.finalize()` runs after save/reference recovery in both ordinary and HITL-resume completion. It can initialize delivery without an earlier retrieval session. Unfinished/aborted/compaction turns are skipped. The write goes to an fsync'd outbox (directories 0700, records 0600), is submitted with a **deterministic operation UUID**, and stays pending until polling reports actual completion. Capture failures report safe codes without failing a committed response.
- **One document per conversation (the coding-agent extension's design).** Each conversation is one document, `conversation:<conversationId>`: a JSONL transcript, one `{role, content, timestamp}` turn per line, retained under the `conversation` strategy with tags `source:chat` and `harness:librechat`. It holds the **active branch**: the admitted exchanges from the root to the newest reply, read from LibreChat's own `messages` collection (owner- and conversation-scoped, visible text only). A new exchange that extends what the document holds is sent with `update_mode: "append"`, one job per exchange; a regenerated or edited turn, a branch switch, a blocked append or an unconfirmed replace re-sends the branch as a replace. Turns taken while consent was Off are never part of it. Per-conversation state (`hindsighttranscripts`) keeps message IDs only, never text. A document that exists without such a record (for example after a rollback) is only ever appended to, never replaced, so it cannot shrink. The outbox submits each document's jobs in the order they were written; the server runs one retain per document at a time. The bank must define the `conversation` strategy, or the server silently falls back to its default retain settings. Checkpoint resumption does not perform a fresh automatic recall.
- **Owner-scoped read-only tools (8).** `attachTools()` adds `hindsight_recall`, `hindsight_reflect`, `hindsight_list_knowledge_pages`, `hindsight_search_knowledge_pages`, `hindsight_read_knowledge_page`, `hindsight_get_document`, `hindsight_delivery_status`, `hindsight_diagnose`. Bindings are request-and-agent-scoped, respect the host tools capability, and inspect inputs/outputs using the host's model-bound content policy. `wrapToolExecution()` composes the upstream loader so advertised tools are executable through the same filtering, callback and cancellation path as ordinary tools. A fresh approval-resume request without bindings fails closed for these tools rather than reusing an earlier request's capability. There is no model-selectable bank argument, global MCP server, or destructive tool. Delivery status describes this outbox, not global consolidation; diagnostics report credential presence, never validity or values.
- **Bank protection gate.** With `requireSensitiveDataProtection` on (default), every submission requires the resolved bank policy to enable a `sensitive_data` rule with action `redact`/`block`. Otherwise delivery waits locally and retries. Provision the selected bank and policy before enabling capture. This guard does not configure the server or prove universal redaction coverage.
- **Privacy.** The API key is read server-side from an env var only; requests are constrained to the configured origin and reject redirects; plain-HTTP base URLs are rejected except localhost; temporary chats are skipped; only visible user/assistant text is retained (never tool results, reasoning, media, or skill primes).

## Per-conversation consent

Hindsight runs only in conversations the owner switched On. Two independent layers decide a turn:

- **Availability.** In a saved agent, Hindsight is a native Tool Library entry (`hindsight` in `agent.tools`, shown only to the owner). A plain model chat is always eligible. Only server-loaded agent definitions count, never the request. Compare-model agents and sub-agents never get Hindsight.
- **Consent.** Per conversation, stored server-side in `hindsightconsents` (`{user, conversationId, enabled, version, fence}`; no row is Off). The owner switches it from the composer: a Tools-menu item and badge in model chats, a badge in chats with a Hindsight-capable agent. New chats start Off and never inherit; a new chat's own choice is saved before its first message is processed. Forks, duplicates and imports get new IDs and start Off.

Each turn is admitted once, before the run starts. It is On only for the owner, in an interactive, non-temporary, non-compaction turn of a capable primary agent, when the stored consent is On **and** the request carries `hindsightMemory: true` — what the page displayed. The request can only narrow consent; old cached pages, API clients and surfaces without the control send nothing and are Off. Scheduled runs, triggers and sub-agent threads are always Off. The decision is written once to `hindsightturns` (with the capable agent IDs); a resumed turn uses only that record, narrowed to agents still capable. The per-request admission is the only input to retrieval, tools, context and capture: an Off turn makes no Hindsight request and queues no capture, and an agent object reused from an On turn loses its Hindsight tools. Capture also requires the consent version to be unchanged since admission, and only for the admitted conversation.

The toggle (`GET /api/hindsight/availability`, `GET|PUT /api/hindsight/consent/:conversationId`) is owner-only, refuses temporary chats and sub-agent threads, and refuses changes while the conversation has a running, paused or still-persisting generation. Every admission advances the row's fence, so a change racing a starting turn fails with a conflict and the page shows the stored state again. Changes apply from the next turn; Stop withdraws the current one (unfinished turns are never captured). Enabling midway never backfills earlier turns.

**Queued deliveries after Off.** Switching a chat Off is prospective: captures it already queued keep delivering, including after a restart, because the delivery worker belongs to the owner, not to a turn. That background delivery is not activity of an Off turn. With `hindsight.enabled: false` (or no `hindsight` section) nothing runs: queued captures stay on disk, paused, until Hindsight is enabled again.

Consent failures fail closed for memory and open for chat: a store error makes the turn Off and never fails the answer. One narrow exception is recorded rather than hidden: if a turn record commits but its acknowledgement is lost, and both the read-back and the follow-up withdrawal also fail, that turn runs Off while a later resume follows the committed record — the On the page confirmed against stored On consent. Capture still requires the consent version to be unchanged.

## Configuration

Top-level `hindsight:` in `librechat.yaml`:

```yaml
hindsight:
  enabled: true
  baseUrl: https://hindsight.example.com
  apiKeyEnv: HINDSIGHT_API_KEY
  bankId: librechat-private
  ownerUserId: "<librechat user id>"
  outboxDir: /app/data/hindsight
  retrieval: recall # recall | reflect | pages
  budget: low # low | mid | high
  maxContextTokens: 2048
  maxContextChars: 12000
  retrievalTimeoutMs: 7000
  requestTimeoutMs: 30000
  pollIntervalMs: 2000
  nativeTools: true
  toolTimeoutMs: 330000
  requireSensitiveDataProtection: true
```

## Local image packaging

The installer changes only nine version-pinned runtime JavaScript paths (`patches/librechat-v0.8.8.json`; seven edited stock files plus two added files). The composer controls are in the browser bundle, which the stock image ships prebuilt: the Dockerfile's `client-build` stage rebuilds `client/dist` from the image's own LibreChat source (`librechat-source.tar`, SHA-256 checked) plus `patches/librechat-v0.8.8-client.patch` (SHA-256 checked), and replaces the stock bundle. Tool execution composes LibreChat's upstream loader callback; it does not modify the agents SDK or generic tool registry. It does not read or modify application YAML, secrets, databases, or compiled schemas. It preflights all source hashes and dependencies before writes, rejects symlinked source paths, and links the addon into the application's `node_modules`. Do not run `--apply` against a serving application.

```bash
npm ci --ignore-scripts
npm run typecheck
npm test -- --maxWorkers=1
npm run build
npm run lint
mkdir -p build-context
npm pack --ignore-scripts --pack-destination build-context
mv build-context/vectorize-io-hindsight-librechat-0.1.0.tgz build-context/hindsight-librechat.tgz
cp package-lock.json build-context/
git -C <librechat checkout> archive --format=tar e8f3be08623663d4ad7f7241e693c94469b63bb0 > build-context/librechat-source.tar
docker build -f deploy/Dockerfile -t librechat-hindsight:0.1.0 build-context
```

The Dockerfile pins the observed stock image digest, uses the matching lockfile with `npm ci --omit=dev --ignore-scripts`, and preserves its runtime user, working directory and command. Build on a workstation or CI runner, not on the production host. An unknown source/framework version fails closed instead of applying a speculative patch. Docker image build/start and real-inference acceptance remain rollout gates.

Before activation, supply the private bank ID and owner ID in the independent configuration above. Deliver `HINDSIGHT_API_KEY` through backend secret configuration only; never put its value in YAML, the image, commands, or logs. Keep `/app/data/hindsight` on persistent private storage and include it in backup planning. The credential resolver is read for every request; Docker environment-file changes still require container recreation.

Disabling `hindsight.enabled` prevents new retrieval/capture. It does not delete memories or cancel server operations. **Rollback must never restore blanket capture**: earlier adapter images capture every owner turn and cannot enforce per-chat consent, so roll back to one only with `hindsight: {enabled: false}` (they accept that hard-off section), and to the stock image only after removing the top-level `hindsight:` section, since its strict loader does not recognize it. Preserve the bank, the outbox and the `hindsightconsents` / `hindsightturns` collections; queued captures wait on disk. Do not change native memory settings/data. Deploying this version switches every conversation Off until the owner turns chats On.

A fixed bank and owner checks are application routing controls, not bank-scoped credential authorization. The backend key and LibreChat administrators with configuration-write capabilities must remain trusted; owner checks do not protect against those administrators. The outbox worker is single-flight within one runtime; shared multi-process delivery has not been validated. No old-chat import, bank migration, code survey, Git ingestion, or automatic runtime updates are performed.

## Known issues and limitations

- **Legacy OCR agents (upstream LibreChat, fix deferred).** The first save of an agent that still stores `tool_resources.ocr` rebuilds its tool list from the stored agent, discarding that save's tool add/remove — including adding or removing Hindsight. Workaround: save such an agent once without changing tools, then make the change and reload to confirm. Covered by `test.failing` regressions in LibreChat's `v1.spec.js`.
- Compare-model agents and sub-agents never get Hindsight; agents without the tool get no Hindsight context or tools of their own, but can still read recalled content through the shared conversation history. Capture includes handoff agents' visible output.
- Model specs with `hideBadgeRow`, temporary chats, and the OpenAI-compatible APIs are always Off.

## Layout

- `src/librechat.ts` — host bridge: `bindAgent` / `beginAdmission` / `admit` / `restore` / `prepare` / `finalize` / `complete` / `attachTools` / `wrapToolExecution` / `appendAgentContext` / `snapshots` / `query` / `requiresFreshRun`, and the consent toggle (`available` / `readConsent` / `updateConsent`)
- `src/consent.ts` — consent and turn-record store over the host's MongoDB connection, with explicit unique indexes
- `src/routes.ts` — Express-compatible toggle handlers with stable error codes
- `src/adapter.ts` — `HindsightMemory`: retrieval, capture, tool factory, lifecycle
- `src/client.ts` — typed SDK wrapper, URL guard, bank-protection check, error sanitization
- `src/transcript.ts` — the active branch from LibreChat's message tree, the append/replace planner, and the per-conversation transcript record store
- `src/records.ts` — conversation document jobs (JSONL, `conversation` strategy) and deterministic operation UUIDs
- `src/outbox.ts` — durable fsync'd pending/completed/blocked outbox with single-flight drain and backoff
- `src/tools.ts` — the 8 read-only tool definitions
- `src/loader.ts` — isolated namespace handling around the unchanged native config loader
- `src/installer.ts` / `src/install.ts` — read-only preflight and explicit build-time application
- `patches/librechat-v0.8.8.json` — version-pinned source hashes and edits
- `patches/librechat-v0.8.8-client.patch` — composer, Tools-menu and Tool Library changes for the client build
- `tests/lifecycle.test.ts` — lifecycle and consent tests against a stub HTTP server and in-memory MongoDB
- `tests/consent.test.ts` — consent store semantics against in-memory MongoDB
- `tests/transcript.test.ts` — branch walk and append/replace planning

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run lint
```

Note: a self-hosted Hindsight API does not imply local inference — check the server's LLM/embeddings provider configuration before sending sensitive content.
