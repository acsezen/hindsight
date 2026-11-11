import { z } from "zod";
import { MemoryError } from "./client.js";

/**
 * The subset of the MongoDB driver used here. The host passes its own live
 * connection (`mongoose.connection.db`), so the adapter adds no runtime
 * database dependency and registers no Mongoose models.
 */
export interface ConsentCollection {
  createIndex(keys: Record<string, 1>, options: { unique: true; name: string }): Promise<string>;
  findOne(
    filter: Record<string, unknown>,
    options: { projection: Record<string, 0 | 1> }
  ): Promise<unknown>;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { returnDocument: "after"; projection: Record<string, 0 | 1>; upsert?: boolean }
  ): Promise<unknown>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert: boolean }
  ): Promise<{ matchedCount: number }>;
  insertOne(document: Record<string, unknown>): Promise<unknown>;
  find(
    filter: Record<string, unknown>,
    options: { projection: Record<string, 0 | 1> }
  ): { toArray(): Promise<unknown[]> };
}

export interface ConsentDatabase {
  collection(name: string): ConsentCollection;
}

export interface ConsentKey {
  user: string;
  conversationId: string;
}

export interface TurnKey extends ConsentKey {
  generation: string;
}

export interface ConsentState {
  enabled: boolean;
  version: number;
  fence: number;
}

/**
 * Why a turn was admitted: `agent` for a saved agent carrying the Hindsight
 * Tool Library entry (on, like any agent tool), `consent` for a model chat's
 * per-chat switch. Records written before the basis existed are `consent`.
 */
export type TurnBasis = "agent" | "consent";

export interface TurnRecord {
  enabled: boolean;
  consentVersion: number;
  capableAgentIds: string[];
  basis: TurnBasis;
}

export type ConsentChange = "changed" | "unchanged" | "conflict";

const consentRow = z.object({
  enabled: z.boolean(),
  version: z.number().int().positive(),
  fence: z.number().int().nonnegative(),
});

const turnRow = z.object({
  enabled: z.boolean(),
  consentVersion: z.number().int().nonnegative(),
  capableAgentIds: z.array(z.string()),
  basis: z.enum(["agent", "consent"]).default("consent"),
});

const consentProjection = { _id: 0, enabled: 1, version: 1, fence: 1 } as const;
const turnProjection = {
  _id: 0,
  enabled: 1,
  consentVersion: 1,
  capableAgentIds: 1,
  basis: 1,
} as const;

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T | null {
  if (value == null) return null;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MemoryError("consent_record_invalid");
  return parsed.data;
}

/** Build filters field by field so a wider key object can never add a predicate. */
function consentFilter(key: ConsentKey): Record<string, string> {
  return { user: key.user, conversationId: key.conversationId };
}

function turnFilter(key: TurnKey): Record<string, string> {
  return { user: key.user, conversationId: key.conversationId, generation: key.generation };
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

/**
 * Job generations are epoch milliseconds. The in-memory job store returns a
 * number while a deserialized Redis job may return a string; both must address
 * the same turn record.
 */
export function turnGeneration(value: unknown): string | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : undefined;
}

/**
 * Per-conversation consent and per-turn decisions, kept outside LibreChat's
 * conversation schema so forks, duplicates and imports never copy consent.
 *
 * `version` changes only when consent changes; `fence` advances on every
 * admission so a toggle racing a starting turn loses its compare-and-set.
 */
export class ConsentStore {
  private constructor(
    private readonly consents: ConsentCollection,
    private readonly turns: ConsentCollection
  ) {}

  /** Index creation is explicit because hosts may run with Mongo autoIndex disabled. */
  static async open(database: ConsentDatabase): Promise<ConsentStore> {
    const consents = database.collection("hindsightconsents");
    const turns = database.collection("hindsightturns");
    await Promise.all([
      consents.createIndex(
        { user: 1, conversationId: 1 },
        { unique: true, name: "hindsight_consent_conversation" }
      ),
      turns.createIndex(
        { user: 1, conversationId: 1, generation: 1 },
        { unique: true, name: "hindsight_turn_generation" }
      ),
    ]);
    return new ConsentStore(consents, turns);
  }

