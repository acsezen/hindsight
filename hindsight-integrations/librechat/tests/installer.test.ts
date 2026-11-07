import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apply, loadManifest, preflight, sha256Hex } from "../src/installer.js";
import type { PatchManifest } from "../src/installer.js";

const CLIENT_PATH = "api/server/controllers/agents/client.js";
const SERVICE_PATH = "api/server/services/HindsightMemory.js";
const CLIENT_BEFORE = "const a = 1;\nmodule.exports = { a };\n";
const CLIENT_AFTER =
  "const a = 1;\nconst hindsightMemory = require('~/server/services/HindsightMemory');\nmodule.exports = { a };\n";
const SERVICE_CONTENT = "module.exports = {};\n";

let root: string;
let packageRoot: string;

function hash(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function makeManifest(overrides?: Partial<PatchManifest>): PatchManifest {
  const manifest: PatchManifest = {
    version: 1,
    librechatVersion: "v0.8.8",
    frameworkVersion: "4.0.1",
    files: [
      {
        path: CLIENT_PATH,
        beforeSha256: hash(CLIENT_BEFORE),
        afterSha256: hash(CLIENT_AFTER),
        edits: [
          {
            oldText: "const a = 1;\n",
            newText:
              "const a = 1;\nconst hindsightMemory = require('~/server/services/HindsightMemory');\n",
          },
        ],
      },
      {
        path: SERVICE_PATH,
        beforeSha256: null,
        afterSha256: hash(SERVICE_CONTENT),
        content: SERVICE_CONTENT,
      },
    ],
    ...overrides,
  };
  return manifest;
}

async function makeFixture(): Promise<void> {
  await mkdir(join(root, "api/server/controllers/agents"), { recursive: true });
  await mkdir(join(root, "node_modules/@librechat/agents"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "librechat", version: "v0.8.8" })
  );
  await writeFile(
    join(root, "node_modules/@librechat/agents/package.json"),
    JSON.stringify({ name: "@librechat/agents", version: "4.0.1" })
  );
  await writeFile(join(root, CLIENT_PATH), CLIENT_BEFORE);
}

async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.set(full, hash(await readFile(full)));
      else out.set(full, `link:${entry.name}`);
    }
  }
  await walk(dir);
  return out;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lc-installer-root-"));
  packageRoot = await mkdtemp(join(tmpdir(), "lc-installer-pkg-"));
  await makeFixture();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(packageRoot, { recursive: true, force: true });
});

