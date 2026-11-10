import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConsentStore, turnGeneration } from "../src/consent.js";
import type { Db } from "mongodb";

let server: MongoMemoryServer;
let client: MongoClient;
let database: Db;

const key = { user: "owner", conversationId: "conversation-one" };

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
});

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

beforeEach(async () => {
  database = client.db(`consent-${Math.random().toString(36).slice(2)}`);
});

describe("consent store", () => {
  it("creates unique indexes explicitly, without relying on host autoIndex", async () => {
    await ConsentStore.open(database);
    const consentIndexes = await database.collection("hindsightconsents").indexes();
    const turnIndexes = await database.collection("hindsightturns").indexes();
    expect(consentIndexes).toContainEqual(
      expect.objectContaining({ key: { user: 1, conversationId: 1 }, unique: true })
    );
    expect(turnIndexes).toContainEqual(
      expect.objectContaining({ key: { user: 1, conversationId: 1, generation: 1 }, unique: true })
    );
  });

  it("treats a missing row as Off; admission fences it with an Off row", async () => {
    const store = await ConsentStore.open(database);
    expect(await store.read(key)).toBeNull();
    expect(await store.admit(key)).toEqual({ enabled: false, version: 1, fence: 1 });
    expect(await store.admit(key)).toEqual({ enabled: false, version: 1, fence: 2 });
    expect(await database.collection("hindsightconsents").countDocuments()).toBe(1);
    // A toggle that read "no row" before that admission now loses its insert.
    expect(await store.replace(key, true, null)).toBe("conflict");
  });

  it("creates one Off row under concurrent first admissions", async () => {
    const store = await ConsentStore.open(database);
    const states = await Promise.all(Array.from({ length: 5 }, () => store.admit(key)));
    expect(states.every((state) => state.enabled === false)).toBe(true);
    expect(new Set(states.map((state) => state.fence)).size).toBe(5);
    expect(await database.collection("hindsightconsents").countDocuments()).toBe(1);
  });

  it("fences each admission without changing the consent version", async () => {
    const store = await ConsentStore.open(database);
    expect(await store.replace(key, true, null)).toBe("changed");
    const first = await store.admit(key);
    const second = await store.admit(key);
    expect(first).toMatchObject({ enabled: true, version: 1 });
    expect(second).toMatchObject({ enabled: true, version: 1 });
    expect(second!.fence).toBe(first!.fence + 1);
  });

  it("inserts a new-chat draft once, even under concurrent retries", async () => {
    const store = await ConsentStore.open(database);
    await Promise.all(Array.from({ length: 5 }, () => store.insertDraft(key)));
    expect(await database.collection("hindsightconsents").countDocuments()).toBe(1);
    expect(await store.read(key)).toMatchObject({ enabled: true, version: 1 });
    expect(await store.replace(key, false, await store.read(key))).toBe("changed");
    await store.insertDraft(key);
    expect(await store.read(key)).toMatchObject({ enabled: false, version: 2 });
  });

  it("changes consent only through a compare-and-set on version and fence", async () => {
    const store = await ConsentStore.open(database);
    expect(await store.replace(key, false, null)).toBe("unchanged");
    expect(await database.collection("hindsightconsents").countDocuments()).toBe(0);
    expect(await store.replace(key, true, null)).toBe("changed");
    expect(await store.replace(key, true, null)).toBe("conflict");

    const read = await store.read(key);
    expect(await store.replace(key, true, read)).toBe("unchanged");
    await store.admit(key);
    expect(await store.replace(key, false, read)).toBe("conflict");
    expect(await store.read(key)).toMatchObject({ enabled: true, version: 1 });

    const fresh = await store.read(key);
    expect(await store.replace(key, false, fresh)).toBe("changed");
    expect(await store.read(key)).toMatchObject({ enabled: false, version: 2 });
    expect(await store.replace(key, true, fresh)).toBe("conflict");
  });

  it("records one immutable decision per turn and returns the first on a retry", async () => {
    const store = await ConsentStore.open(database);
    const turn = { ...key, generation: "1762500000000" };
    const first = {
      enabled: true,
      consentVersion: 3,
      capableAgentIds: ["agent-one"],
      basis: "agent" as const,
    };
    expect(await store.recordTurn(turn, first)).toEqual(first);
    expect(
      await store.recordTurn(turn, {
        enabled: false,
        consentVersion: 4,
        capableAgentIds: [],
        basis: "consent",
      })
    ).toEqual(first);
    expect(await store.readTurn(turn)).toEqual(first);
    expect(await store.readTurn({ ...turn, generation: "1762500000001" })).toBeNull();
    await store.withdrawTurn(turn);
    expect(await store.readTurn(turn)).toEqual({
      enabled: false,
      consentVersion: 3,
      capableAgentIds: [],
      basis: "agent",
    });
  });

  it("reads a turn recorded before the basis existed as a per-chat consent turn", async () => {
    const store = await ConsentStore.open(database);
    const turn = { ...key, generation: "1762500000002" };
    await database.collection("hindsightturns").insertOne({
      ...turn,
      enabled: true,
      consentVersion: 2,
      capableAgentIds: ["agent-one"],
      createdAt: new Date(),
    });
    expect(await store.readTurn(turn)).toEqual({
      enabled: true,
      consentVersion: 2,
      capableAgentIds: ["agent-one"],
      basis: "consent",
    });
  });

  it("rejects malformed stored rows instead of reading them as consent", async () => {
    const store = await ConsentStore.open(database);
    await database
      .collection("hindsightconsents")
      .insertOne({ ...key, enabled: "yes", version: 1, fence: 0 });
    await expect(store.read(key)).rejects.toThrow("consent_record_invalid");
    await expect(store.admit(key)).rejects.toThrow("consent_record_invalid");
  });

  it("normalizes job generations from numbers and deserialized strings", () => {
    expect(turnGeneration(1762500000000)).toBe("1762500000000");
    expect(turnGeneration("1762500000000")).toBe("1762500000000");
    expect(turnGeneration("not-a-time")).toBeUndefined();
    expect(turnGeneration(undefined)).toBeUndefined();
    expect(turnGeneration(-1)).toBeUndefined();
    expect(turnGeneration(1.5)).toBeUndefined();
  });
});
