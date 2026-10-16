/**
 * Regression tests for the Codex review of PR #209 (#208):
 *   P1: a runtime probe that changes between cache-key preparation and execution must not record
 *       the new runtime's output under the old runtime's key.
 *   P2: an adapter mutated after factory creation must not change what the factory executes or
 *       which identity it records; v1 never probes an environment.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAssetOperation, storeAssetObject } from "../src/asset-store.js";
import {
  AUDIO_MODEL_GENERATE_V2_OPERATION,
  createAudioModelGenerateOperationBuildIdentity,
  createAudioModelGenerateOperationExecutor,
  createAudioModelGenerateV2OperationBuildIdentity,
  createAudioModelGenerateV2OperationExecutor,
} from "../src/audio-model-operations.js";

const parameters = {
  modelId: "fixture-speech",
  modelRevision: "rev-1",
  prompt: "Fixture prompt.",
  sampleRate: 8_000,
  channels: 1,
};

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), "asset-tooling-audio-model-v2-review-"));
}

async function storedModel(root: string) {
  return (await storeAssetObject(root, { bytes: Buffer.from("fixture-bundle"), kind: "model", mediaType: "application/octet-stream" })).asset;
}

function adapter(state: { torch: string; generated: number }) {
  return {
    id: "fixture.speech-model",
    version: "1",
    reproducibility: "approximate",
    environmentComponents: () => [{ name: "torch", version: state.torch }],
    async generate(request: any) {
      state.generated += 1;
      const samples = new Int16Array(4 + state.generated);
      samples.fill(state.generated);
      return { audio: { sampleRate: request.sampleRate, channels: request.channels, samples }, observations: { torch: state.torch } };
    },
  };
}

test("P1: runtime drift between key preparation and execution fails closed and records nothing under the old key", async () => {
  const root = await workspace();
  try {
    const model = await storedModel(root);
    const invocation = { parameters, inputs: { model } };
    const state = { torch: "A", generated: 0 };
    const fixture = adapter(state);
    const execute = createAudioModelGenerateV2OperationExecutor(fixture);

    const prepared = await createAudioModelGenerateV2OperationBuildIdentity(fixture, invocation);
    const registration = { descriptor: AUDIO_MODEL_GENERATE_V2_OPERATION, implementation: prepared.implementation, execute };

    // The runtime changes after the key (environment A) was derived but before execution probes it.
    state.torch = "B";
    await assert.rejects(runAssetOperation(root, registration, invocation), /changed after the build identity was prepared/);
    assert.equal(state.generated, 0, "the adapter must not run under a mismatched runtime");

    // Back on runtime A, the same key must still be a miss: nothing from B was recorded under it.
    state.torch = "A";
    const run = await runAssetOperation(root, registration, invocation);
    assert.equal(run.status, "miss");
    assert.equal(run.result.observations.backend.torch, "A");
    const again = await runAssetOperation(root, registration, invocation);
    assert.equal(again.status, "hit");
    assert.equal(again.cacheKey, run.cacheKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P1: a directly called v2 executor probes the environment once per execution", async () => {
  const root = await workspace();
  try {
    const model = await storedModel(root);
    let probes = 0;
    const state = { torch: "A", generated: 0 };
    const fixture = { ...adapter(state), environmentComponents: () => [{ probe: ++probes }] };
    await createAudioModelGenerateV2OperationExecutor(fixture)(root, { parameters, inputs: { model } });
    assert.equal(probes, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P2: adding environmentComponents to a v1 adapter after factory creation changes nothing", async () => {
  const root = await workspace();
  try {
    const model = await storedModel(root);
    const invocation = { parameters: { ...parameters, frameCount: 5 }, inputs: { model } };
    const state = { torch: "A", generated: 0 };
    const { environmentComponents: _unused, ...v1Adapter } = adapter(state);
    const execute = createAudioModelGenerateOperationExecutor(v1Adapter);
    const before = await createAudioModelGenerateOperationBuildIdentity(v1Adapter, invocation);

    let probes = 0;
    Object.assign(v1Adapter, {
      environmentComponents: () => {
        probes += 1;
        throw new Error("v1 must never probe an adapter environment");
      },
    });
    const result = await execute(root, invocation);
    assert.equal(probes, 0);
    assert.deepEqual(result.outputs.output.metadata.provenance.operation, { id: "audio.model.generate", version: "1" });
    assert.ok(!("environment" in before.implementation));

    // A fresh v1 identity call validates the mutated object again and rejects the extra field.
    await assert.rejects(createAudioModelGenerateOperationBuildIdentity(v1Adapter, invocation), /unknown field 'environmentComponents'/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P2: replacing generate or environmentComponents after v2 factory creation has no effect", async () => {
  const root = await workspace();
  try {
    const model = await storedModel(root);
    const state = { torch: "A", generated: 0 };
    const fixture = adapter(state);
    const execute = createAudioModelGenerateV2OperationExecutor(fixture);
    Object.assign(fixture, {
      generate: () => {
        throw new Error("replaced generate must not run");
      },
      environmentComponents: () => {
        throw new Error("replaced environmentComponents must not run");
      },
    });
    const result = await execute(root, { parameters, inputs: { model } });
    assert.equal(result.observations.backend.torch, "A");
    assert.equal(state.generated, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
