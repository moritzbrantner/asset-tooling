/**
 * Independent acceptance contract for moritzbrantner/asset-tooling#208
 * ("audio.model.generate: output-derived frame count and runtime environment identity").
 *
 * Written by a separate acceptance context before any implementation exists. Spec sources:
 * the #208 issue body and the 2026-10-16 concrete speech-adapter preflight comment on #30.
 *
 * API contract targeted (all exported from `asset-tooling/operations/audio/model`,
 * i.e. src/audio-model-operations.ts, next to the unchanged v1 exports):
 *
 *   AUDIO_MODEL_GENERATE_V2_OPERATION
 *     Frozen descriptor `audio.model.generate@2`. Same inputs/outputs as @1. Parameter schema
 *     is @1's with `frameCount` removed from `required` (still a declared property).
 *
 *   createAudioModelGenerateV2OperationBuildIdentity(adapter, { parameters, inputs })
 *     -> Promise<AssetOperationBuildIdentity>
 *   createAudioModelGenerateV2OperationExecutor(adapter)
 *     -> (root, { parameters, inputs }, context?) => Promise<AssetOperationResult>
 *
 *   Separate v2 functions (not a `version` option on the v1 factories), mirroring the existing
 *   `create<Operation>OperationBuildIdentity` / `create<Operation>OperationExecutor` naming and
 *   keeping every v1 signature and behaviour untouched.
 *
 * v2 adapter shape: `{ id, version, reproducibility, generate, environmentComponents? }`.
 *   - `environmentComponents` is optional. When present it must be a function returning (or
 *     resolving to) an array of canonical JSON values. The v2 build identity then carries
 *     `implementation.environment` equal to `await captureEnvironment(components)` (the same
 *     field name and capture as TripoSR, src/triposr-operation.ts).
 *   - Any other extra adapter key is still rejected (`unknown field '<key>'`).
 *   - The v1 factories keep their closed adapter shape: an adapter that declares
 *     `environmentComponents` is rejected by v1 rather than having its runtime silently
 *     ignored in a v1 identity.
 *
 * v2 frame count semantics:
 *   - `frameCount` absent: the adapter request carries `frameCount: undefined`; the adapter's
 *     valid output length N is accepted and recorded as `metadata.audio.frameCount`,
 *     `metadata.audio.duration` and `observations.frameCount`. The canonical build identity
 *     parameters contain no `frameCount` key.
 *   - `frameCount` present: enforced exactly, as in v1.
 *   - `sampleRate` and `channels` are always enforced.
 *   - Output provenance records `{ id: "audio.model.generate", version: "2" }`.
 *
 * Gaps not covered here: the optional "model store path / lazy reader" scope item (left to the
 * implementer, not pinned), and "no hidden download" is only checked for `fetch`; child
 * processes or other network clients inside an adapter are outside this test's reach.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveAssetObject, runAssetOperation, storeAssetObject } from "../src/asset-store.js";
import { CANONICAL_AUDIO_MEDIA_TYPE, decodePcmWav } from "../src/audio.js";
import * as audioModel from "../src/audio-model-operations.js";
import { canonicalJson } from "../src/canonical.js";
import { captureEnvironment } from "../src/environment.js";
import { sha256Text } from "../src/hash.js";
import { createAssetOperationCacheKey } from "../src/operations.js";

// Snapshot of the published audio.model.generate@1 descriptor taken on baseline main
// 61d71f71ceb58ee904a4c64db8e196922b258440 (sha256 of its canonical JSON).
const V1_DESCRIPTOR_SHA256 = "b5660bc1cc056d975830e457c94d3bccbcee486a7e5052a1831082b5c713e2d3";

const api = audioModel as Record<string, any>;

function v2() {
  for (const name of [
    "AUDIO_MODEL_GENERATE_V2_OPERATION",
    "createAudioModelGenerateV2OperationBuildIdentity",
    "createAudioModelGenerateV2OperationExecutor",
  ]) {
    assert.ok(api[name] !== undefined, `src/audio-model-operations.ts must export ${name} (#208)`);
  }
  return {
    descriptor: api.AUDIO_MODEL_GENERATE_V2_OPERATION,
    buildIdentity: api.createAudioModelGenerateV2OperationBuildIdentity as (adapter: any, invocation: any) => Promise<any>,
    executor: api.createAudioModelGenerateV2OperationExecutor as (adapter: any) => (root: string, invocation: any, context?: any) => Promise<any>,
  };
}

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), "asset-tooling-audio-model-v2-"));
}

async function storedModel(root: string, bytes = Buffer.from("fixture-speech-bundle-v1")) {
  return (await storeAssetObject(root, { bytes, kind: "model", mediaType: "application/octet-stream", metadata: { format: "fixture-bundle-v1" } })).asset;
}

function samplesFor(frames: number, channels: number, salt = 0) {
  const samples = new Int16Array(frames * channels);
  for (let index = 0; index < samples.length; index += 1) samples[index] = ((index * 37 + salt) % 2000) - 1000;
  return samples;
}

/** Speech-like fixture: output length is decided by the adapter, not the request. */
function speechAdapter({ frames = 11, calls = { count: 0 }, ...overrides }: Record<string, any> = {}) {
  return {
    id: "fixture.speech-model",
    version: "1",
    reproducibility: "approximate",
    async generate(request: any) {
      calls.count += 1;
      assert.equal(request.model.id, "fixture-speech");
      return {
        audio: { sampleRate: request.sampleRate, channels: request.channels, samples: samplesFor(frames, request.channels) },
        observations: { providerMode: "fixture-speech" },
      };
    },
    ...overrides,
  };
}

