/**
 * Independent acceptance contract for moritzbrantner/asset-tooling#206
 * ("Reuse verified operation results when the operation build identity is unchanged").
 *
 * Written by a separate acceptance context before any implementation exists.
 *
 * API contract targeted (exported from `asset-tooling/operations/store`, i.e. src/asset-store.ts):
 *
 *   runAssetOperation(
 *     root: string,
 *     registration: {
 *       descriptor: AssetOperationDescriptor | ReadonlyAssetOperationDescriptor;
 *       // Implementation/tool identity, exactly what createAssetOperationBuildIdentity takes
 *       // as `implementation` (required `id` + `version`, plus any output-affecting identity
 *       // such as `tool`, `algorithm`, `reproducibility`).
 *       implementation: { id: string; version: string; [key: string]: CanonicalJsonValue };
 *       // The existing executor shape used by every asset operation.
 *       execute(root: string, invocation: { parameters: object; inputs: AssetPortMap }):
 *         Promise<AssetOperationResult>;
 *     },
 *     invocation: { parameters?: object; inputs?: AssetPortMap },
 *   ): Promise<{
 *     status: "hit" | "miss";
 *     cacheKey: string;                       // === createAssetOperationCacheKey({ operation, implementation, parameters, inputs })
 *     buildIdentity: AssetOperationBuildIdentity; // === createAssetOperationBuildIdentity(same)
 *     result: AssetOperationResult;           // normalized (normalizeAssetOperationResult)
 *   }>
 *
 * Semantics pinned here:
 *   - every input object is verified in the store before lookup or execution;
 *   - a hit verifies every recorded output object and never calls `execute`;
 *   - a corrupt/missing entry or output object never yields a hit: the runner either
 *     re-executes (status "miss") or rejects, and never returns an AssetRef to bad bytes;
 *   - entries live under `<root>/.asset-tooling/cache` (disposable), not in the object store;
 *   - recorded observations (e.g. reproducibility "approximate") are returned unchanged on a hit.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as assetStore from "../src/asset-store.js";
import {
  assetObjectPortablePath,
  createAssetRefFromBytes,
  resolveAssetObject,
  storeAssetObject,
  verifyAssetObject,
} from "../src/asset-store.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationCacheKey,
} from "../src/operations.js";
import {
  AUDIO_ADSR_OPERATION,
  AUDIO_OSCILLATOR_OPERATION,
  createAudioAdsrOperationBuildIdentity,
  createAudioOscillatorOperationBuildIdentity,
  executeAudioAdsrOperation,
  executeAudioOscillatorOperation,
} from "../src/audio-procedural-operations.js";
import {
  AUDIO_MODEL_GENERATE_OPERATION,
  createAudioModelGenerateOperationBuildIdentity,
  createAudioModelGenerateOperationExecutor,
} from "../src/audio-model-operations.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runner() {
  const run = (assetStore as Record<string, unknown>).runAssetOperation;
  assert.equal(
    typeof run,
    "function",
    "asset-tooling/operations/store (src/asset-store.ts) must export runAssetOperation (#206)",
  );
  return run as (root: string, registration: any, invocation: any) => Promise<any>;
}

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), "asset-tooling-operation-result-cache-"));
}

async function listFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full);
  }
  return files.sort();
}

function counting(execute: (root: string, invocation: any) => Promise<any>) {
  const spy = {
    calls: 0,
    async execute(root: string, invocation: any) {
      spy.calls += 1;
      return execute(root, invocation);
    },
  };
  return spy;
}

function outputRefs(result: any): any[] {
  return Object.values(result.outputs).flatMap((value) => (Array.isArray(value) ? value : [value]));
}

async function assertOutputsVerified(root: string, result: any) {
  for (const ref of outputRefs(result)) await verifyAssetObject(root, ref);
}

const oscillatorParameters = {
  waveform: "sine",
  sampleRate: 8000,
  channels: 1,
  frameCount: 16,
  frequencyHz: 750,
  amplitude: 12000,
};

const adsrParameters = { attackFrames: 3, decayFrames: 3, sustainLevelQ15: 20000, releaseFrames: 4 };

async function oscillatorRegistration(root: string, overrides: Record<string, unknown> = {}) {
  const build = await createAudioOscillatorOperationBuildIdentity(root, { parameters: oscillatorParameters });
  const spy = counting(executeAudioOscillatorOperation);
  return {
    spy,
    registration: {
      descriptor: AUDIO_OSCILLATOR_OPERATION,
      implementation: { ...build.implementation, ...overrides },
      execute: spy.execute,
    },
  };
}

async function storedSource(root: string, frequencyHz = 750) {
  const result = await executeAudioOscillatorOperation(root, {
    parameters: { ...oscillatorParameters, frequencyHz },
    inputs: {},
  });
  return result.outputs.output;
}

async function adsrRegistration(root: string, source: any) {
  const build = await createAudioAdsrOperationBuildIdentity(root, {
    parameters: adsrParameters,
    inputs: { source },
  });
  const spy = counting(executeAudioAdsrOperation);
  return {
    spy,
    registration: { descriptor: AUDIO_ADSR_OPERATION, implementation: build.implementation, execute: spy.execute },
  };
}

async function tamperFile(filePath: string) {
  const bytes = await readFile(filePath);
  assert.ok(bytes.length > 0);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
  await writeFile(filePath, bytes);
}

/** Outcome of a run against corrupted state: must be a rejection or a verified re-execution. */
async function assertNeverUnverifiedHit(
  root: string,
  promise: Promise<any>,
  spy: { calls: number },
  callsBefore: number,
  expectedOutputSha256: string,
) {
  let outcome;
  try {
    outcome = await promise;
  } catch (error) {
    assert.ok(error instanceof Error, "a fail-closed rejection must be an Error with a message");
    assert.ok(error.message.length > 0);
    return "rejected";
  }
  assert.equal(outcome.status, "miss", "corrupt cache state must never be reported as a hit");
  assert.equal(spy.calls, callsBefore + 1, "a non-hit must re-execute the operation");
  await assertOutputsVerified(root, outcome.result);
  assert.equal(outcome.result.outputs.output.sha256, expectedOutputSha256);
  return "re-executed";
}

