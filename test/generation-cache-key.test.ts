// #516: the Blender generation-cache key is scoped to the files that determine Blender output, and a build can share
// one cache directory across throwaway workspaces (docs/cache.md).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { getBackend } from "../src/backends.js";
import { BLENDER_SCRIPT_CACHE_SOURCES } from "../src/blender-script-backend.js";
import { generationCacheKey, pruneGenerationCache, readGenerationCache, writeGenerationCache } from "../src/cache.js";
import { GENERATION_CACHE_DIRECTORY_ENV, generateAsset, generationCacheBuildIdentity } from "../src/core.js";
import { sha256Bytes } from "../src/hash.js";
import { captureScopedToolIdentity } from "../src/tool.js";
import { GENERATION_CACHE_DIRECTORY_ENV as SCRIPT_ENV } from "../scripts/generation-cache.ts";
import { sourceClosure } from "../scripts/source-closure.ts";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const BLENDER = getBackend({ id: "external.blender.script", version: "1" });
const COPY = getBackend({ id: "builtin.copy", version: "1" });

function context({ tool = { tree: "a" }, runtime = "1.4.4", blender = "5.2.2" } = {}) {
  return {
    tool,
    generator: { id: "external.blender.script", version: "1", backendKind: "procedural" },
    environment: {
      schemaVersion: 1,
      platform: { os: "linux", arch: "x64" },
      runtime: { name: "bun", version: runtime, executableSha256: sha256Bytes(Buffer.from(runtime)) },
      components: [{ id: "blender", version: blender }],
      sha256: sha256Bytes(Buffer.from(`${runtime}/${blender}`)),
    },
  };
}

const key = async (backend: unknown, spec: string, ctx: ReturnType<typeof context>) =>
  generationCacheKey(await generationCacheBuildIdentity({ sha256: spec }, backend, ctx));

test("the Blender cache sources cover the backend's source closure and the spec schema", () => {
  const closure = sourceClosure(["src/blender-script-backend.ts"], ROOT);
  for (const file of [...closure, "src/schema.ts"]) {
    assert.ok(BLENDER_SCRIPT_CACHE_SOURCES.includes(file), `${file} determines Blender output but is not a cache source`);
  }
  assert.equal(SCRIPT_ENV, GENERATION_CACHE_DIRECTORY_ENV);
});

test("a Blender key ignores unrelated src/** edits and the JavaScript runtime", async () => {
  const spec = "a".repeat(64);
  const base = await key(BLENDER, spec, context());
  assert.equal(await key(BLENDER, spec, context({ tool: { tree: "edited elsewhere" } })), base);
  assert.equal(await key(BLENDER, spec, context({ runtime: "1.5.0" })), base);
  // A recipe or declared input is part of the spec hash; Blender is an environment component.
  assert.notEqual(await key(BLENDER, "b".repeat(64), context()), base);
  assert.notEqual(await key(BLENDER, spec, context({ blender: "5.2.3" })), base);
});

test("other backends keep the whole-tree tool identity and full environment", async () => {
  const spec = "a".repeat(64);
  const base = await key(COPY, spec, context());
  assert.notEqual(await key(COPY, spec, context({ tool: { tree: "edited elsewhere" } })), base);
  assert.notEqual(await key(COPY, spec, context({ runtime: "1.5.0" })), base);
});

test("the scoped tool identity changes with a listed file only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-scoped-tool-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/backend.ts"), "export const a = 1;\n");
  await writeFile(path.join(root, "src/unrelated.ts"), "export const b = 1;\n");
  const files = ["src/backend.ts"];
  const before = await captureScopedToolIdentity(files, root);
  await writeFile(path.join(root, "src/unrelated.ts"), "export const b = 2;\n");
  assert.deepEqual(await captureScopedToolIdentity(files, root), before);
  await writeFile(path.join(root, "src/backend.ts"), "export const a = 2;\n");
  assert.notEqual((await captureScopedToolIdentity(files, root)).sourceFingerprint.sha256, before.sourceFingerprint.sha256);
  await assert.rejects(() => captureScopedToolIdentity(["src/missing.ts"], root), /ENOENT/);
  await assert.rejects(() => captureScopedToolIdentity(["../escape.ts"], root), /package-relative/);
});