  async read(key: ConsentKey): Promise<ConsentState | null> {
    return parse(
      consentRow,
      await this.consents.findOne(consentFilter(key), { projection: consentProjection })
    );
  }

  /**
   * Fenced admission read. Every admitted turn advances the fence, Off turns
   * included, so a toggle racing any starting turn loses its compare-and-set.
   * A conversation without a row gets an Off row (still Off: only an explicit
   * toggle or a new chat's first-turn choice can store On). Previously an
   * absent row could not be fenced, so a toggle could slip past a starting turn.
   */
  async admit(key: ConsentKey): Promise<ConsentState> {
    const update = {
      $inc: { fence: 1 },
      $setOnInsert: { enabled: false, version: 1, updatedAt: new Date() },
    };
    const options = {
      returnDocument: "after" as const,
      projection: consentProjection,
      upsert: true,
    };
    let row: unknown;
    try {
      row = await this.consents.findOneAndUpdate(consentFilter(key), update, options);
    } catch (error) {
      // Concurrent upserts race on the unique index; the row exists on retry.
      if (!isDuplicateKey(error)) throw error;
      row = await this.consents.findOneAndUpdate(consentFilter(key), update, options);
    }
    const state = parse(consentRow, row);
    if (!state) throw new MemoryError("consent_record_invalid");
    return state;
  }

  /** Persist a new chat's first-turn On choice; an existing row always wins. */
  async insertDraft(key: ConsentKey): Promise<void> {
    try {
      await this.consents.updateOne(
        consentFilter(key),
        { $setOnInsert: { enabled: true, version: 1, fence: 0, updatedAt: new Date() } },
        { upsert: true }
      );
    } catch (error) {
      // Concurrent upserts of the same key race on the unique index; one insert wins.
      if (!isDuplicateKey(error)) throw error;
    }
  }

  async replace(
    key: ConsentKey,
    enabled: boolean,
    expected: ConsentState | null
  ): Promise<ConsentChange> {
    if (expected === null && enabled) {
      try {
        await this.consents.insertOne({
          ...consentFilter(key),
          enabled: true,
          version: 1,
          fence: 0,
          updatedAt: new Date(),
        });
        return "changed";
      } catch (error) {
        if (isDuplicateKey(error)) return "conflict";
        throw error;
      }
    }
    if (expected !== null && expected.enabled !== enabled) {
      const result = await this.consents.updateOne(
        { ...consentFilter(key), version: expected.version, fence: expected.fence },
        { $set: { enabled, updatedAt: new Date() }, $inc: { version: 1 } }
      );
      return result.matchedCount === 1 ? "changed" : "conflict";
    }
    // The caller asked for the value it read. Confirm it still holds rather
    // than reporting a stale read as the stored state.
    const current = await this.read(key);
    return (current?.enabled === true) === enabled ? "unchanged" : "conflict";
  }

  /** Insert-once; a retried generation reads back the first decision. */
  async recordTurn(key: TurnKey, record: TurnRecord): Promise<TurnRecord> {
    try {
      await this.turns.insertOne({
        ...turnFilter(key),
        enabled: record.enabled,
        consentVersion: record.consentVersion,
        capableAgentIds: record.capableAgentIds,
        basis: record.basis,
        createdAt: new Date(),
      });
      return record;
    } catch (error) {
      // A duplicate is a retried generation. Any other error may still have
      // committed the write (a lost acknowledgement): read back so the turn
      // and a later resume agree on one decision.
      const existing = await this.readTurn(key).catch(() => null);
      if (existing) return existing;
      if (isDuplicateKey(error)) throw new MemoryError("consent_record_invalid");
      throw error;
    }
  }

  /**
   * Downgrade a turn record to Off. Used only when admission failed after a
   * write may have committed, so a resume cannot turn an Off turn On.
   */
  async withdrawTurn(key: TurnKey): Promise<void> {
    await this.turns.updateOne(turnFilter(key), {
      $set: { enabled: false, capableAgentIds: [] },
    });
  }

  async readTurn(key: TurnKey): Promise<TurnRecord | null> {
    return parse(
      turnRow,
      await this.turns.findOne(turnFilter(key), { projection: turnProjection })
    );
  }
}
