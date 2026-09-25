import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { getBackend } from "../src/backends.js";
import {
  TRELLIS2_MESH_OPERATION,
  createTrellis2MeshOperationBuildIdentity,
  createTrellis2MeshOperationExecutor,
} from "../src/trellis2-operation.js";

const PARAMETERS = {
  sourceBundleId: "microsoft/TRELLIS.2@75fbf0183001ed9876c8dbb35de6b68552ee08bd",
  modelBundleId: "microsoft/TRELLIS.2-4B",
  legacyDecoderBundleId: "microsoft/TRELLIS-image-large",
  imageEncoderBundleId: "facebook/dinov3-vitl16-pretrain-lvd1689m",
  seed: "42",
  preprocessMode: "prepared-rgba-premultiplied",
  device: "cuda",
  pipelineType: "1024-cascade",
  maxNumTokens: 49152,
  decimationTarget: 100000,
  textureSize: 2048,
  remesh: true,
  extensionWebp: false,
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
const LEGACY = asset("model", "application/zip", "4");
const DINO = asset("model", "application/zip", "5");

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), "asset-tooling-trellis2-operation-"));
}

function modelBackend({ environmentVersion = "1", generate } = {}) {
  const authoritative = getBackend({ id: "model.trellis2", version: "1" });
  return {
    id: authoritative.id,
    version: authoritative.version,
    kind: authoritative.kind,
    validate(document) {
      authoritative.validate(document);
    },
    async environmentComponents() {
      return [{ id: "test-trellis2-runtime", version: environmentVersion }];
    },
    async generate(document) {
      if (generate) return generate(document);
      return { bytes: Buffer.from("unused", "utf8"), observations: {} };
    },
  };
}

function invocation(
  inputs = {
    image: IMAGE,
    source: SOURCE,
    model: MODEL,
    "legacy-decoder": LEGACY,
    "image-encoder": DINO,
  },
) {
  return { parameters: PARAMETERS, inputs };
}

test("TRELLIS.2 operation exposes every offline dependency and PBR GLB output", () => {
  assert.equal(TRELLIS2_MESH_OPERATION.id, "mesh.trellis2.generate");
  assert.equal(TRELLIS2_MESH_OPERATION.version, "1");
  assert.deepEqual(
    TRELLIS2_MESH_OPERATION.inputs.map((input) => input.id),
    ["image", "source", "model", "legacy-decoder", "image-encoder"],
  );
  assert.deepEqual(TRELLIS2_MESH_OPERATION.outputs[0].mediaTypes, ["model/gltf-binary"]);
});

test("TRELLIS.2 build identity binds seed, dependency hashes, and environment identity", async () => {
  const root = await workspace();
  const identity = await createTrellis2MeshOperationBuildIdentity(
    root,
    invocation(),
    modelBackend(),
  );
  assert.equal(identity.implementation.id, "model.trellis2");
  assert.equal(identity.implementation.tool.name, "asset-tooling");
  assert.equal(identity.parameters.seed, "42");
  assert.equal(identity.inputs.source.sha256, SOURCE.sha256);
  assert.equal(identity.inputs.model.sha256, MODEL.sha256);
  assert.equal(identity.inputs["legacy-decoder"].sha256, LEGACY.sha256);
  assert.equal(identity.inputs["image-encoder"].sha256, DINO.sha256);
  assert.deepEqual(identity.implementation.environment.components, [
    { id: "test-trellis2-runtime", version: "1" },
  ]);

  const changed = await createTrellis2MeshOperationBuildIdentity(
    root,
    { ...invocation(), parameters: { ...PARAMETERS, seed: "43" } },
    modelBackend(),
  );
  assert.notDeepEqual(identity, changed);
});

test("TRELLIS.2 operation stores raw PBR GLB with complete source lineage", async () => {
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
  const storedLegacy = await storeAssetObject(root, {
    bytes: Buffer.from("legacy-decoder", "utf8"),
    kind: "model",
    mediaType: "application/zip",
    metadata: {},
  });
  const storedDino = await storeAssetObject(root, {
    bytes: Buffer.from("dino-v3", "utf8"),
    kind: "model",
    mediaType: "application/zip",
    metadata: {},
  });

  let captured;
  const execute = createTrellis2MeshOperationExecutor(
    modelBackend({
      generate(document) {
        captured = document;
        return {
          bytes: Buffer.from("fake-pbr-glb", "utf8"),
          observations: {
            outputFormat: "glb",
            pbrChannels: ["base-color", "metallic", "roughness", "opacity"],
          },
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
      "legacy-decoder": storedLegacy.asset,
      "image-encoder": storedDino.asset,
    },
  });

  assert.deepEqual(captured.spec.randomness, { mode: "seeded", seed: "42" });
  assert.equal(captured.spec.models.trellis2SourceBundle.sha256, storedSource.asset.sha256);
  assert.equal(captured.spec.models.trellis2ModelBundle.sha256, storedModel.asset.sha256);
  assert.equal(captured.spec.models.trellisLegacyDecoderBundle.sha256, storedLegacy.asset.sha256);
  assert.equal(captured.spec.models.dinoV3Bundle.sha256, storedDino.asset.sha256);
  assert.equal(captured.spec.parameters.preprocessMode, "prepared-rgba-premultiplied");

  assert.deepEqual(
    await resolveAssetObject(root, result.outputs.output),
    Buffer.from("fake-pbr-glb"),
  );
  assert.equal(result.outputs.output.kind, "mesh");
  assert.equal(result.outputs.output.mediaType, "model/gltf-binary");
  assert.equal(result.outputs.output.metadata.generator, "model.trellis2");
  assert.equal(result.outputs.output.metadata.legacyDecoderSha256, storedLegacy.asset.sha256);
  assert.equal(result.outputs.output.metadata.imageEncoderSha256, storedDino.asset.sha256);
  assert.deepEqual(result.outputs.output.metadata.pbrChannels, [
    "base-color",
    "metallic",
    "roughness",
    "opacity",
  ]);
});

test("TRELLIS.2 verifies every declared object before inference", async () => {
  const root = await workspace();
  const storedImage = await storeAssetObject(root, {
    bytes: Buffer.from("prepared-image", "utf8"),
    kind: "image",
    mediaType: "image/png",
    metadata: {},
  });
  let generated = false;
  const execute = createTrellis2MeshOperationExecutor(
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
        inputs: {
          image: storedImage.asset,
          source: SOURCE,
          model: MODEL,
          "legacy-decoder": LEGACY,
          "image-encoder": DINO,
        },
      }),
    /asset object '[0-9a-f]{64}' is missing/,
  );
  assert.equal(generated, false);
});

test("TRELLIS.2 rejects hidden preprocessing, unsupported devices, and undeclared parameters", async () => {
  const root = await workspace();
  const backend = modelBackend();
  await assert.rejects(
    () =>
      createTrellis2MeshOperationBuildIdentity(
        root,
        { ...invocation(), parameters: { ...PARAMETERS, preprocessMode: "remove-background" } },
        backend,
      ),
    /preprocessMode must be 'prepared-rgba-premultiplied'/,
  );
  await assert.rejects(
    () =>
      createTrellis2MeshOperationBuildIdentity(
        root,
        { ...invocation(), parameters: { ...PARAMETERS, device: "cpu" } },
        backend,
      ),
    /parameters.device must be cuda/,
  );
  await assert.rejects(
    () =>
      createTrellis2MeshOperationBuildIdentity(
        root,
        { ...invocation(), parameters: { ...PARAMETERS, hiddenDownload: true } },
        backend,
      ),
    /does not accept parameter 'hiddenDownload'/,
  );
});
