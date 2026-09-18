import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { getBackend } from "../src/backends.js";
import {
  STABLE_FAST_3D_MESH_OPERATION,
  createStableFast3DMeshOperationBuildIdentity,
  createStableFast3DMeshOperationExecutor,
} from "../src/stable-fast-3d-operation.js";

const PARAMETERS = {
  sourceBundleId: "stable-fast-3d-source",
  modelBundleId: "stabilityai/stable-fast-3d",
  tokenizerBundleId: "facebook/dinov2-large",
  preprocessMode: "prepared-rgba",
  device: "cuda",
  textureResolution: 1024,
  remesh: "triangle",
  targetVertexCount: 12000,
  deterministicAlgorithms: true,
};

const asset = (kind, mediaType, digit) => ({
  schemaVersion: 1,
  kind,
  mediaType,
  sha256: digit.repeat(64),
  byteLength: 7,
  metadata: {},
});
const IMAGE = asset("image", "image/png", "1");
const SOURCE = asset("model", "application/zip", "2");
const MODEL = asset("model", "application/zip", "3");
const DINO = asset("model", "application/zip", "4");

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), "asset-tooling-stable-fast-3d-operation-"));
}

function modelBackend({ environmentVersion = "1", generate } = {}) {
  const authoritative = getBackend({ id: "model.stable-fast-3d", version: "1" });
  return {
    id: authoritative.id,
    version: authoritative.version,
    kind: authoritative.kind,
    validate(document) {
      authoritative.validate(document);
    },
    async environmentComponents() {
      return [{ id: "test-stable-fast-3d-runtime", version: environmentVersion }];
    },
    async generate(document) {
      if (generate) return generate(document);
      return { bytes: Buffer.from("unused", "utf8"), observations: {} };
    },
  };
}

function invocation(inputs = { image: IMAGE, source: SOURCE, model: MODEL, tokenizer: DINO }) {
  return { parameters: PARAMETERS, inputs };
}

test("Stable Fast 3D operation exposes all offline dependencies as typed inputs", () => {
  assert.equal(STABLE_FAST_3D_MESH_OPERATION.id, "mesh.stable-fast-3d.generate");
  assert.equal(STABLE_FAST_3D_MESH_OPERATION.version, "1");
  assert.deepEqual(
    STABLE_FAST_3D_MESH_OPERATION.inputs.map((input) => input.id),
    ["image", "source", "model", "tokenizer"],
  );
  assert.deepEqual(STABLE_FAST_3D_MESH_OPERATION.outputs[0].mediaTypes, ["model/gltf-binary"]);
});

test("Stable Fast 3D build identity binds all input hashes and environment identity", async () => {
  const root = await workspace();
  const identity = await createStableFast3DMeshOperationBuildIdentity(
    root,
    invocation(),
    modelBackend(),
  );
  assert.equal(identity.implementation.id, "model.stable-fast-3d");
  assert.equal(identity.implementation.tool.name, "asset-tooling");
  assert.equal(identity.inputs.image.sha256, IMAGE.sha256);
  assert.equal(identity.inputs.source.sha256, SOURCE.sha256);
  assert.equal(identity.inputs.model.sha256, MODEL.sha256);
  assert.equal(identity.inputs.tokenizer.sha256, DINO.sha256);
  assert.deepEqual(identity.implementation.environment.components, [
    { id: "test-stable-fast-3d-runtime", version: "1" },
  ]);

  const changed = await createStableFast3DMeshOperationBuildIdentity(
    root,
    invocation({ ...invocation().inputs, model: { ...MODEL, sha256: "6".repeat(64) } }),
    modelBackend(),
  );
  assert.notDeepEqual(identity, changed);
});

