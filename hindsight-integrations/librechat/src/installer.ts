import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";

/**
 * Build-time installer core for the native LibreChat runtime patch.
 *
 * Safety contract:
 * - check mode performs zero writes (no temp files, no links);
 * - apply preflights EVERYTHING (version, dependency, paths, hashes, edits,
 *   adapter link) before the first write;
 * - the manifest may never touch librechat.yaml, .env*, or node_modules
 *   (the only node_modules write is the adapter symlink, created by apply);
 * - output carries safe codes and relative paths/counts only.
 */

export const installerCodes = [
  "ok",
  "usage",
  "root_missing",
  "manifest_missing",
  "manifest_invalid",
  "version_mismatch",
  "dependency_conflict",
  "path_traversal",
  "forbidden_path",
  "duplicate_path",
  "before_hash_mismatch",
  "new_file_conflict",
  "edit_not_found",
  "edit_not_unique",
  "after_hash_mismatch",
  "adapter_conflict",
  "io_error",
] as const;
export type InstallerCode = (typeof installerCodes)[number];

export class InstallerError extends Error {
  constructor(public readonly code: InstallerCode) {
    super(code);
    this.name = "InstallerError";
  }
}

const sha256Regex = /^[0-9a-f]{64}$/;
const editSchema = z.object({ oldText: z.string().min(1), newText: z.string() }).strict();
const fileSchema = z
  .object({
    path: z.string().min(1),
    beforeSha256: z.string().regex(sha256Regex).nullable(),
    afterSha256: z.string().regex(sha256Regex),
    edits: z.array(editSchema).optional(),
    content: z.string().optional(),
  })
  .strict();
export const manifestSchema = z
  .object({
    version: z.literal(1),
    librechatVersion: z.string().min(1),
    frameworkVersion: z.string().min(1),
    files: z.array(fileSchema).min(1),
  })
  .strict();
export type ManifestFile = z.infer<typeof fileSchema>;
export type PatchManifest = z.infer<typeof manifestSchema>;

export const ADAPTER_LINK_REL = "node_modules/@vectorize-io/hindsight-librechat";
const RUNTIME_PATCH_PATHS = new Set([
  "api/server/controllers/agents/client.js",
  "api/server/controllers/agents/request.js",
  "api/server/controllers/agents/resume.js",
  "api/server/controllers/agents/v1.js",
  "api/server/index.js",
  "api/server/routes/hindsight.js",
  "api/server/services/Config/loadCustomConfig.js",
  "api/server/services/Endpoints/agents/initialize.js",
  "api/server/services/HindsightMemory.js",
]);

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function loadManifest(raw: string): PatchManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InstallerError("manifest_invalid");
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) throw new InstallerError("manifest_invalid");
  return result.data;
}

/** Resolve a manifest path against root; null when rejected. */
export function resolveManifestPath(root: string, rel: string): string | null {
  if (
    rel.length === 0 ||
    rel.includes("\\") ||
    rel.startsWith("/") ||
    rel.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return null;
  }
  if (!RUNTIME_PATCH_PATHS.has(rel)) return null;
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + "/")) return null;
  return abs;
}

export interface FilePlan {
  path: string;
  action: "create" | "patch" | "unchanged";
  target: string;
  mode: number;
  /** Planned final content for create/patch; absent for unchanged. */
  content?: string;
}

export interface PreflightResult {
  ok: boolean;
  code: InstallerCode;
  plans: FilePlan[];
  counts: { create: number; patch: number; unchanged: number };
  adapter: "absent" | "ok" | "conflict";
  librechatVersion: string;
  frameworkVersion: string;
}

export interface ApplyResult extends PreflightResult {
  applied: boolean;
  written: string[];
  linkCreated: boolean;
}

function emptyPreflight(code: InstallerCode, manifest: PatchManifest): PreflightResult {
  return {
    ok: false,
    code,
    plans: [],
    counts: { create: 0, patch: 0, unchanged: 0 },
    adapter: "absent",
    librechatVersion: manifest.librechatVersion,
    frameworkVersion: manifest.frameworkVersion,
  };
}

