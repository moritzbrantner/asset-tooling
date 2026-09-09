import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { generationCacheKey } from "../src/cache.js";
import { generateAsset, validateSpec, verifyAsset } from "../src/core.js";
import { sha256Bytes } from "../src/hash.js";

async function makeWorkspace(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-cache-test-"));
  await mkdir(path.join(root, "inputs"), { recursive: true });
  const source = Buffer.from("cacheable deterministic source\n", "utf8");
  await writeFile(path.join(root, "inputs", "source.txt"), source);
  const spec = {
    schemaVersion: 1,
    assetId: "test.cache.copy",
    generator: { id: "builtin.copy", version: "1" },
    randomness: { mode: "none" },
    inputs: {
      source: {
        path: "inputs/source.txt",
        sha256: sha256Bytes(source),
      },
    },
    models: {},
    parameters: {},
    output: { path: ".asset-tooling/output.txt" },
    reproducibility: { expected: "exact" },
    ...overrides,
  };
  const specPath = path.join(root, "asset.json");
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  return { root, source, specPath };
}

function cachePaths(root, result) {
  return {
    index: path.join(root, ".asset-tooling", "cache", "v1", "builds", `${result.cache.key}.json`),
    blob: path.join(root, ".asset-tooling", "cache", "v1", "blobs", result.outputSha256),
  };
}

test("generation stores content-addressed bytes and reuses a verified build identity", async () => {
  const { root, source, specPath } = await makeWorkspace();
  const first = await generateAsset(specPath);
  const second = await generateAsset(specPath);

  assert.equal(first.cache.status, "miss");
  assert.equal(second.cache.status, "hit");
  assert.equal(second.cache.key, first.cache.key);
  assert.equal(second.status, "unchanged");
  assert.equal(second.outputChanged, false);
  assert.equal(second.receiptChanged, false);

  const paths = cachePaths(root, first);
  const index = JSON.parse(await readFile(paths.index, "utf8"));
  assert.equal(index.key, first.cache.key);
  assert.equal(index.outputSha256, first.outputSha256);
  assert.equal(sha256Bytes(await readFile(paths.blob)), first.outputSha256);
  assert.deepEqual(await readFile(path.join(root, ".asset-tooling", "output.txt")), source);
});

test("cache reuse never bypasses declared input verification", async () => {
  const { root, specPath } = await makeWorkspace();
  await generateAsset(specPath);
  await writeFile(path.join(root, "inputs", "source.txt"), "changed after cache fill\n");

  await assert.rejects(() => generateAsset(specPath), /input 'source' hash mismatch/);
});

test("missing declared dependencies fail closed before cache lookup or mutation", async () => {
  const { root, specPath } = await makeWorkspace();
  await generateAsset(specPath);
  const outputBefore = await readFile(path.join(root, ".asset-tooling", "output.txt"));
  await unlink(path.join(root, "inputs", "source.txt"));

  await assert.rejects(
    () => generateAsset(specPath),
    /input 'source' is missing at 'inputs\/source\.txt'/,
  );
  assert.deepEqual(await readFile(path.join(root, ".asset-tooling", "output.txt")), outputBefore);
});

test("corrupted cached content fails closed before accepted output mutation", async () => {
  const { root, specPath } = await makeWorkspace();
  const generated = await generateAsset(specPath);
  const outputPath = path.join(root, ".asset-tooling", "output.txt");
  const outputBefore = await readFile(outputPath);
  await writeFile(cachePaths(root, generated).blob, "corrupted cache blob\n");

  await assert.rejects(() => generateAsset(specPath), /generation cache blob hash mismatch/);
  assert.deepEqual(await readFile(outputPath), outputBefore);
});

test("malformed cache index fails closed instead of silently regenerating", async () => {
  const { root, specPath } = await makeWorkspace();
  const generated = await generateAsset(specPath);
  const outputPath = path.join(root, ".asset-tooling", "output.txt");
  const outputBefore = await readFile(outputPath);
  await writeFile(cachePaths(root, generated).index, "{not-json\n");

  await assert.rejects(() => generateAsset(specPath), /generation cache index .* is not valid JSON/);
  assert.deepEqual(await readFile(outputPath), outputBefore);
});

test("verification replays the backend and does not trust cached bytes", async () => {
  const { root, specPath } = await makeWorkspace();
  const generated = await generateAsset(specPath);
  await writeFile(cachePaths(root, generated).blob, "cache is intentionally broken\n");

  const report = await verifyAsset(specPath);
  assert.equal(report.status, "exact");
  assert.equal(report.checks.regeneratedOutputMatchesReceipt, true);
});

test("cache keys change when spec, tool, or environment identity changes", () => {
  const base = {
    schemaVersion: 1,
    specSha256: "a".repeat(64),
    tool: {
      name: "asset-tooling",
      version: "0.1.0",
      sourceFingerprint: { algorithm: "sha256-tree-v1", sha256: "b".repeat(64) },
    },
    generator: { id: "builtin.copy", version: "1", kind: "utility" },
    environmentSha256: "c".repeat(64),
  };
  const key = generationCacheKey(base);

  assert.notEqual(generationCacheKey({ ...base, specSha256: "d".repeat(64) }), key);
  assert.notEqual(
    generationCacheKey({ ...base, tool: { ...base.tool, version: "0.1.1" } }),
    key,
  );
  assert.notEqual(generationCacheKey({ ...base, environmentSha256: "e".repeat(64) }), key);
});

test("asset contracts cannot claim the internal cache namespace", async () => {
  const { specPath } = await makeWorkspace({
    output: { path: ".asset-tooling/cache/v1/blobs/not-an-output" },
  });
  await assert.rejects(() => validateSpec(specPath), /reserved asset-tooling cache path/);
});

test("cache storage refuses symbolic-link escapes", async () => {
  if (process.platform === "win32") return;
  const { root, specPath } = await makeWorkspace();
  await mkdir(path.join(root, ".asset-tooling"), { recursive: true });
  await symlink(path.join(root, "inputs"), path.join(root, ".asset-tooling", "cache"));

  await assert.rejects(() => generateAsset(specPath), /generation cache path .* must not contain symbolic links/);
  await assert.rejects(() => readFile(path.join(root, ".asset-tooling", "output.txt")), /ENOENT/);
});