test("runAssetOperation is exported from asset-tooling/operations/store", async () => {
  runner();
  const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.exports["./operations/store"], "./src/asset-store.ts");
});

test("same invocation twice: miss executes once, hit reuses identical verified outputs", async () => {
  const run = runner();
  const root = await workspace();
  try {
    const { spy, registration } = await oscillatorRegistration(root);
    const invocation = { parameters: oscillatorParameters, inputs: {} };

    const first = await run(root, registration, invocation);
    assert.equal(first.status, "miss");
    assert.equal(spy.calls, 1);

    const second = await run(root, registration, invocation);
    assert.equal(second.status, "hit");
    assert.equal(spy.calls, 1, "a hit must not invoke the executor");
    assert.deepEqual(second.result.outputs, first.result.outputs);
    assert.deepEqual(second.result.observations, first.result.observations);
    assert.equal(second.cacheKey, first.cacheKey);
    assert.deepEqual(second.buildIdentity, first.buildIdentity);
    await assertOutputsVerified(root, second.result);
    assert.deepEqual(
      await resolveAssetObject(root, second.result.outputs.output),
      await resolveAssetObject(root, first.result.outputs.output),
    );

    // Reuses the existing identity scheme rather than a second one.
    const identityInput = {
      operation: AUDIO_OSCILLATOR_OPERATION,
      implementation: registration.implementation,
      parameters: oscillatorParameters,
      inputs: {},
    };
    assert.deepEqual(first.buildIdentity, createAssetOperationBuildIdentity(identityInput));
    assert.equal(first.cacheKey, createAssetOperationCacheKey(identityInput));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changed parameter or input changes the cache key and misses; unrelated entries stay hit", async () => {
  const run = runner();
  const root = await workspace();
  try {
    const { spy, registration } = await oscillatorRegistration(root);
    const base = { parameters: oscillatorParameters, inputs: {} };
    const changed = { parameters: { ...oscillatorParameters, amplitude: 9000 }, inputs: {} };

    const a = await run(root, registration, base);
    const b = await run(root, registration, changed);
    assert.equal(a.status, "miss");
    assert.equal(b.status, "miss");
    assert.notEqual(b.cacheKey, a.cacheKey);
    assert.notEqual(b.result.outputs.output.sha256, a.result.outputs.output.sha256);
    assert.equal(spy.calls, 2);
    assert.equal((await run(root, registration, base)).status, "hit");
    assert.equal((await run(root, registration, changed)).status, "hit");
    assert.equal(spy.calls, 2);

    // Changed input object.
    const firstSource = await storedSource(root, 750);
    const secondSource = await storedSource(root, 500);
    const adsr = await adsrRegistration(root, firstSource);
    const x = await run(root, adsr.registration, { parameters: adsrParameters, inputs: { source: firstSource } });
    const y = await run(root, adsr.registration, { parameters: adsrParameters, inputs: { source: secondSource } });
    assert.equal(x.status, "miss");
    assert.equal(y.status, "miss");
    assert.notEqual(y.cacheKey, x.cacheKey);
    assert.equal(adsr.spy.calls, 2);
    assert.equal(
      (await run(root, adsr.registration, { parameters: adsrParameters, inputs: { source: firstSource } })).status,
      "hit",
    );
    assert.equal(adsr.spy.calls, 2);
    // The oscillator entries are still unaffected.
    assert.equal((await run(root, registration, base)).status, "hit");
    assert.equal(spy.calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changed implementation or tool fingerprint misses", async () => {
  const run = runner();
  const root = await workspace();
  try {
    const original = await oscillatorRegistration(root);
    const invocation = { parameters: oscillatorParameters, inputs: {} };
    const first = await run(root, original.registration, invocation);
    assert.equal(first.status, "miss");

    const bumped = await oscillatorRegistration(root, { version: "2" });
    const second = await run(root, bumped.registration, invocation);
    assert.equal(second.status, "miss");
    assert.notEqual(second.cacheKey, first.cacheKey);
    assert.equal(bumped.spy.calls, 1);

    const tool = original.registration.implementation.tool;
    assert.ok(tool && typeof tool === "object", "oscillator implementation identity carries a tool fingerprint");
    const retooled = await oscillatorRegistration(root, {
      tool: { ...tool, acceptanceFingerprintOverride: "different-tool-source" },
    });
    const third = await run(root, retooled.registration, invocation);
    assert.equal(third.status, "miss");
    assert.notEqual(third.cacheKey, first.cacheKey);
    assert.equal(retooled.spy.calls, 1);

    // The original implementation's entry remains valid.
    assert.equal((await run(root, original.registration, invocation)).status, "hit");
    assert.equal(original.spy.calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a tampered output object never yields a hit or unverified bytes", async () => {
  const run = runner();
  const root = await workspace();
  try {
    const { spy, registration } = await oscillatorRegistration(root);
    const invocation = { parameters: oscillatorParameters, inputs: {} };
    const first = await run(root, registration, invocation);
    const output = first.result.outputs.output;
    await tamperFile(path.join(root, assetObjectPortablePath(output)));
    await assertNeverUnverifiedHit(root, run(root, registration, invocation), spy, 1, output.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a deleted output object never yields a hit", async () => {
  const run = runner();
  const root = await workspace();
  try {
    const { spy, registration } = await oscillatorRegistration(root);
    const invocation = { parameters: oscillatorParameters, inputs: {} };
    const first = await run(root, registration, invocation);
    const output = first.result.outputs.output;
    await rm(path.join(root, assetObjectPortablePath(output)));
    await assertNeverUnverifiedHit(root, run(root, registration, invocation), spy, 1, output.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [label, mutate] of [
  ["non-JSON bytes", async (file: string) => writeFile(file, "{ this is not json")],
  ["flipped trailing byte", tamperFile],
  [
    "recorded output sha256 redirected to an absent object",
    async (file: string, outputSha256: string) => {
      const text = await readFile(file, "utf8");
      await writeFile(file, text.split(outputSha256).join("0".repeat(64)));
    },
  ],
  [
    "recorded output byteLength altered",
    async (file: string) => {
      const text = await readFile(file, "utf8");
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        await tamperFile(file);
        return;
      }
      const visit = (value: any) => {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") {
          if (typeof value.byteLength === "number" && typeof value.sha256 === "string") value.byteLength += 1;
          Object.values(value).forEach(visit);
        }
      };
      visit(parsed);
      await writeFile(file, JSON.stringify(parsed));
    },
  ],
] as const) {
  test(`a tampered cache index entry (${label}) never yields a hit`, async () => {
    const run = runner();
    const root = await workspace();
    try {
      const { spy, registration } = await oscillatorRegistration(root);
      const invocation = { parameters: oscillatorParameters, inputs: {} };
      const first = await run(root, registration, invocation);
      const outputSha256 = first.result.outputs.output.sha256;
      const cacheFiles = await listFiles(path.join(root, ".asset-tooling", "cache"));
      const entries = [];
      for (const file of cacheFiles) {
        if ((await readFile(file, "utf8")).includes(outputSha256)) entries.push(file);
      }
      assert.ok(entries.length > 0, "the cache index entry must record the output AssetRef sha256");
      for (const file of entries) await mutate(file, outputSha256);
      await assertNeverUnverifiedHit(root, run(root, registration, invocation), spy, 1, outputSha256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("a missing or tampered input fails before lookup and before execution", async () => {
  const run = runner();
  const root = await workspace();
  try {
    // Never-stored input: no execution.
    const source = await storedSource(root);
    const { spy, registration } = await adsrRegistration(root, source);
    const absent = createAssetRefFromBytes(Buffer.from("never stored"), {
      kind: "audio",
      mediaType: "audio/wav",
      metadata: source.metadata,
    });
    await assert.rejects(run(root, registration, { parameters: adsrParameters, inputs: { source: absent } }));
    assert.equal(spy.calls, 0);

    // A would-be hit whose input was tampered or deleted afterwards must still fail.
    const invocation = { parameters: adsrParameters, inputs: { source } };
    assert.equal((await run(root, registration, invocation)).status, "miss");
    assert.equal(spy.calls, 1);
    const sourcePath = path.join(root, assetObjectPortablePath(source));
    const original = await readFile(sourcePath);
    await tamperFile(sourcePath);
    await assert.rejects(run(root, registration, invocation));
    assert.equal(spy.calls, 1);
    await rm(sourcePath);
    await assert.rejects(run(root, registration, invocation));
    assert.equal(spy.calls, 1);

    // Restoring the verified input restores the hit.
    await writeFile(sourcePath, original);
    assert.equal((await run(root, registration, invocation)).status, "hit");
    assert.equal(spy.calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approximate-reproducibility results are reused with their label intact, never relabeled exact", async () => {
  const run = runner();
  const root = await workspace();
  try {
    let generateCalls = 0;
    const adapter = {
      id: "fixture.audio-model",
      version: "1",
      reproducibility: "approximate",
      async generate(request: any) {
        generateCalls += 1;
        // Non-deterministic across calls: a re-execution would produce different bytes.
        const samples = new Int16Array(request.frameCount * request.channels);
        for (let index = 0; index < samples.length; index += 1) samples[index] = index * 100 + generateCalls;
        return {
          audio: { sampleRate: request.sampleRate, channels: request.channels, samples },
          observations: { providerMode: "fixture" },
        };
      },
    };
    const model = (
      await storeAssetObject(root, {
        bytes: Buffer.from("fixture-model-bundle-v1"),
        kind: "model",
        mediaType: "application/octet-stream",
        metadata: { format: "fixture-bundle-v1" },
      })
    ).asset;
    const parameters = {
      modelId: "fixture-model",
      modelRevision: "rev-1",
      prompt: "narration line one",
      seed: "42",
      sampleRate: 8000,
      channels: 1,
      frameCount: 6,
    };
    const invocation = { parameters, inputs: { model } };
    const build = await createAudioModelGenerateOperationBuildIdentity(adapter, invocation);
    assert.equal(build.implementation.reproducibility, "approximate");
    const spy = counting(createAudioModelGenerateOperationExecutor(adapter));
    const registration = {
      descriptor: AUDIO_MODEL_GENERATE_OPERATION,
      implementation: build.implementation,
      execute: spy.execute,
    };

    const first = await run(root, registration, invocation);
    const second = await run(root, registration, invocation);
    assert.equal(first.status, "miss");
    assert.equal(second.status, "hit");
    assert.equal(spy.calls, 1);
    assert.equal(generateCalls, 1);
    assert.deepEqual(second.result, first.result);
    assert.equal(second.result.observations.adapter.reproducibility, "approximate");
    assert.equal(second.buildIdentity.implementation.reproducibility, "approximate");
    assert.ok(
      !JSON.stringify(second).includes('"exact"'),
      "a reused approximate result must not be labeled exact anywhere in the run result",
    );
    await assertOutputsVerified(root, second.result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("entries live under the disposable .asset-tooling/cache namespace, not in the object store", async () => {
  const run = runner();
  const root = await workspace();
  try {
    const { registration } = await oscillatorRegistration(root);
    const before = await listFiles(root);
    const first = await run(root, registration, { parameters: oscillatorParameters, inputs: {} });
    const after = await listFiles(root);
    const added = after.filter((file) => !before.includes(file)).map((file) => path.relative(root, file).split(path.sep).join("/"));

    const outputObjects = new Set(outputRefs(first.result).map((ref) => assetObjectPortablePath(ref)));
    const cacheEntries = added.filter((file) => file.startsWith(".asset-tooling/cache/"));
    assert.ok(cacheEntries.length > 0, "the runner must record its entry under .asset-tooling/cache");
    for (const file of added) {
      assert.ok(
        file.startsWith(".asset-tooling/cache/") || outputObjects.has(file),
        `unexpected file '${file}' outside the cache namespace (only output objects may be added to the store)`,
      );
    }

    // Deleting the whole cache namespace is safe: the next run is a verified miss.
    await rm(path.join(root, ".asset-tooling", "cache"), { recursive: true, force: true });
    const again = await run(root, registration, { parameters: oscillatorParameters, inputs: {} });
    assert.equal(again.status, "miss");
    assert.deepEqual(again.result.outputs, first.result.outputs);
    assert.ok((await stat(path.join(root, ".asset-tooling", "cache"))).isDirectory());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Strict consumer type-check of the operations subpaths named in #206.
// Mirrors interactive-videos' tsconfig (strict, Bundler resolution, skipLibCheck,
// allowImportingTsExtensions) and resolves asset-tooling source through `paths`.

const CONSUMER_SUBPATHS: Record<string, string> = {
  "asset-tooling/operations": "src/operations.ts",
  "asset-tooling/operations/store": "src/asset-store.ts",
  "asset-tooling/operations/audio": "src/audio-operations.ts",
  "asset-tooling/operations/audio/procedural": "src/audio-procedural-operations.ts",
};

async function strictConsumerTypecheck(source: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-consumer-tsc-"));
  try {
    const paths = Object.fromEntries(
      Object.entries(CONSUMER_SUBPATHS).map(([specifier, file]) => [specifier, [path.join(REPO_ROOT, file)]]),
    );
    await writeFile(
      path.join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          lib: ["DOM", "DOM.Iterable", "ES2022"],
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
          resolveJsonModule: true,
          typeRoots: [path.join(REPO_ROOT, "node_modules", "@types")],
          types: ["node"],
          paths,
        },
        files: ["consumer.ts"],
      }),
    );
    await writeFile(path.join(directory, "consumer.ts"), source);
    const tsc = path.join(REPO_ROOT, "node_modules", ".bin", "tsc");
    assert.ok(
      (await stat(tsc).catch(() => undefined))?.isFile(),
      "typescript must be installed (bun run typecheck installs it) for the consumer type-check",
    );
    const result = spawnSync(tsc, ["-p", path.join(directory, "tsconfig.json")], { encoding: "utf8" });
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("operations subpaths named in #206 type-check under a strict consumer tsc", { timeout: 120_000 }, async () => {
  const { status, output } = await strictConsumerTypecheck(`
import { createAssetOperationCacheKey, type AssetRef } from "asset-tooling/operations";
import { resolveAssetObject } from "asset-tooling/operations/store";
import { AUDIO_SYNTHESIZE_OPERATION, executeAudioSynthesizeOperation } from "asset-tooling/operations/audio";
import { AUDIO_OSCILLATOR_OPERATION, executeAudioOscillatorOperation } from "asset-tooling/operations/audio/procedural";

export async function consume(root: string): Promise<{ key: string; output: AssetRef; bytes: number }> {
  if (!AUDIO_SYNTHESIZE_OPERATION || !AUDIO_OSCILLATOR_OPERATION) throw new Error("missing descriptor");
  await executeAudioSynthesizeOperation(root, { parameters: {}, inputs: {} });
  const result = await executeAudioOscillatorOperation(root, { parameters: {}, inputs: {} });
  const output = result.outputs.output;
  if (!output || Array.isArray(output)) throw new Error("expected one output");
  const key = createAssetOperationCacheKey({
    operation: AUDIO_OSCILLATOR_OPERATION,
    implementation: { id: "consumer", version: "1" },
  });
  return { key, output, bytes: (await resolveAssetObject(root, output)).length };
}
`);
  assert.equal(status, 0, `strict consumer tsc failed:\n${output}`);
});

test("runAssetOperation is typed for a strict consumer", { timeout: 120_000 }, async () => {
  const { status, output } = await strictConsumerTypecheck(`
import type { AssetOperationBuildIdentity, AssetOperationResult } from "asset-tooling/operations";
import { runAssetOperation } from "asset-tooling/operations/store";
import { AUDIO_OSCILLATOR_OPERATION, executeAudioOscillatorOperation } from "asset-tooling/operations/audio/procedural";

export async function consume(root: string): Promise<AssetOperationResult> {
  if (!AUDIO_OSCILLATOR_OPERATION) throw new Error("missing descriptor");
  const run = await runAssetOperation(
    root,
    {
      descriptor: AUDIO_OSCILLATOR_OPERATION,
      implementation: { id: "builtin.audio.oscillator", version: "1" },
      execute: executeAudioOscillatorOperation,
    },
    { parameters: { waveform: "sine" }, inputs: {} },
  );
  const status: "hit" | "miss" = run.status;
  const cacheKey: string = run.cacheKey;
  const identity: AssetOperationBuildIdentity = run.buildIdentity;
  void status; void cacheKey; void identity;
  // @ts-expect-error status is a closed union
  const wrong: "stale" = run.status;
  void wrong;
  return run.result;
}
`);
  assert.equal(status, 0, `strict consumer tsc failed:\n${output}`);
});
