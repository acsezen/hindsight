---
sidebar_position: 43
title: "LibreChat Native Memory with Hindsight | Integration"
description: "Native lifecycle memory adapter for self-hosted LibreChat: automatic memory injection per turn, durable capture of completed exchanges into one private Hindsight bank, and owner-scoped read-only memory tools. Independent of LibreChat's built-in memory."
---

# LibreChat

`@vectorize-io/hindsight-librechat` is a native lifecycle adapter that gives a self-hosted [LibreChat](https://github.com/danny-avila/LibreChat) deployment persistent, private memory backed by Hindsight — without touching LibreChat's built-in memory system.

:::info Status: local / unpublished; live acceptance pending
The package is developed in `hindsight-integrations/librechat` and is **not yet published or deployed**. A hash-checked build-time installer targets LibreChat **v0.8.8**, source tag `e8f3be08623663d4ad7f7241e693c94469b63bb0`, with framework **4.0.1** and data-provider **0.8.527**. Its original runtime files were hash-compared with the deployed image; local core and host regression tests pass. A running-container and real-inference acceptance test has not been performed.

The earlier `main` / framework 4.2.1 prototype is not the packaged host patch. Other versions require separate validation.
:::

## What it does

- **Opt-in per conversation** — Hindsight runs only in chats the owner switched On; every chat starts Off and never inherits. In saved agents, Hindsight is a native Tool Library entry that makes the agent eligible; each chat is still switched On from the composer. The decision is made once per turn, server-side, and an Off turn sends nothing to Hindsight. Captures already queued keep delivering after a chat is switched Off.
- **Automatic retrieval** — before each agent run, the owner's private bank is queried (`recall` by default; `reflect` or knowledge pages optional) and the result is injected as escaped context into the run context of each Hindsight-capable agent. Retrieval failures degrade to "no memory" and never block the turn.
- **Durable retention** — after LibreChat has persisted the terminal response message (and its conversation reference), the completed user/assistant exchange is written to a local fsync'd outbox and submitted to Hindsight as an **async retain with a deterministic operation UUID**, then polled to completion. Stable operation and document IDs make retries idempotent at the API boundary. As in the coding-agent integration, **each conversation is one document** (`conversation:<conversationId>`): a JSONL transcript of the active branch's admitted exchanges under the `conversation` strategy, tagged `source:chat` and `harness:librechat`. New exchanges are appended (`update_mode: "append"`); a regenerated or edited turn re-sends the branch as a replace. Turns taken while a chat was Off are never included. Ordinary and HITL-resume completions have separate persistence hooks. Unfinished/aborted/compaction turns are skipped; checkpoint resumption does not issue a fresh automatic recall.
- **Read-only memory tools** — the owner's agents additionally get eight native, owner-scoped tools: `hindsight_recall`, `hindsight_reflect`, `hindsight_list_knowledge_pages`, `hindsight_search_knowledge_pages`, `hindsight_read_knowledge_page`, `hindsight_get_document`, `hindsight_delivery_status`, and `hindsight_diagnose`. No global MCP server is registered.
- **Independence from built-in memory** — the adapter has its own top-level `hindsight:` configuration and enablement flag. The adapter does not manage native settings or stored data, and does not consult the UI memory preference as an enablement gate. The native `useMemory()` and `memorySchema` definitions remain byte-identical to the target tag. Native memory remains user-managed.

## Configuration

Top-level `hindsight:` key in `librechat.yaml` (independent of the `memory:` section):

```yaml
hindsight:
  enabled: true
  baseUrl: https://hindsight.example.com   # https required; plain http only for localhost
  apiKeyEnv: HINDSIGHT_API_KEY             # credential read server-side from this env var, never from config
  bankId: librechat-private                # one dedicated private bank
  ownerUserId: "<librechat user id>"       # only this user's chats switched On are injected/captured
  outboxDir: /app/data/hindsight           # durable local outbox; mount a volume here
  retrieval: recall                        # recall | reflect | pages
  budget: low                              # low | mid | high
  maxContextTokens: 2048
  maxContextChars: 12000
  retrievalTimeoutMs: 7000
  requestTimeoutMs: 30000
  pollIntervalMs: 2000
  nativeTools: true                        # owner-scoped read-only tools (8)
  toolTimeoutMs: 330000
  requireSensitiveDataProtection: true     # default on; see below
```

## Safety properties

- **Bank protection gate** — with `requireSensitiveDataProtection` on (the default), every submission first verifies the target bank's `memory_defense` policy contains a `sensitive_data` rule with action `redact` or `block`. Delivery waits locally if the resolved policy lacks that protection. Provision the selected bank and policy before enabling capture; this read-only guard does not configure the server or prove universal redaction coverage.
- **Privacy** — the API key lives only in a server-side environment variable; requests use `Authorization: Bearer` from the server, are constrained to the configured origin, and refuse redirects. Plain-HTTP base URLs are rejected except for localhost. Temporary chats are never captured, and retained content is limited to visible user/assistant text — never tool results, reasoning, media, or skill prompts.
- **Reliability** — config errors and retention failures are reported and swallowed: they can never turn a committed chat into a failed request. Retrieval is fail-open.
- **Inference locality** — a self-hosted Hindsight API does not imply local inference. Check the server's configured LLM/embeddings providers before sending sensitive company content.

## Packaging and rollout

The package README documents the pinned Dockerfile, explicit installer preflight/application, persistent outbox, backend-only secret delivery and rollback. The installer accepts only nine known runtime JavaScript paths, and the image rebuilds the browser bundle from the pinned source plus a hash-checked client patch. Rollback to an earlier adapter image must use `hindsight: {enabled: false}`, since those images capture every owner turn. The installer leaves YAML, secrets, databases and compiled schemas untouched. It rejects unknown source hashes rather than patching another version speculatively.

Delivery status reports local pending/blocked records, not global consolidation. Diagnostics report credential presence, not credential validity or values. Fixed-bank routing and owner checks do not turn a broad API key into a bank-scoped credential. Backend credential holders and LibreChat administrators with configuration-write capabilities remain trusted; owner checks do not protect against those administrators. Shared multi-process outbox delivery has not been validated.

No historical-chat import, native-memory migration, Git/codebase seeding, additional server instance, or proxy is introduced. Deployment and live synthetic acceptance remain explicit rollout steps.

[View Changelog →](/changelog/integrations/librechat)
