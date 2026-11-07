import { AsyncLocalStorage } from "node:async_hooks";
import type { z } from "zod";
import { hindsightConfigSchema } from "./config.js";
import { MemoryError } from "./client.js";

type HindsightConfig = z.output<typeof hindsightConfigSchema>;
type LoadOptions = { mode?: "startup" | "reload" };
type ConfigLoader<T extends object> = (
  printConfig?: boolean,
  options?: LoadOptions
) => Promise<T | null>;

interface LoaderOptions<T extends object> {
  defaultConfigPath: string;
  loadLocal: (path: string) => unknown;
  redactConfig: (config: T) => unknown;
  fetchRemote?: (path: string) => Promise<unknown>;
}

interface LoaderDependencies {
  remote: { get(path: string): Promise<{ data: unknown }> };
  parseYaml: (text: string) => unknown;
}

/** Preserve the host loader's validation, defaults, error handling and reload state.
 * Only the adapter's independent namespace is removed before native validation.
 */
export function createHindsightConfigLoader<T extends object>(
  createLoader: (options: LoaderOptions<T>) => ConfigLoader<T>,
  options: LoaderOptions<T>,
  dependencies: LoaderDependencies
): ConfigLoader<T & { hindsight?: HindsightConfig }> {
  const calls = new AsyncLocalStorage<{ hindsight?: HindsightConfig }>();
  function nativeConfig(raw: unknown): unknown {
    let value = raw;
    if (typeof raw === "string") {
      try {
        value = dependencies.parseYaml(raw);
      } catch {
        // Let the native loader report its original YAML error, not a fetch error.
        return raw;
      }
    }
    if (
      value == null ||
      typeof value !== "object" ||
      value instanceof Error ||
      Array.isArray(value) ||
      !("hindsight" in value)
    )
      return value;
    const { hindsight, ...native } = value;
    const parsed = hindsightConfigSchema.optional().safeParse(hindsight);
    if (!parsed.success) throw new MemoryError("invalid_hindsight_configuration");
    const call = calls.getStore();
    if (!call) throw new MemoryError("config_loader_outside_call");
    call.hindsight = parsed.data;
    return native;
  }
  const load = createLoader({
    ...options,
    loadLocal: (path) => nativeConfig(options.loadLocal(path)),
    fetchRemote: async (path) =>
      nativeConfig(
        options.fetchRemote
          ? await options.fetchRemote(path)
          : (await dependencies.remote.get(path)).data
      ),
  });
  return (printConfig, loadOptions) =>
    calls.run({}, async () => {
      const config = await load(printConfig, loadOptions);
      const hindsight = calls.getStore()?.hindsight;
      return config && hindsight ? { ...config, hindsight } : config;
    });
}
