import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { storeAssetObject, resolveAssetObject } from "../src/asset-store.js";
import { CANONICAL_AUDIO_MEDIA_TYPE, createCanonicalAudioMetadata, encodeCanonicalPcm16Wav } from "../src/audio.js";
import {
  AUDIO_MODEL_GENERATE_OPERATION,
  createAudioModelGenerateOperationBuildIdentity,
  createAudioModelGenerateOperationExecutor,
} from "../src/audio-model-operations.js";
import { createAssetOperationWorkflowNodeTemplate } from "../src/workflow-operations.js";

async function workspace() { return mkdtemp(path.join(os.tmpdir(), "asset-tooling-audio-model-")); }
function fixtureAdapter(overrides = {}) {
  return {
    id: "fixture.audio-model", version: "1", reproducibility: "approximate",
    async generate(request) {
      assert.equal(request.model.id, "fixture-model");
      assert.equal(request.model.revision, "rev-1");
      assert.ok(request.model.bytes.length > 0);
      const samples = new Int16Array(request.frameCount * request.channels);
      for (let frame = 0; frame < request.frameCount; frame += 1) for (let channel = 0; channel < request.channels; channel += 1) samples[frame * request.channels + channel] = frame * 100 + channel;
      return { audio: { sampleRate: request.sampleRate, channels: request.channels, samples }, observations: { providerMode: "fixture", promptLength: request.prompt.length } };
    },
    ...overrides,
  };
}
async function storedModel(root, bytes = Buffer.from("fixture-model-bundle-v1")) {
  return (await storeAssetObject(root, { bytes, kind: "model", mediaType: "application/octet-stream", metadata: { format: "fixture-bundle-v1" } })).asset;
}
async function storedConditioning(root) {
  const audio = { sampleRate: 8_000, channels: 1, samples: Int16Array.from([0, 100, -100, 0]) };
  const encoded = encodeCanonicalPcm16Wav(audio);
  const metadata = createCanonicalAudioMetadata({ sampleRate: 8_000, channels: 1, frameCount: 4, operation: { id: "audio.synthesize", version: "1" } });
  return (await storeAssetObject(root, { bytes: encoded.bytes, kind: "audio", mediaType: CANONICAL_AUDIO_MEDIA_TYPE, metadata })).asset;
}
const parameters = { modelId: "fixture-model", modelRevision: "rev-1", prompt: "short deterministic test prompt", seed: "42", sampleRate: 8_000, channels: 2, frameCount: 6, adapterParameters: { guidance: 3 } };

test("audio.model.generate publishes a normal typed asset operation", () => {
  assert.equal(AUDIO_MODEL_GENERATE_OPERATION.id, "audio.model.generate");
  assert.equal(AUDIO_MODEL_GENERATE_OPERATION.inputs[0].assetKinds[0], "model");
  assert.equal(AUDIO_MODEL_GENERATE_OPERATION.inputs[1].required, false);
  assert.equal(AUDIO_MODEL_GENERATE_OPERATION.outputs[0].mediaTypes[0], CANONICAL_AUDIO_MEDIA_TYPE);
  const template = createAssetOperationWorkflowNodeTemplate(AUDIO_MODEL_GENERATE_OPERATION, { parameters });
  assert.equal(template.kind, "asset.operation");
  assert.equal(template.outputs[0].metadata.assetOperationPort.assetKinds[0], "audio");
});

test("build identity binds adapter identity, model revision, and exact model AssetRef", async () => {
  const root = await workspace();
  try {
    const firstModel = await storedModel(root);
    const secondModel = await storedModel(root, Buffer.from("fixture-model-bundle-v2"));
    const adapter = fixtureAdapter();
    const first = await createAudioModelGenerateOperationBuildIdentity(adapter, { parameters, inputs: { model: firstModel } });
    const same = await createAudioModelGenerateOperationBuildIdentity(adapter, { parameters: { ...parameters, adapterParameters: { guidance: 3 } }, inputs: { model: firstModel } });
    const changedModel = await createAudioModelGenerateOperationBuildIdentity(adapter, { parameters, inputs: { model: secondModel } });
    const changedRevision = await createAudioModelGenerateOperationBuildIdentity(adapter, { parameters: { ...parameters, modelRevision: "rev-2" }, inputs: { model: firstModel } });
    assert.deepEqual(first, same);
    assert.equal(first.implementation.reproducibility, "approximate");
    assert.equal(first.inputs.model.sha256, firstModel.sha256);
    assert.notDeepEqual(first, changedModel);
    assert.notDeepEqual(first, changedRevision);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("executor resolves exact model and conditioning objects and stores canonical output", async () => {
  const root = await workspace();
  try {
    const model = await storedModel(root);
    const conditioning = await storedConditioning(root);
    let calls = 0;
    const adapter = fixtureAdapter({ async generate(request) { calls += 1; assert.equal(request.model.asset.sha256, model.sha256); assert.equal(request.conditioning.asset.sha256, conditioning.sha256); assert.equal(request.seed, "42"); assert.deepEqual(request.parameters, { guidance: 3 }); return fixtureAdapter().generate(request); } });
    const result = await createAudioModelGenerateOperationExecutor(adapter)(root, { parameters, inputs: { model, conditioning } });
    assert.equal(calls, 1);
    assert.equal(result.outputs.output.mediaType, CANONICAL_AUDIO_MEDIA_TYPE);
    assert.deepEqual(result.outputs.output.metadata.provenance.inputs, [{ port: "model", sha256: model.sha256 }, { port: "conditioning", sha256: conditioning.sha256 }]);
    assert.equal(result.observations.model.sha256, model.sha256);
    assert.ok((await resolveAssetObject(root, result.outputs.output)).length > 44);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("adapter output shape and evidence are fail-closed", async () => {
  assert.throws(() => createAudioModelGenerateOperationExecutor({ ...fixtureAdapter(), hidden: true }), /unknown field 'hidden'/);
  const root = await workspace();
  try {
    const model = await storedModel(root);
    const wrongShape = createAudioModelGenerateOperationExecutor(fixtureAdapter({ async generate(request) { return { audio: { sampleRate: request.sampleRate * 2, channels: request.channels, samples: new Int16Array(request.frameCount * request.channels) }, observations: {} }; } }));
    await assert.rejects(wrongShape(root, { parameters, inputs: { model } }), /returned sampleRate/);
    const badEvidence = createAudioModelGenerateOperationExecutor(fixtureAdapter({ async generate(request) { const result = await fixtureAdapter().generate(request); return { ...result, observations: { invalid: undefined } }; } }));
    await assert.rejects(badEvidence(root, { parameters, inputs: { model } }), /undefined/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
