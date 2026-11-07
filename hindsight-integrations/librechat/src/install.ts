import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apply, loadManifest, preflight } from "./installer.js";
import type { ApplyResult, PreflightResult } from "./installer.js";

/**
 * ESM-only installer CLI. Build-time, local: hash-checked, idempotent
 * application of the native runtime patch to an inactive LibreChat
 * image/root. Check mode (default) never writes; --apply writes explicitly.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST = join(packageRoot, "patches", "librechat-v0.8.8.json");

const HELP = `hindsight-librechat installer (local, build-time)

Usage:
  install.js --root PATH [--check] [--manifest PATH]   read-only preflight (default)
  install.js --root PATH --apply [--manifest PATH]      apply the patch
  install.js                                            this help

Never reads or changes librechat.yaml, .env, databases, built-in memory
settings/data, or compiled package schemas. Output is safe codes and
relative paths/counts only.`;

interface CliArgs {
  root?: string;
  mode: "check" | "apply";
  manifest?: string;
  help: boolean;
  usageError: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mode: "check", help: argv.length === 0, usageError: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") args.mode = "check";
    else if (arg === "--apply") args.mode = "apply";
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--root") args.root = argv[++i];
    else if (arg === "--manifest") args.manifest = argv[++i];
    else args.usageError = true;
  }
  if (args.usageError || (!args.help && !args.root)) args.usageError = true;
  return args;
}

function printResult(result: PreflightResult | ApplyResult): void {
  const lines = [
    `code: ${result.code}`,
    `librechat: ${result.librechatVersion} framework: ${result.frameworkVersion}`,
    `files: create=${result.counts.create} patch=${result.counts.patch} unchanged=${result.counts.unchanged}`,
    `adapter: ${result.adapter}`,
  ];
  if ("applied" in result) {
    lines.push(
      `applied: ${result.applied}`,
      `written: ${result.written.length}`,
      `linkCreated: ${result.linkCreated}`
    );
    for (const path of result.written) lines.push(`wrote: ${path}`);
  } else {
    for (const plan of result.plans) {
      if (plan.action !== "unchanged") lines.push(`would ${plan.action}: ${plan.path}`);
    }
  }
  process.stdout.write(lines.join("\n") + "\n");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP + "\n");
    return 0;
  }
  if (args.usageError || !args.root) {
    process.stderr.write(HELP + "\n");
    return 2;
  }
  const root = resolve(args.root);
  const manifestPath = resolve(args.manifest ?? DEFAULT_MANIFEST);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    process.stdout.write("code: manifest_missing\n");
    return 1;
  }
  let manifest;
  try {
    manifest = loadManifest(raw);
  } catch {
    process.stdout.write("code: manifest_invalid\n");
    return 1;
  }
  try {
    const result =
      args.mode === "apply"
        ? await apply(root, manifest, packageRoot)
        : await preflight(root, manifest, packageRoot);
    printResult(result);
    return result.ok ? 0 : 1;
  } catch (error) {
    const code = (error as { code?: string }).code;
    process.stdout.write(`code: ${typeof code === "string" ? code : "io_error"}\n`);
    return 1;
  }
}

process.exitCode = await main();
