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
  TRIPOSR_MESH_OPERATION,
  createTripoSRMeshOperationBuildIdentity,
  createTripoSRMeshOperationExecutor,
} from "../src/triposr-operation.js";

const PARAMETERS = {
  bundleId: "triposr-local-bundle",
  preprocessMode: "prepared",
  device: "cuda",
  chunkSize: 8192,
  mcResolution: 256,
  outputFormat: "glb",
  deterministicAlgorithms: true,
};

const IMAGE = {
  schemaVersion: 1,
  kind: "image",
  mediaType: "image/png",
  sha256: "1".repeat(64),
  byteLength: 7,
  metadata: {},
};
const MODEL = {
  schemaVersion: 1,
  kind: "model",
  mediaType: "application/zip",
  sha256: "2".repeat(64),
  byteLength: 7,
  metadata: {},
};

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), "asset-tooling-triposr-operation-"));
}

function modelBackend({ environmentVersion = "1", generate, onEnvironmentDocument } = {}) {
  const authoritative = getBackend({ id: "model.triposr", version: "1" });
  return {
    id: authoritative.id,
    version: authoritative.version,
    kind: authoritative.kind,
    validate(document) {
      authoritative.validate(document);
    },
    async environmentComponents(document) {
      onEnvironmentDocument?.(document);
      return [{ id: "test-triposr-runtime", version: environmentVersion }];
    },
    async generate(document) {
      if (generate) return generate(document);
      return { bytes: Buffer.from("unused", "utf8"), observations: {} };
    },
  };
}

test("TripoSR operation exposes prepared image and complete bundle as typed inputs", () => {
  assert.equal(TRIPOSR_MESH_OPERATION.id, "mesh.triposr.generate");
  assert.equal(TRIPOSR_MESH_OPERATION.version, "1");
  assert.deepEqual(TRIPOSR_MESH_OPERATION.inputs.map((input) => input.id), ["image", "model"]);
  assert.deepEqual(TRIPOSR_MESH_OPERATION.inputs[0].assetKinds, ["image"]);
  assert.deepEqual(TRIPOSR_MESH_OPERATION.inputs[0].mediaTypes, ["image/png", "image/jpeg"]);
  assert.deepEqual(TRIPOSR_MESH_OPERATION.inputs[1].assetKinds, ["model"]);
  assert.deepEqual(TRIPOSR_MESH_OPERATION.inputs[1].mediaTypes, ["application/zip"]);
  assert.deepEqual(TRIPOSR_MESH_OPERATION.outputs[0].assetKinds, ["mesh"]);
  assert.deepEqual(TRIPOSR_MESH_OPERATION.outputs[0].mediaTypes, ["model/gltf-binary", "model/obj"]);
});

test("TripoSR operation build identity binds image, model, parameters, environment, and tool", async () => {
  const root = await workspace();
  let probedRoot;
  const backend = modelBackend({
    onEnvironmentDocument(document) {
      probedRoot = document.root;
    },
  });
  const identity = await createTripoSRMeshOperationBuildIdentity(
    root,
    { parameters: PARAMETERS, inputs: { image: IMAGE, model: MODEL } },
    backend,
  );

  assert.equal(probedRoot, root);
  assert.deepEqual(identity.operation, { id: "mesh.triposr.generate", version: "1" });
  assert.equal(identity.inputs.image.sha256, IMAGE.sha256);
  assert.equal(identity.inputs.model.sha256, MODEL.sha256);
  assert.equal(identity.parameters.bundleId, PARAMETERS.bundleId);
  assert.equal(identity.implementation.id, "model.triposr");
  assert.equal(identity.implementation.version, "1");
  assert.equal(identity.implementation.kind, "model");
  assert.equal(identity.implementation.tool.name, "asset-tooling");
  assert.deepEqual(identity.implementation.environment.components, [
    { id: "test-triposr-runtime", version: "1" },
  ]);

  const otherImage = await createTripoSRMeshOperationBuildIdentity(
    root,
    {
      parameters: PARAMETERS,
      inputs: { image: { ...IMAGE, sha256: "3".repeat(64) }, model: MODEL },
    },
    backend,
  );
  assert.notDeepEqual(identity, otherImage);

  const otherEnvironment = await createTripoSRMeshOperationBuildIdentity(
    root,
    { parameters: PARAMETERS, inputs: { image: IMAGE, model: MODEL } },
    modelBackend({ environmentVersion: "2" }),
  );
  assert.notEqual(
    identity.implementation.environment.sha256,
    otherEnvironment.implementation.environment.sha256,
  );
});

