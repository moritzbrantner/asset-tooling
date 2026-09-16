import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  assetObjectPortablePath,
  resolveAssetObject,
  storeAssetObject,
} from "../src/asset-store.js";
import { getBackend } from "../src/backends.js";
import {
  STABLE_DIFFUSION_IMAGE_OPERATION,
  createStableDiffusionImageOperationBuildIdentity,
  createStableDiffusionImageOperationExecutor,
} from "../src/generation-operations.js";

const PARAMETERS = {
  pipelineId: "stable-diffusion-local-pipeline",
  seed: "42",
  prompt: "a small stone cottage",
  negativePrompt: "",
  width: 512,
  height: 512,
  steps: 30,
  guidanceScale: 7.5,
  scheduler: "euler",
  dtype: "float16",
  device: "cuda",
  deterministicAlgorithms: true,
};

const MODEL = {
  schemaVersion: 1,
  kind: "model",
  mediaType: "application/zip",
  sha256: "a".repeat(64),
  byteLength: 7,
  metadata: {},
};

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), "asset-tooling-stable-diffusion-operation-"));
}

function modelBackend({ environmentVersion = "1", generate, onEnvironmentDocument } = {}) {
  const authoritative = getBackend({ id: "model.stable-diffusion.diffusers", version: "1" });
  return {
    id: authoritative.id,
    version: authoritative.version,
    kind: authoritative.kind,
    validate(document) {
      authoritative.validate(document);
    },
    async environmentComponents(document) {
      onEnvironmentDocument?.(document);
      return [{ id: "test-stable-diffusion-runtime", version: environmentVersion }];
    },
    async generate(document) {
      if (generate) return generate(document);
      return { bytes: Buffer.from("unused", "utf8"), observations: {} };
    },
  };
}

test("Stable Diffusion operation exposes the pipeline bundle as content-addressed input", () => {
  assert.equal(STABLE_DIFFUSION_IMAGE_OPERATION.id, "image.stable-diffusion.generate");
  assert.equal(STABLE_DIFFUSION_IMAGE_OPERATION.version, "1");
  assert.equal(STABLE_DIFFUSION_IMAGE_OPERATION.inputs.length, 1);
  assert.equal(STABLE_DIFFUSION_IMAGE_OPERATION.inputs[0].id, "model");
  assert.deepEqual(STABLE_DIFFUSION_IMAGE_OPERATION.inputs[0].assetKinds, ["model"]);
  assert.deepEqual(STABLE_DIFFUSION_IMAGE_OPERATION.inputs[0].mediaTypes, ["application/zip"]);
  assert.deepEqual(STABLE_DIFFUSION_IMAGE_OPERATION.outputs[0].assetKinds, ["image"]);
  assert.deepEqual(STABLE_DIFFUSION_IMAGE_OPERATION.outputs[0].mediaTypes, ["image/png"]);
});

test("Stable Diffusion operation build identity binds model bytes, parameters, execution environment, and asset root", async () => {
  const root = await workspace();
  let probedRoot;
  const backend = modelBackend({
    onEnvironmentDocument(document) {
      probedRoot = document.root;
    },
  });
  const identity = await createStableDiffusionImageOperationBuildIdentity(
    root,
    {
      parameters: PARAMETERS,
      inputs: { model: MODEL },
    },
    backend,
  );

  assert.equal(probedRoot, root);
  assert.deepEqual(identity.operation, { id: "image.stable-diffusion.generate", version: "1" });
  assert.equal(identity.parameters.seed, "42");
  assert.equal(identity.parameters.pipelineId, "stable-diffusion-local-pipeline");
  assert.equal(identity.inputs.model.sha256, MODEL.sha256);
  assert.equal(identity.implementation.id, "model.stable-diffusion.diffusers");
  assert.equal(identity.implementation.version, "1");
  assert.equal(identity.implementation.kind, "model");
  assert.equal(identity.implementation.tool.name, "asset-tooling");
  assert.deepEqual(identity.implementation.environment.components, [
    { id: "test-stable-diffusion-runtime", version: "1" },
  ]);
  assert.match(identity.implementation.environment.sha256, /^[0-9a-f]{64}$/);

  const otherModel = await createStableDiffusionImageOperationBuildIdentity(
    root,
    {
      parameters: PARAMETERS,
      inputs: { model: { ...MODEL, sha256: "b".repeat(64) } },
    },
    backend,
  );
  assert.notDeepEqual(identity, otherModel);

  const otherEnvironment = await createStableDiffusionImageOperationBuildIdentity(
    root,
    {
      parameters: PARAMETERS,
      inputs: { model: MODEL },
    },
    modelBackend({ environmentVersion: "2" }),
  );
  assert.notEqual(
    identity.implementation.environment.sha256,
    otherEnvironment.implementation.environment.sha256,
  );
});

