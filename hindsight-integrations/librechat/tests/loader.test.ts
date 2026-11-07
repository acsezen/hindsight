import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { createHindsightConfigLoader } from "../src/loader.js";
import { hindsightConfigSchema } from "../src/config.js";

const own = {
  enabled: true,
  baseUrl: "https://memory.example.test",
  bankId: "private",
  ownerUserId: "owner",
};
const nativeSchema = z
  .object({
    version: z.string(),
    memory: z.object({ disabled: z.boolean(), agent: z.object({ enabled: z.boolean() }) }),
  })
  .strict();
const native = { version: "1", memory: { disabled: true, agent: { enabled: true } } };
const dependencies = { remote: { get: vi.fn() }, parseYaml: JSON.parse };

function options(raw: object) {
  return {
    defaultConfigPath: "/fixture.yaml",
    loadLocal: () => raw,
    redactConfig: (value: object) => value,
  };
}

describe("independent configuration loader", () => {
  it("keeps native strict validation and native memory settings unchanged", async () => {
    const raw = { ...native, hindsight: own };
    const factory = vi.fn(
      (opts: { loadLocal(path: string): unknown }) => async () =>
        nativeSchema.parse(opts.loadLocal("/fixture.yaml"))
    );

    const loader = createHindsightConfigLoader(factory, options(raw), dependencies);
    const loaded = await loader();
    expect(loaded?.memory).toEqual(native.memory);
    expect(loaded?.hindsight).toMatchObject(own);
    expect(raw.hindsight).toBe(own);
    await loader();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("leaves missing/disabled integration sections inert without backend configuration", async () => {
    const factory = (opts: { loadLocal(path: string): unknown }) => async () =>
      nativeSchema.parse(opts.loadLocal("/fixture.yaml"));
    expect(await createHindsightConfigLoader(factory, options(native), dependencies)()).toEqual(
      native
    );
    expect(
      await createHindsightConfigLoader(
        factory,
        options({ ...native, hindsight: { enabled: false } }),
        dependencies
      )()
    ).toEqual({ ...native, hindsight: { enabled: false } });
  });

  it("does not share integration configuration between concurrent reloads", async () => {
    let first!: (value: { data: string }) => void;
    let second!: (value: { data: string }) => void;
    const remote = {
      get: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              first = resolve;
            })
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              second = resolve;
            })
        ),
    };
    const factory = (opts: { fetchRemote?: (path: string) => Promise<unknown> }) => async () => {
      // Return a clone, as a host loader is free to do.
      return nativeSchema.parse(await opts.fetchRemote!("https://config.example.test"));
    };
    const loader = createHindsightConfigLoader(factory, options(native), {
      remote,
      parseYaml: JSON.parse,
    });
    const a = loader();
    const b = loader();
    second({ data: JSON.stringify({ ...native, hindsight: { ...own, bankId: "bank-b" } }) });
    first({ data: JSON.stringify({ ...native, hindsight: { ...own, bankId: "bank-a" } }) });
    expect((await a)?.hindsight).toMatchObject({ bankId: "bank-a" });
    expect((await b)?.hindsight).toMatchObject({ bankId: "bank-b" });
  });

  it("lets the native loader report malformed remote YAML using its original error path", async () => {
    const factory = (opts: { fetchRemote?: (path: string) => Promise<unknown> }) => async () => {
      const raw = await opts.fetchRemote!("https://config.example.test");
      expect(raw).toBe("not valid YAML");
      throw new Error("native_yaml_error");
    };
    const loader = createHindsightConfigLoader(factory, options(native), {
      remote: { get: async () => ({ data: "not valid YAML" }) },
      parseYaml: () => {
        throw new Error("parse_failure");
      },
    });
    await expect(loader()).rejects.toThrow("native_yaml_error");
  });

  it("rejects embedded credential values in enabled configuration", () => {
    expect(
      hindsightConfigSchema.safeParse({ ...own, apiKey: "synthetic-forbidden-yaml-token" }).success
    ).toBe(false);
    expect(hindsightConfigSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });
});