async function readJsonVersion(path: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

async function adapterState(
  root: string,
  packageRoot: string
): Promise<"absent" | "ok" | "conflict"> {
  const link = resolve(root, ADAPTER_LINK_REL);
  let entry;
  try {
    entry = await lstat(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw new InstallerError("io_error");
  }
  if (!entry.isSymbolicLink()) return "conflict";
  const [linkReal, rootReal] = await Promise.all([realpath(link), realpath(packageRoot)]);
  return linkReal === rootReal ? "ok" : "conflict";
}

/** Full read-only preflight: version, dependency, paths, hashes, edits, adapter. */
export async function preflight(
  root: string,
  manifest: PatchManifest,
  packageRoot: string
): Promise<PreflightResult> {
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) return emptyPreflight("root_missing", manifest);

  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (seen.has(file.path)) return emptyPreflight("duplicate_path", manifest);
    seen.add(file.path);
    if (resolveManifestPath(root, file.path) === null) {
      return file.path.includes("..") || file.path.startsWith("/") || file.path.includes("\\")
        ? emptyPreflight("path_traversal", manifest)
        : emptyPreflight("forbidden_path", manifest);
    }
  }
  for (const path of [...seen, dirname(ADAPTER_LINK_REL)]) {
    let component = root;
    for (const segment of path.split("/")) {
      component = join(component, segment);
      const entry = await lstat(component).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw new InstallerError("io_error");
      });
      if (!entry) break;
      if (entry.isSymbolicLink()) return emptyPreflight("path_traversal", manifest);
    }
  }

  const appVersion = await readJsonVersion(join(root, "package.json"));
  if (appVersion !== manifest.librechatVersion) return emptyPreflight("version_mismatch", manifest);
  const frameworkVersion = await readJsonVersion(
    join(root, "node_modules", "@librechat", "agents", "package.json")
  );
  if (frameworkVersion !== manifest.frameworkVersion) {
    return emptyPreflight("dependency_conflict", manifest);
  }

  const plans: FilePlan[] = [];
  const counts = { create: 0, patch: 0, unchanged: 0 };
  for (const file of manifest.files) {
    const abs = resolveManifestPath(root, file.path) as string;
    const rel = relative(root, abs);
    let current: Buffer | null = null;
    let mode = 0o644;
    try {
      const s = await stat(abs);
      if (!s.isFile()) return emptyPreflight("before_hash_mismatch", manifest);
      mode = s.mode & 0o777;
      current = await readFile(abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new InstallerError("io_error");
    }
    const currentHash = current ? sha256Hex(current) : null;

    if (file.beforeSha256 === null) {
      if (current !== null) {
        if (currentHash === file.afterSha256) {
          plans.push({ path: rel, action: "unchanged", target: abs, mode });
          counts.unchanged += 1;
        } else {
          return emptyPreflight("new_file_conflict", manifest);
        }
      } else {
        if (typeof file.content !== "string") return emptyPreflight("manifest_invalid", manifest);
        if (sha256Hex(file.content) !== file.afterSha256) {
          return emptyPreflight("after_hash_mismatch", manifest);
        }
        plans.push({
          path: rel,
          action: "create",
          target: abs,
          mode: 0o644,
          content: file.content,
        });
        counts.create += 1;
      }
      continue;
    }

    if (current === null || currentHash !== file.beforeSha256) {
      if (currentHash === file.afterSha256) {
        plans.push({ path: rel, action: "unchanged", target: abs, mode });
        counts.unchanged += 1;
      } else {
        return emptyPreflight("before_hash_mismatch", manifest);
      }
      continue;
    }
    let text = current.toString("utf8");
    for (const edit of file.edits ?? []) {
      const first = text.indexOf(edit.oldText);
      if (first === -1) return emptyPreflight("edit_not_found", manifest);
      if (text.indexOf(edit.oldText, first + 1) !== -1) {
        return emptyPreflight("edit_not_unique", manifest);
      }
      text = text.slice(0, first) + edit.newText + text.slice(first + edit.oldText.length);
    }
    if (sha256Hex(text) !== file.afterSha256)
      return emptyPreflight("after_hash_mismatch", manifest);
    plans.push({ path: rel, action: "patch", target: abs, mode, content: text });
    counts.patch += 1;
  }

  const adapter = await adapterState(root, packageRoot);
  if (adapter === "conflict") return { ...emptyPreflight("adapter_conflict", manifest), adapter };

  return {
    ok: true,
    code: "ok",
    plans,
    counts,
    adapter,
    librechatVersion: manifest.librechatVersion,
    frameworkVersion: manifest.frameworkVersion,
  };
}

async function atomicWrite(target: string, data: string, mode: number): Promise<void> {
  const dir = dirname(target);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  try {
    const file = await open(tmp, "wx", mode);
    try {
      await file.chmod(mode);
      await file.writeFile(data, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, target);
    const parent = await open(dir, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(tmp).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

async function ensureAdapterLink(root: string, packageRoot: string): Promise<boolean> {
  const link = resolve(root, ADAPTER_LINK_REL);
  let entry;
  try {
    entry = await lstat(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new InstallerError("io_error");
  }
  if (entry) {
    if (!entry.isSymbolicLink()) throw new InstallerError("adapter_conflict");
    const [linkReal, rootReal] = await Promise.all([realpath(link), realpath(packageRoot)]);
    if (linkReal !== rootReal) throw new InstallerError("adapter_conflict");
    return false;
  }
  await mkdir(dirname(link), { recursive: true, mode: 0o755 });
  await symlink(packageRoot, link, "dir");
  return true;
}

/** Preflight everything, then write only what changed. Idempotent. */
export async function apply(
  root: string,
  manifest: PatchManifest,
  packageRoot: string
): Promise<ApplyResult> {
  const pre = await preflight(root, manifest, packageRoot);
  if (!pre.ok) return { ...pre, applied: false, written: [], linkCreated: false };

  const written: string[] = [];
  for (const plan of pre.plans) {
    if (plan.action === "unchanged" || plan.content === undefined) continue;
    await atomicWrite(plan.target, plan.content, plan.mode);
    written.push(plan.path);
  }
  const linkCreated = await ensureAdapterLink(root, packageRoot);
  return { ...pre, applied: written.length > 0 || linkCreated, written, linkCreated };
}