test("Stable Diffusion operation reuses backend semantics and materializes only verified object-store model bytes", async () => {
  const root = await workspace();
  const modelBytes = Buffer.from("pipeline-bundle", "utf8");
  const storedModel = await storeAssetObject(root, {
    bytes: modelBytes,
    kind: "model",
    mediaType: "application/zip",
    metadata: {},
  });
  const generatedBytes = Buffer.from("fake-png-output", "utf8");
  let capturedDocument;
  const backend = modelBackend({
    generate(document) {
      capturedDocument = document;
      return {
        bytes: generatedBytes,
        observations: { adapter: "fake-diffusers", seed: document.spec.randomness.seed },
      };
    },
  });

  const execute = createStableDiffusionImageOperationExecutor(backend);
  const result = await execute(root, {
    parameters: PARAMETERS,
    inputs: { model: storedModel.asset },
  });

  assert.deepEqual(capturedDocument.spec.inputs, {});
  assert.deepEqual(capturedDocument.spec.models, {
    pipelineBundle: {
      id: PARAMETERS.pipelineId,
      path: assetObjectPortablePath(storedModel.asset),
      sha256: storedModel.asset.sha256,
    },
  });
  assert.deepEqual(capturedDocument.spec.randomness, { mode: "seeded", seed: PARAMETERS.seed });
  assert.equal(capturedDocument.spec.parameters.prompt, PARAMETERS.prompt);
  assert.equal(capturedDocument.spec.parameters.pipelineId, undefined);
  assert.equal(capturedDocument.spec.parameters.seed, undefined);

  assert.deepEqual(await resolveAssetObject(root, result.outputs.output), generatedBytes);
  assert.equal(result.outputs.output.kind, "image");
  assert.equal(result.outputs.output.mediaType, "image/png");
  assert.deepEqual(result.outputs.output.metadata, {
    height: PARAMETERS.height,
    modelSha256: storedModel.asset.sha256,
    pipelineId: PARAMETERS.pipelineId,
    width: PARAMETERS.width,
  });
  assert.deepEqual(result.observations, { adapter: "fake-diffusers", seed: "42" });
});

test("Stable Diffusion operation fails closed before generation when model bytes are missing", async () => {
  let generated = false;
  const backend = modelBackend({
    generate() {
      generated = true;
      return { bytes: Buffer.alloc(0), observations: {} };
    },
  });
  const execute = createStableDiffusionImageOperationExecutor(backend);
  const root = await workspace();

  await assert.rejects(
    () => execute(root, { parameters: PARAMETERS, inputs: { model: MODEL } }),
    /asset object '[0-9a-f]{64}' is missing/,
  );
  assert.equal(generated, false);
});

test("Stable Diffusion operation preserves backend validation for seed domain and unsupported parameters", async () => {
  const root = await workspace();
  const backend = modelBackend();
  await assert.rejects(
    () =>
      createStableDiffusionImageOperationBuildIdentity(
        root,
        {
          parameters: { ...PARAMETERS, seed: "18446744073709551616" },
          inputs: { model: MODEL },
        },
        backend,
      ),
    /randomness\.seed must be at most 18446744073709551615 for PyTorch/,
  );

  await assert.rejects(
    () =>
      createStableDiffusionImageOperationBuildIdentity(
        root,
        {
          parameters: { ...PARAMETERS, hiddenDownload: true },
          inputs: { model: MODEL },
        },
        backend,
      ),
    /does not accept parameter 'hiddenDownload'/,
  );
});
