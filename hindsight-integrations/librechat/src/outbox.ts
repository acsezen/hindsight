import { link, lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MemoryClient, MemoryError } from "./client.js";
import { jobSchema } from "./records.js";
import type { CaptureJob } from "./records.js";
import type { MemoryConfig, MemoryReporter, QueueStatus } from "./types.js";

/**
 * Read a filesystem error code without `instanceof Error`: under a sandboxed
 * module loader (for example Jest's vm context) Node core errors come from
 * another realm, so `instanceof` fails and a missing file looked like an
 * outage, failing every capture.
 */
function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

export type OperationState = "pending" | "completed" | "blocked" | "missing";

/** A conversation-document write without update_mode replaces the whole document. */
function isReplace(job: CaptureJob): boolean {
  const item = job.request.items[0];
  return item.strategy === "conversation" && item.update_mode === undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** Atomic, owner-only records; fsync both the file and its directory before acknowledgment. */
async function persist(
  path: string,
  directory: string,
  value: unknown,
  exclusive = false
): Promise<void> {
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    if (exclusive) await link(temporary, path);
    else await rename(temporary, path);
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

export class RetainOutbox {
  private readonly pendingDir: string;
  private readonly completedDir: string;
  private readonly blockedDir: string;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private readonly abort = new AbortController();
  private scanOffset = 0;
  private closed = false;

  constructor(
    private readonly config: MemoryConfig,
    private readonly client: MemoryClient,
    private readonly report: MemoryReporter
  ) {
    this.pendingDir = join(config.outboxDir, "pending");
    this.completedDir = join(config.outboxDir, "completed");
    this.blockedDir = join(config.outboxDir, "blocked");
  }

  async initialize(): Promise<void> {
    for (const directory of [
      this.config.outboxDir,
      this.pendingDir,
      this.completedDir,
      this.blockedDir,
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const entry = await lstat(directory);
      if (!entry.isDirectory() || (entry.mode & 0o077) !== 0) {
        throw new MemoryError("outbox_directory_not_private");
      }
    }
    const binding = {
      baseUrl: this.config.baseUrl,
      bankId: this.config.bankId,
      ownerUserId: this.config.ownerUserId,
    };
    const path = join(this.config.outboxDir, "binding.json");
    // Exclusive publication prevents two processes from binding one outbox
    // to different private identities during simultaneous startup.
    try {
      await persist(path, this.config.outboxDir, binding, true);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    if (JSON.stringify(JSON.parse(await readFile(path, "utf8"))) !== JSON.stringify(binding)) {
      throw new MemoryError("outbox_identity_changed");
    }
  }

  start(): void {
    if (this.closed) throw new MemoryError("outbox_closed");
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.drain().catch(() => this.report({ code: "outbox_unavailable" }));
    }, this.config.pollIntervalMs ?? 2000);
    this.timer.unref();
    void this.drain().catch(() => this.report({ code: "outbox_unavailable" }));
  }

  async enqueue(job: CaptureJob): Promise<"queued" | "completed"> {
    if (this.closed) throw new MemoryError("outbox_closed");
    this.validateIdentity(job);
    const name = `${job.operationId}.json`;
    if (await exists(join(this.completedDir, name))) return "completed";
    if (await exists(join(this.blockedDir, name))) throw new MemoryError("capture_blocked");
    const path = join(this.pendingDir, name);
    // Duplicate writers carry the same immutable payload and operation UUID.
    // Resetting submission state is safe: the server deduplicates that UUID.
    if (!(await exists(path))) {
      if (isReplace(job)) await this.supersede(job);
      await persist(path, this.pendingDir, job);
    }
    return "queued";
  }

  /**
   * A replace re-sends the whole branch, so earlier writes to the same document that were never
   * submitted can only add what it already holds: drop them (the extension's replace drops its
   * buffered appends the same way). Submitted ones stay; the server runs them before it.
   */
  private async supersede(replace: CaptureJob): Promise<void> {
    const documentId = replace.request.items[0].document_id;
    for (const { path, job } of await this.pendingJobs()) {
      if (
        job.request.items[0].document_id === documentId &&
        !job.submitted &&
        (job.sequence ?? 0) < (replace.sequence ?? 0)
      ) {
        await unlink(path).catch((error: unknown) => {
          if (!isMissing(error)) throw error;
        });
      }
    }
  }

  /** Pending jobs oldest first; unreadable records are moved aside as before. */
  private async pendingJobs(): Promise<Array<{ name: string; path: string; job: CaptureJob }>> {
    const names = (await readdir(this.pendingDir)).filter((name) => name.endsWith(".json")).sort();
    const entries: Array<{ name: string; path: string; job: CaptureJob }> = [];
    for (const name of names) {
      const path = join(this.pendingDir, name);
      try {
        const job = jobSchema.parse(JSON.parse(await readFile(path, "utf8")));
        this.validateIdentity(job);
        if (name !== `${job.operationId}.json`) throw new MemoryError("invalid_outbox_record");
        entries.push({ name, path, job });
      } catch (error) {
        if (isMissing(error)) continue;
        await rename(path, join(this.blockedDir, name));
        this.report({ code: "invalid_outbox_record" });
      }
    }
    // Per-exchange jobs queued before conversation documents carry no sequence and sort first.
    return entries.sort(
      (a, b) => (a.job.sequence ?? 0) - (b.job.sequence ?? 0) || a.name.localeCompare(b.name)
    );
  }

  /** Where each operation stands locally: still queued, done, or moved aside as blocked. */
  async states(operationIds: string[]): Promise<Map<string, OperationState>> {
    const states = new Map<string, OperationState>();
    for (const operationId of operationIds) {
      const name = `${operationId}.json`;
      let state: OperationState = "missing";
      if (await exists(join(this.completedDir, name))) state = "completed";
      else if (await exists(join(this.blockedDir, name))) state = "blocked";
      else if (await exists(join(this.pendingDir, name))) state = "pending";
      states.set(operationId, state);
    }
    return states;
  }

  drain(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    const pending = this.drainPending();
    this.running = pending;
    void pending
      .finally(() => {
        if (this.running === pending) this.running = undefined;
      })
      .catch(() => {});
    return pending;
  }

  private async drainPending(): Promise<void> {
    // One network request at a time; chat traffic cannot create an unbounded worker pool.
    // A pass starts at a rotating offset so jobs still waiting on the server (each poll is a
    // request) cannot starve the rest. Appends to one conversation document must still reach the
    // server in the order they were written: the server runs one retain per document at a time, in
    // submission order (async_operations.serialization_key). So only a document's oldest
    // unsubmitted job may be submitted; the next one becomes eligible on a later pass.
    const jobs = await this.pendingJobs();
    const head = new Map<string, string>();
    for (const { name, job } of jobs) {
      const documentId = job.request.items[0].document_id;
      if (job.sequence !== undefined && !job.submitted && !head.has(documentId)) {
        head.set(documentId, name);
      }
    }
    const start = jobs.length ? this.scanOffset % jobs.length : 0;
    let requests = 0;
    for (let index = 0; index < jobs.length; index++) {
      if (this.closed || requests >= 32) return;
      const { name, path, job } = jobs[(start + index) % jobs.length];
      this.scanOffset = start + index + 1;
      const documentId = job.request.items[0].document_id;
      if (await exists(join(this.completedDir, name))) {
        await unlink(path).catch((error: unknown) => {
          if (!isMissing(error)) throw error;
        });
        continue;
      }
      if (job.sequence !== undefined && !job.submitted && head.get(documentId) !== name) continue;
      if (job.nextAttemptAt > Date.now()) continue;
      requests += 1;
      const signal = AbortSignal.any([
        this.abort.signal,
        AbortSignal.timeout(this.config.requestTimeoutMs ?? 30000),
      ]);
      try {
        if (!job.submitted) {
          await this.client.submit(job, signal);
          job.submitted = true;
          await persist(path, this.pendingDir, job);
        }
        const status = await this.client.poll(job.operationId, signal);
        if (status === "completed") {
          // An HTTP async acknowledgment is NOT a completion receipt. Keep the
          // payload until the operation is actually complete, then retain only hashes/IDs locally.
          await persist(join(this.completedDir, name), this.completedDir, {
            operationId: job.operationId,
            documentId: job.request.items[0].document_id,
          });
          await unlink(path).catch((error: unknown) => {
            if (!isMissing(error)) throw error;
          });
          this.report({ code: "capture_completed", operationId: job.operationId });
        } else if (status === "failed" || status === "cancelled") {
          await rename(path, join(this.blockedDir, name));
          this.report({ code: "capture_blocked", operationId: job.operationId });
        } else {
          if (status === "not_found") job.submitted = false;
          job.nextAttemptAt = Date.now() + (this.config.pollIntervalMs ?? 2000);
          await persist(path, this.pendingDir, job);
        }
      } catch (error) {
        if (this.closed) return;
        const status = error instanceof MemoryError ? error.status : undefined;
        if (
          status != null &&
          status >= 400 &&
          status < 500 &&
          ![401, 403, 408, 429].includes(status)
        ) {
          await rename(path, join(this.blockedDir, name));
          this.report({ code: "capture_blocked", operationId: job.operationId, status });
        } else {
          job.attempts += 1;
          job.nextAttemptAt = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(job.attempts, 6));
          await persist(path, this.pendingDir, job);
          this.report({
            code: "capture_retry_pending",
            operationId: job.operationId,
            status,
            reason: error instanceof MemoryError ? error.code : undefined,
          });
        }
      }
    }
  }

  private validateIdentity(job: CaptureJob): void {
    if (job.bankId !== this.config.bankId || job.ownerUserId !== this.config.ownerUserId) {
      throw new MemoryError("outbox_identity_changed");
    }
  }

  async status(): Promise<QueueStatus> {
    return {
      pending: (await readdir(this.pendingDir)).filter((name) => name.endsWith(".json")).length,
      blocked: (await readdir(this.blockedDir)).filter((name) => name.endsWith(".json")).length,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.abort.abort();
    await this.running;
  }
}