async function copyWorkspace(parent: string, name: string) {
  const root = path.join(parent, name);
  await mkdir(path.join(root, "inputs"), { recursive: true });
  const source = Buffer.from("shared cache source\n", "utf8");
  await writeFile(path.join(root, "inputs", "source.txt"), source);
  const spec = {
    schemaVersion: 1, assetId: "test.shared-cache", generator: { id: "builtin.copy", version: "1" }, randomness: { mode: "none" },
    inputs: { source: { path: "inputs/source.txt", sha256: sha256Bytes(source) } }, models: {}, parameters: {},
    output: { path: "output.txt" }, reproducibility: { expected: "exact" },
  };
  await writeFile(path.join(root, "asset.json"), `${JSON.stringify(spec)}\n`);
  return path.join(root, "asset.json");
}

test("a shared cache directory serves the same spec in a fresh workspace", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-shared-cache-"));
  const cacheDirectory = path.join(parent, "cache");
  const first = await generateAsset(await copyWorkspace(parent, "one"), { cacheDirectory });
  const second = await generateAsset(await copyWorkspace(parent, "two"), { cacheDirectory });
  assert.equal(first.cache.status, "miss");
  assert.equal(second.cache.status, "hit");
  assert.equal(second.outputSha256, first.outputSha256);
  assert.deepEqual(await readdir(path.join(cacheDirectory, "v1", "builds")), [`${first.cache.key}.json`]);
  await assert.rejects(readdir(path.join(parent, "two", ".asset-tooling")), /ENOENT/);

  const previous = process.env[GENERATION_CACHE_DIRECTORY_ENV];
  process.env[GENERATION_CACHE_DIRECTORY_ENV] = cacheDirectory;
  try {
    assert.equal((await generateAsset(await copyWorkspace(parent, "three"))).cache.status, "hit");
    process.env[GENERATION_CACHE_DIRECTORY_ENV] = "relative/cache";
    await assert.rejects(() => generateAsset(path.join(parent, "three", "asset.json")), /absolute path/);
  } finally {
    if (previous === undefined) delete process.env[GENERATION_CACHE_DIRECTORY_ENV];
    else process.env[GENERATION_CACHE_DIRECTORY_ENV] = previous;
  }
});

test("pruning keeps the entries the latest build used and their blobs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-prune-"));
  const identity = (spec: string) => ({ schemaVersion: 1 as const, specSha256: spec, tool: {}, generator: { id: "g", version: "1", backendKind: "procedural" as const }, environmentSha256: "e" });
  const old = identity("old"), used = identity("used"), fresh = identity("fresh");
  for (const [entry, text] of [[old, "old"], [used, "used"], [fresh, "fresh"]] as const) {
    await writeGenerationCache(directory, entry, { bytes: Buffer.from(text), observations: {} }, { directory });
  }
  const long = new Date(Date.now() - 3_600_000);
  for (const entry of [old, used]) {
    await utimes(path.join(directory, "v1", "builds", `${generationCacheKey({ ...entry })}.json`), long, long);
  }
  const since = new Date(Date.now() - 60_000);
  assert.equal((await readGenerationCache(directory, used, { directory })).status, "hit");
  const result = await pruneGenerationCache(directory, since);
  assert.equal(result.keptBuilds, 2);
  assert.equal(result.removedBuilds, 1);
  assert.equal(result.removedBlobs, 1);
  assert.deepEqual((await readdir(path.join(directory, "v1", "blobs"))).sort(), [sha256Bytes(Buffer.from("fresh")), sha256Bytes(Buffer.from("used"))].sort());
  assert.equal((await readGenerationCache(directory, old, { directory })).status, "miss");
});