test("Stable Fast 3D operation stores raw GLB with complete source lineage", async () => {
  const root = await workspace();
  const storedImage = await storeAssetObject(root, {
    bytes: Buffer.from("prepared-image", "utf8"),
    kind: "image",
    mediaType: "image/png",
    metadata: {},
  });
  const storedSource = await storeAssetObject(root, {
    bytes: Buffer.from("source", "utf8"),
    kind: "model",
    mediaType: "application/zip",
    metadata: {},
  });
  const storedModel = await storeAssetObject(root, {
    bytes: Buffer.from("model", "utf8"),
    kind: "model",
    mediaType: "application/zip",
    metadata: {},
  });
  const storedDino = await storeAssetObject(root, {
    bytes: Buffer.from("dino", "utf8"),
    kind: "model",
    mediaType: "application/zip",
    metadata: {},
  });
  let captured;
  const execute = createStableFast3DMeshOperationExecutor(
    modelBackend({
      generate(document) {
        captured = document;
        return {
          bytes: Buffer.from("fake-glb", "utf8"),
          observations: { vertexCount: 12000, faceCount: 22000, outputFormat: "glb" },
        };
      },
    }),
  );

  const result = await execute(root, {
    parameters: PARAMETERS,
    inputs: {
      image: storedImage.asset,
      source: storedSource.asset,
      model: storedModel.asset,
      tokenizer: storedDino.asset,
    },
  });

  assert.deepEqual(captured.spec.randomness, { mode: "none" });
  assert.equal(captured.spec.models.sf3dSourceBundle.sha256, storedSource.asset.sha256);
  assert.equal(captured.spec.models.sf3dModelBundle.sha256, storedModel.asset.sha256);
  assert.equal(captured.spec.models.dinoBundle.sha256, storedDino.asset.sha256);
  assert.equal(captured.spec.parameters.preprocessMode, "prepared-rgba");

  assert.deepEqual(await resolveAssetObject(root, result.outputs.output), Buffer.from("fake-glb"));
  assert.equal(result.outputs.output.kind, "mesh");
  assert.equal(result.outputs.output.mediaType, "model/gltf-binary");
  assert.equal(result.outputs.output.metadata.generator, "model.stable-fast-3d");
  assert.equal(result.outputs.output.metadata.inputImageSha256, storedImage.asset.sha256);
  assert.equal(result.outputs.output.metadata.sourceSha256, storedSource.asset.sha256);
  assert.equal(result.outputs.output.metadata.modelSha256, storedModel.asset.sha256);
  assert.equal(result.outputs.output.metadata.tokenizerSha256, storedDino.asset.sha256);
  assert.equal(result.outputs.output.metadata.textureResolution, 1024);
});

test("Stable Fast 3D verifies every declared object before inference", async () => {
  const root = await workspace();
  const storedImage = await storeAssetObject(root, {
    bytes: Buffer.from("prepared-image", "utf8"),
    kind: "image",
    mediaType: "image/png",
    metadata: {},
  });
  let generated = false;
  const execute = createStableFast3DMeshOperationExecutor(
    modelBackend({
      generate() {
        generated = true;
        return { bytes: Buffer.alloc(0), observations: {} };
      },
    }),
  );

  await assert.rejects(
    () =>
      execute(root, {
        parameters: PARAMETERS,
        inputs: { image: storedImage.asset, source: SOURCE, model: MODEL, tokenizer: DINO },
      }),
    /asset object '[0-9a-f]{64}' is missing/,
  );
  assert.equal(generated, false);
});

test("Stable Fast 3D operation keeps preprocessing closed and explicit", async () => {
  const root = await workspace();
  const backend = modelBackend();
  await assert.rejects(
    () =>
      createStableFast3DMeshOperationBuildIdentity(
        root,
        { ...invocation(), parameters: { ...PARAMETERS, preprocessMode: "remove-background" } },
        backend,
      ),
    /preprocessMode must be 'prepared-rgba'/,
  );
  await assert.rejects(
    () =>
      createStableFast3DMeshOperationBuildIdentity(
        root,
        { ...invocation(), parameters: { ...PARAMETERS, hiddenDownload: true } },
        backend,
      ),
    /does not accept parameter 'hiddenDownload'/,
  );
});