const baseParameters = {
  modelId: "fixture-speech",
  modelRevision: "rev-1",
  prompt: "Arius was condemned at Nicaea.",
  seed: "7",
  sampleRate: 8_000,
  channels: 1,
  adapterParameters: { voice: "af_heart" },
};

// ---------------------------------------------------------------------------
// v1 is unchanged; v2 exists alongside it
// ---------------------------------------------------------------------------

test("audio.model.generate@1 descriptor is byte-for-byte unchanged", () => {
  assert.equal(audioModel.AUDIO_MODEL_GENERATE_OPERATION.version, "1");
  assert.equal(sha256Text(canonicalJson(audioModel.AUDIO_MODEL_GENERATE_OPERATION)), V1_DESCRIPTOR_SHA256);
  assert.ok(audioModel.AUDIO_MODEL_GENERATE_OPERATION.parameterSchema.required.includes("frameCount"));
  assert.ok(Object.isFrozen(audioModel.AUDIO_MODEL_GENERATE_OPERATION));
});

test("audio.model.generate@1 still requires frameCount, enforces it exactly and keeps its identity shape", async () => {
  const root = await workspace();
  try {
    const model = await storedModel(root);
    const execute = audioModel.createAudioModelGenerateOperationExecutor(speechAdapter({ frames: 11 }));
    await assert.rejects(execute(root, { parameters: baseParameters, inputs: { model } }), /frameCount/);
    await assert.rejects(execute(root, { parameters: { ...baseParameters, frameCount: 12 }, inputs: { model } }), /returned 11 frames; expected 12/);
    const result = await execute(root, { parameters: { ...baseParameters, frameCount: 11 }, inputs: { model } });
    assert.deepEqual(result.outputs.output.metadata.provenance.operation, { id: "audio.model.generate", version: "1" });

    const build = await audioModel.createAudioModelGenerateOperationBuildIdentity(speechAdapter(), { parameters: { ...baseParameters, frameCount: 11 }, inputs: { model } });
    assert.equal(build.operation.version, "1");
    assert.deepEqual(Object.keys(build.implementation).sort(), ["id", "model", "reproducibility", "tool", "version"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audio.model.generate@1 keeps its closed adapter shape (environmentComponents is not silently ignored)", () => {
  assert.throws(
    () => audioModel.createAudioModelGenerateOperationExecutor(speechAdapter({ environmentComponents: () => [{ torch: "2.5.1" }] })),
    /unknown field 'environmentComponents'/,
  );
});

test("audio.model.generate@2 is published next to @1 with frameCount optional", () => {
  const { descriptor } = v2();
  const v1 = audioModel.AUDIO_MODEL_GENERATE_OPERATION;
  assert.equal(descriptor.id, "audio.model.generate");
  assert.equal(descriptor.version, "2");
  assert.ok(Object.isFrozen(descriptor));
  assert.deepEqual(descriptor.inputs, v1.inputs);
  assert.deepEqual(descriptor.outputs, v1.outputs);
  assert.equal(descriptor.category, v1.category);
  assert.deepEqual([...descriptor.parameterSchema.required].sort(), ["channels", "modelId", "modelRevision", "prompt", "sampleRate"]);
  assert.deepEqual(descriptor.parameterSchema.properties, v1.parameterSchema.properties);
  assert.equal(descriptor.parameterSchema.additionalProperties, false);
});

// ---------------------------------------------------------------------------
// Output-derived frame count
// ---------------------------------------------------------------------------

test("v2 without frameCount accepts the adapter's length and records it in metadata and observations", async () => {
  const { executor, buildIdentity } = v2();
  const root = await workspace();
  try {
    const model = await storedModel(root);
    let seenFrameCount: unknown = "not-called";
    const adapter = speechAdapter({
      frames: 13,
      async generate(request: any) {
        seenFrameCount = request.frameCount;
        return { audio: { sampleRate: request.sampleRate, channels: request.channels, samples: samplesFor(13, request.channels) }, observations: {} };
      },
    });
    const build = await buildIdentity(adapter, { parameters: baseParameters, inputs: { model } });
    assert.equal(build.operation.version, "2");
    assert.ok(!("frameCount" in build.parameters), "an absent frameCount must not be invented in the canonical parameters");

    const result = await executor(adapter)(root, { parameters: baseParameters, inputs: { model } });
    assert.equal(seenFrameCount, undefined, "the adapter must not be told a target length when none was requested");
    const output = result.outputs.output;
    assert.equal(output.mediaType, CANONICAL_AUDIO_MEDIA_TYPE);
    assert.equal(output.metadata.audio.frameCount, 13);
    assert.deepEqual(output.metadata.audio.duration, { numerator: 13, denominator: 8_000 });
    assert.deepEqual(output.metadata.provenance.operation, { id: "audio.model.generate", version: "2" });
    assert.equal(result.observations.frameCount, 13);
    const decoded = decodePcmWav(await resolveAssetObject(root, output));
    assert.equal(decoded.samples.length, 13);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v2 without frameCount: a different adapter length gives a different stored output", async () => {
  const { executor } = v2();
  const root = await workspace();
  try {
    const model = await storedModel(root);
    const stereo = { ...baseParameters, channels: 2 };
    const short = await executor(speechAdapter({ frames: 5 }))(root, { parameters: stereo, inputs: { model } });
    const long = await executor(speechAdapter({ frames: 9 }))(root, { parameters: stereo, inputs: { model } });
    assert.equal(short.outputs.output.metadata.audio.frameCount, 5);
    assert.equal(long.outputs.output.metadata.audio.frameCount, 9);
    assert.equal(short.observations.frameCount, 5);
    assert.equal(long.observations.frameCount, 9);
    assert.notEqual(short.outputs.output.sha256, long.outputs.output.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v2 with frameCount enforces it exactly and passes it to the adapter", async () => {
  const { executor } = v2();
  const root = await workspace();
  try {
    const model = await storedModel(root);
    let seen: unknown;
    const adapter = speechAdapter({
      async generate(request: any) {
        seen = request.frameCount;
        return { audio: { sampleRate: request.sampleRate, channels: request.channels, samples: samplesFor(11, request.channels) }, observations: {} };
      },
    });
    await assert.rejects(executor(adapter)(root, { parameters: { ...baseParameters, frameCount: 12 }, inputs: { model } }), /returned 11 frames; expected 12/);
    assert.equal(seen, 12);
    const ok = await executor(adapter)(root, { parameters: { ...baseParameters, frameCount: 11 }, inputs: { model } });
    assert.equal(ok.outputs.output.metadata.audio.frameCount, 11);
    await assert.rejects(executor(adapter)(root, { parameters: { ...baseParameters, frameCount: 0 }, inputs: { model } }), /frameCount/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v2 still enforces sampleRate and channels, with or without frameCount", async () => {
  const { executor } = v2();
  const root = await workspace();
  try {
    const model = await storedModel(root);
    const wrongRate = speechAdapter({
      async generate(request: any) {
        return { audio: { sampleRate: request.sampleRate * 2, channels: request.channels, samples: samplesFor(4, request.channels) }, observations: {} };
      },
    });
    const wrongChannels = speechAdapter({
      async generate(request: any) {
        return { audio: { sampleRate: request.sampleRate, channels: 2, samples: samplesFor(4, 2) }, observations: {} };
      },
    });
    for (const parameters of [baseParameters, { ...baseParameters, frameCount: 4 }]) {
      await assert.rejects(executor(wrongRate)(root, { parameters, inputs: { model } }), /returned sampleRate/);
      await assert.rejects(executor(wrongChannels)(root, { parameters, inputs: { model } }), /returned 2 channels; expected 1/);
    }
    await assert.rejects(executor(speechAdapter())(root, { parameters: { ...baseParameters, hidden: 1 }, inputs: { model } }), /unknown field 'hidden'/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Runtime environment identity
// ---------------------------------------------------------------------------

test("v2 build identity folds in captureEnvironment(adapter.environmentComponents())", async () => {
  const { buildIdentity } = v2();
  const root = await workspace();
  try {
    const model = await storedModel(root);
    const components = [{ name: "python", version: "3.12.7" }, { name: "torch", version: "2.5.1+cpu" }];
    const adapter = speechAdapter({ environmentComponents: async () => components });
    const build = await buildIdentity(adapter, { parameters: baseParameters, inputs: { model } });
    assert.deepEqual(build.implementation.environment, await captureEnvironment(components));
    assert.equal(build.implementation.id, "fixture.speech-model");
    assert.deepEqual(build.implementation.model, { id: "fixture-speech", revision: "rev-1" });
    assert.ok(build.implementation.tool, "the asset-tooling tool fingerprint stays in the identity");

    const sync = await buildIdentity(speechAdapter({ environmentComponents: () => components }), { parameters: baseParameters, inputs: { model } });
    assert.deepEqual(sync, build, "a synchronous environmentComponents is equivalent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changed environment components change identity and miss in runAssetOperation; identical ones hit", async () => {
  const { buildIdentity, executor } = v2();
  const root = await workspace();
  try {
    const model = await storedModel(root);
    const invocation = { parameters: baseParameters, inputs: { model } };
    const calls = { count: 0 };
    let torch = "2.5.1+cpu";
    // Non-deterministic generator: re-execution would give different bytes.
    const adapter = speechAdapter({
      environmentComponents: () => [{ name: "torch", version: torch }],
      async generate(request: any) {
        calls.count += 1;
        return { audio: { sampleRate: request.sampleRate, channels: request.channels, samples: samplesFor(8, request.channels, calls.count) }, observations: {} };
      },
    });
    let executions = 0;
    const execute = executor(adapter);
    async function registration() {
      const build = await buildIdentity(adapter, invocation);
      return {
        build,
        registration: {
          descriptor: v2().descriptor,
          implementation: build.implementation,
          async execute(executionRoot: string, executionInvocation: any) {
            executions += 1;
            return execute(executionRoot, executionInvocation);
          },
        },
      };
    }

    const first = await registration();
    const firstRun = await runAssetOperation(root, first.registration, invocation);
    assert.equal(firstRun.status, "miss");
    assert.equal(executions, 1);

    const same = await registration();
    assert.deepEqual(same.build, first.build);
    const sameRun = await runAssetOperation(root, same.registration, invocation);
    assert.equal(sameRun.status, "hit");
    assert.equal(sameRun.cacheKey, firstRun.cacheKey);
    assert.equal(executions, 1, "an identical runtime must reuse the verified result without re-executing");
    assert.equal(calls.count, 1);
    assert.deepEqual(sameRun.result, firstRun.result);

    torch = "2.6.0+cpu";
    const drifted = await registration();
    assert.notDeepEqual(drifted.build, first.build);
    assert.notEqual(drifted.build.implementation.environment.sha256, first.build.implementation.environment.sha256);
    const driftedKey = createAssetOperationCacheKey({ operation: v2().descriptor, implementation: drifted.build.implementation, ...invocation });
    assert.notEqual(driftedKey, firstRun.cacheKey);
    const driftedRun = await runAssetOperation(root, drifted.registration, invocation);
    assert.equal(driftedRun.status, "miss");
    assert.equal(driftedRun.cacheKey, driftedKey);
    assert.equal(executions, 2, "a changed runtime must re-execute");
    assert.equal(calls.count, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("environmentComponents is optional; a malformed one is rejected", async () => {
  const { buildIdentity, executor } = v2();
  const root = await workspace();
  try {
    const model = await storedModel(root);
    const plain = speechAdapter({ frames: 6 });
    const build = await buildIdentity(plain, { parameters: baseParameters, inputs: { model } });
    assert.equal(build.operation.version, "2");
    const result = await executor(plain)(root, { parameters: baseParameters, inputs: { model } });
    assert.equal(result.outputs.output.metadata.audio.frameCount, 6);

    assert.throws(() => executor(speechAdapter({ environmentComponents: [{ torch: "2.5.1" }] })), /environmentComponents/);
    await assert.rejects(
      buildIdentity(speechAdapter({ environmentComponents: () => [{ bad: undefined }] }), { parameters: baseParameters, inputs: { model } }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Preserved v1 guarantees in v2
// ---------------------------------------------------------------------------

test("v2 keeps the approximate reproducibility label in identity, observations and reuse", async () => {
  const { buildIdentity, executor, descriptor } = v2();
  const root = await workspace();
  try {
    const model = await storedModel(root);
    const adapter = speechAdapter({ environmentComponents: () => [{ name: "torch", version: "2.5.1+cpu" }] });
    const invocation = { parameters: baseParameters, inputs: { model } };
    const build = await buildIdentity(adapter, invocation);
    assert.equal(build.implementation.reproducibility, "approximate");
    const registration = { descriptor, implementation: build.implementation, execute: executor(adapter) };
    const first = await runAssetOperation(root, registration, invocation);
    const second = await runAssetOperation(root, registration, invocation);
    assert.equal(second.status, "hit");
    assert.equal(first.result.observations.adapter.reproducibility, "approximate");
    assert.equal(second.result.observations.adapter.reproducibility, "approximate");
    assert.ok(!JSON.stringify(second.result).includes('"exact"'), "approximate output must never be relabelled exact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v2 still rejects malformed adapters", () => {
  const { executor } = v2();
  assert.throws(() => executor({ ...speechAdapter(), hidden: true }), /unknown field 'hidden'/);
  assert.throws(() => executor(speechAdapter({ id: "Not A Token" })), /lowercase dotted token/);
  assert.throws(() => executor(speechAdapter({ version: "1 0" })), /portable version token/);
  assert.throws(() => executor(speechAdapter({ reproducibility: "deterministic" })), /exact or approximate/);
  assert.throws(() => executor(speechAdapter({ generate: "nope" })), /generate must be a function/);
});

test("v2 generation performs no fetch (offline, no hidden download)", async () => {
  const { executor, buildIdentity } = v2();
  const root = await workspace();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("network access is forbidden during generation");
  }) as typeof fetch;
  try {
    const model = await storedModel(root);
    const adapter = speechAdapter({ environmentComponents: () => [{ name: "torch", version: "2.5.1+cpu" }] });
    await buildIdentity(adapter, { parameters: baseParameters, inputs: { model } });
    await executor(adapter)(root, { parameters: baseParameters, inputs: { model } });
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