describe("installer", () => {
  it("parses and validates a manifest", () => {
    const manifest = loadManifest(JSON.stringify(makeManifest()));
    expect(manifest.librechatVersion).toBe("v0.8.8");
    expect(() => loadManifest("not json")).toThrowError(/manifest_invalid/);
    expect(() => loadManifest(JSON.stringify({ version: 2, files: [] }))).toThrowError(
      /manifest_invalid/
    );
  });

  it("check mode reports plans and writes nothing", async () => {
    const before = await snapshot(root);
    const result = await preflight(root, makeManifest(), packageRoot);
    expect(result.ok).toBe(true);
    expect(result.code).toBe("ok");
    expect(result.counts).toEqual({ create: 1, patch: 1, unchanged: 0 });
    expect(result.adapter).toBe("absent");
    expect(await snapshot(root)).toEqual(before);
  });

  it("apply writes edits and new file, creates adapter symlink, mode 0644 on new file", async () => {
    const result = await apply(root, makeManifest(), packageRoot);
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.written.sort()).toEqual([CLIENT_PATH, SERVICE_PATH].sort());
    expect(await readFile(join(root, CLIENT_PATH), "utf8")).toBe(CLIENT_AFTER);
    expect(await readFile(join(root, SERVICE_PATH), "utf8")).toBe(SERVICE_CONTENT);
    const mode = (await stat(join(root, SERVICE_PATH))).mode & 0o777;
    expect(mode).toBe(0o644);
    const link = join(root, "node_modules/@vectorize-io/hindsight-librechat");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await realpath(link)).toBe(await realpath(packageRoot));
  });

  it("installs the dependency where LibreChat's server module resolver can find it", async () => {
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "@vectorize-io/hindsight-librechat", main: "index.cjs" })
    );
    await writeFile(join(packageRoot, "index.cjs"), "module.exports = {};\n");
    await apply(root, makeManifest(), packageRoot);
    const fromServer = createRequire(join(root, SERVICE_PATH));
    expect(fromServer.resolve("@vectorize-io/hindsight-librechat")).toBe(
      join(packageRoot, "index.cjs")
    );
  });

  it("apply is idempotent: second run writes nothing", async () => {
    await apply(root, makeManifest(), packageRoot);
    const before = await snapshot(root);
    const second = await apply(root, makeManifest(), packageRoot);
    expect(second.ok).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.written).toEqual([]);
    expect(second.counts).toEqual({ create: 0, patch: 0, unchanged: 2 });
    expect(second.adapter).toBe("ok");
    expect(await snapshot(root)).toEqual(before);
  });

  it("unknown source hash fails before any write", async () => {
    await writeFile(join(root, CLIENT_PATH), "tampered\n");
    const before = await snapshot(root);
    const result = await apply(root, makeManifest(), packageRoot);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("before_hash_mismatch");
    expect(result.written).toEqual([]);
    expect(await snapshot(root)).toEqual(before);
  });

  it("librechat version mismatch fails before any write", async () => {
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "v0.8.9" }));
    const before = await snapshot(root);
    const result = await apply(root, makeManifest(), packageRoot);
    expect(result.code).toBe("version_mismatch");
    expect(result.written).toEqual([]);
    expect(await snapshot(root)).toEqual(before);
  });

  it("framework dependency conflict fails before any write", async () => {
    await writeFile(
      join(root, "node_modules/@librechat/agents/package.json"),
      JSON.stringify({ version: "4.2.1" })
    );
    const before = await snapshot(root);
    const result = await apply(root, makeManifest(), packageRoot);
    expect(result.code).toBe("dependency_conflict");
    expect(result.written).toEqual([]);
    expect(await snapshot(root)).toEqual(before);
  });

  it("rejects symlinked source directories without writing outside the root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "lc-installer-outside-"));
    try {
      await rename(join(root, "api"), join(outside, "api"));
      await symlink(join(outside, "api"), join(root, "api"), "dir");
      const before = await snapshot(outside);
      expect((await apply(root, makeManifest(), packageRoot)).code).toBe("path_traversal");
      expect(await snapshot(outside)).toEqual(before);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked dependency directory before changing application code", async () => {
    const outside = await mkdtemp(join(tmpdir(), "lc-installer-modules-"));
    try {
      await rename(join(root, "node_modules"), join(outside, "node_modules"));
      await symlink(join(outside, "node_modules"), join(root, "node_modules"), "dir");
      const before = await snapshot(root);
      expect((await apply(root, makeManifest(), packageRoot)).code).toBe("path_traversal");
      expect(await snapshot(root)).toEqual(before);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects path traversal in manifest paths", async () => {
    const manifest = makeManifest();
    manifest.files[0] = { ...manifest.files[0], path: "../evil.js" };
    const result = await apply(root, manifest, packageRoot);
    expect(result.code).toBe("path_traversal");
    expect(result.written).toEqual([]);
  });

  it("rejects forbidden paths (librechat.yaml, .env, node_modules)", async () => {
    for (const path of [
      "librechat.yaml",
      ".env",
      "api/.env",
      "node_modules/foo/package.json",
      "packages/data-provider/dist/index.js",
    ]) {
      const manifest = makeManifest();
      manifest.files = [{ path, beforeSha256: null, afterSha256: hash("x"), content: "x" }];
      const result = await apply(root, manifest, packageRoot);
      expect(result.ok).toBe(false);
      expect(["forbidden_path"]).toContain(result.code);
    }
  });

  it("refuses to replace an existing different adapter installation", async () => {
    const other = await mkdtemp(join(tmpdir(), "lc-installer-other-"));
    try {
      const linkDir = join(root, "node_modules/@vectorize-io");
      await mkdir(linkDir, { recursive: true });
      await symlink(other, join(linkDir, "hindsight-librechat"), "dir");
      const before = await snapshot(root);
      const result = await apply(root, makeManifest(), packageRoot);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("adapter_conflict");
      expect(result.written).toEqual([]);
      expect(await snapshot(root)).toEqual(before);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("rejects non-unique and missing edit anchors", async () => {
    const dup = makeManifest();
    dup.files[0].edits = [{ oldText: "a", newText: "b" }]; // "a" appears twice
    dup.files[0].afterSha256 = hash("whatever");
    expect((await preflight(root, dup, packageRoot)).code).toBe("edit_not_unique");

    const missing = makeManifest();
    missing.files[0].edits = [{ oldText: "not present", newText: "b" }];
    expect((await preflight(root, missing, packageRoot)).code).toBe("edit_not_found");
  });

  it("detects tampered planned content via after-hash mismatch", async () => {
    const manifest = makeManifest();
    manifest.files[0].afterSha256 = hash("different than edits produce");
    expect((await preflight(root, manifest, packageRoot)).code).toBe("after_hash_mismatch");
  });
});