test("TripoSR operation reuses backend semantics and stores raw GLB as a content-addressed mesh", async () => {
  const root = await workspace();
  const storedImage = await storeAssetObject(root, {
    bytes: Buffer.from("prepared-image", "utf8"),
    kind: "image",
    mediaType: "image/png",
    metadata: {},
  });
  const storedModel = await storeAssetObject(root, {
    bytes: Buffer.from("triposr-bundle", "utf8"),
    kind: "model",
    mediaType: "application/zip",
    metadata: {},
  });
  const generatedBytes = Buffer.from("fake-glb", "utf8");
  let capturedDocument;
  const execute = createTripoSRMeshOperationExecutor(
    modelBackend({
      generate(document) {
        capturedDocument = document;
        return {
          bytes: generatedBytes,
          observations: { vertexCount: 8, faceCount: 12, outputFormat: "glb" },
        };
      },
    }),
  );

  const result = await execute(root, {
    parameters: PARAMETERS,
    inputs: { image: storedImage.asset, model: storedModel.asset },
  });

  assert.deepEqual(capturedDocument.spec.randomness, { mode: "none" });
  assert.deepEqual(capturedDocument.spec.inputs.image, {
    path: assetObjectPortablePath(storedImage.asset),
    sha256: storedImage.asset.sha256,
  });
  assert.deepEqual(capturedDocument.spec.models.triposrBundle, {
    id: PARAMETERS.bundleId,
    path: assetObjectPortablePath(storedModel.asset),
    sha256: storedModel.asset.sha256,
  });
  assert.equal(capturedDocument.spec.parameters.bundleId, undefined);
  assert.equal(capturedDocument.spec.parameters.preprocessMode, "prepared");

  assert.deepEqual(await resolveAssetObject(root, result.outputs.output), generatedBytes);
  assert.equal(result.outputs.output.kind, "mesh");
  assert.equal(result.outputs.output.mediaType, "model/gltf-binary");
  assert.deepEqual(result.outputs.output.metadata, {
    bundleId: PARAMETERS.bundleId,
    inputImageSha256: storedImage.asset.sha256,
    mcResolution: PARAMETERS.mcResolution,
    modelSha256: storedModel.asset.sha256,
    outputFormat: "glb",
  });
  assert.deepEqual(result.observations, {
    faceCount: 12,
    outputFormat: "glb",
    vertexCount: 8,
  });
});

test("TripoSR operation represents OBJ output without changing generation semantics", async () => {
  const root = await workspace();
  const storedImage = await storeAssetObject(root, {
    bytes: Buffer.from("prepared-image", "utf8"),
    kind: "image",
    mediaType: "image/jpeg",
    metadata: {},
  });
  const storedModel = await storeAssetObject(root, {
    bytes: Buffer.from("triposr-bundle", "utf8"),
    kind: "model",
    mediaType: "application/zip",
    metadata: {},
  });
  const execute = createTripoSRMeshOperationExecutor(
    modelBackend({
      generate() {
        return { bytes: Buffer.from("o mesh\n", "utf8"), observations: { outputFormat: "obj" } };
      },
    }),
  );

  const result = await execute(root, {
    parameters: { ...PARAMETERS, outputFormat: "obj" },
    inputs: { image: storedImage.asset, model: storedModel.asset },
  });
  assert.equal(result.outputs.output.mediaType, "model/obj");
  assert.equal(result.outputs.output.metadata.outputFormat, "obj");
});

test("TripoSR operation verifies both declared input objects before generation", async () => {
  const root = await workspace();
  const storedImage = await storeAssetObject(root, {
    bytes: Buffer.from("prepared-image", "utf8"),
    kind: "image",
    mediaType: "image/png",
    metadata: {},
  });
  let generated = false;
  const execute = createTripoSRMeshOperationExecutor(
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
        inputs: { image: storedImage.asset, model: MODEL },
      }),
    /asset object '[0-9a-f]{64}' is missing/,
  );
  assert.equal(generated, false);
});

test("TripoSR operation preserves prepared-input and closed parameter validation", async () => {
  const root = await workspace();
  const backend = modelBackend();
  await assert.rejects(
    () =>
      createTripoSRMeshOperationBuildIdentity(
        root,
        {
          parameters: { ...PARAMETERS, preprocessMode: "remove-background" },
          inputs: { image: IMAGE, model: MODEL },
        },
        backend,
      ),
    /preprocessMode must be 'prepared'/,
  );
  await assert.rejects(
    () =>
      createTripoSRMeshOperationBuildIdentity(
        root,
        {
          parameters: { ...PARAMETERS, hiddenDownload: true },
          inputs: { image: IMAGE, model: MODEL },
        },
        backend,
      ),
    /does not accept parameter 'hiddenDownload'/,
  );
});
