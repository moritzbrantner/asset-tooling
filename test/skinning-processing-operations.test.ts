import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  MESH_SKINNING_VALIDATE_OPERATION,
  THREE_D_SKINNING_MEDIA_TYPE,
  createMeshSkinningValidateOperationBuildIdentity,
  executeMeshSkinningValidateOperation,
} from "../src/skinning-processing-operations.js";

const FIXTURE_ADAPTER = fileURLToPath(new URL("./fixtures/skinning-process-adapter.js", import.meta.url));
const PROCESSOR = {
  repository: "fixture/3d-lab",
  revision: "d".repeat(40),
  executable: process.execPath,
  scriptPath: FIXTURE_ADAPTER,
  prefixArguments: [],
  sourceFiles: [FIXTURE_ADAPTER],
};
const IDENTITY = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

function translatedY(value) {
  const matrix = [...IDENTITY];
  matrix[13] = value;
  return matrix;
}

function sourceDocument() {
  return {
    schemaVersion: 1,
    joints: [
      { parent: null, inverseBind: IDENTITY, bindWorld: IDENTITY },
      { parent: 0, inverseBind: translatedY(-1), bindWorld: translatedY(1) },
    ],
    influences: [
      { joints: [0, 0, 0, 0], weights: [1, 0, 0, 0] },
      { joints: [0, 1, 0, 0], weights: [1, 3, 0, 0] },
    ],
  };
}

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), "asset-tooling-skinning-"));
}

async function storedSource(root) {
  return (
    await storeAssetObject(root, {
      bytes: Buffer.from(JSON.stringify(sourceDocument()), "utf8"),
      kind: "skinning",
      mediaType: THREE_D_SKINNING_MEDIA_TYPE,
      metadata: { skinningSchemaVersion: 1, jointCount: 2, vertexInfluenceCount: 2 },
    })
  ).asset;
}

test("skinning validation descriptor exposes one typed source and normalized evidence output", () => {
  assert.equal(MESH_SKINNING_VALIDATE_OPERATION.id, "mesh.skinning.validate");
  assert.equal(MESH_SKINNING_VALIDATE_OPERATION.version, "1");
  assert.deepEqual(MESH_SKINNING_VALIDATE_OPERATION.inputs[0].assetKinds, ["skinning"]);
  assert.deepEqual(MESH_SKINNING_VALIDATE_OPERATION.inputs[0].mediaTypes, [THREE_D_SKINNING_MEDIA_TYPE]);
  assert.deepEqual(MESH_SKINNING_VALIDATE_OPERATION.outputs[0].assetKinds, ["skinning"]);
});

test("build identity pins source, probe, algorithm, parameters, and adapter bytes", async () => {
  const root = await workspace();
  const source = await storedSource(root);
  const identity = await createMeshSkinningValidateOperationBuildIdentity(
    root,
    {
      parameters: { bindPoseIdentityTolerance: 0.0001 },
      inputs: { source },
    },
    PROCESSOR,
  );
  assert.deepEqual(identity.operation, { id: "mesh.skinning.validate", version: "1" });
  assert.equal(identity.parameters.bindPoseIdentityTolerance, Math.fround(0.0001));
  assert.equal(identity.implementation.id, "three-d-skinning-validate");
  assert.equal(identity.implementation.probe.algorithm, "three-d-animation-skinning-profile-v1");
  assert.equal(identity.implementation.probe.protocol, "asset-tooling-process-adapter-v1");
  assert.equal(identity.implementation.probe.codec, "three-d-skinning-json-v1");
  assert.equal(identity.implementation.source.repository, "fixture/3d-lab");
  assert.equal(identity.implementation.source.revision, "d".repeat(40));
  assert.match(identity.implementation.source.sourceSha256, /^[0-9a-f]{64}$/);
});

test("skinning validation normalizes weights idempotently and records production evidence", async () => {
  const root = await workspace();
  const source = await storedSource(root);
  const invocation = {
    parameters: { bindPoseIdentityTolerance: 0.0001 },
    inputs: { source },
  };
  const first = await executeMeshSkinningValidateOperation(root, invocation, PROCESSOR);
  const second = await executeMeshSkinningValidateOperation(root, invocation, PROCESSOR);
  assert.equal(second.outputs.output.sha256, first.outputs.output.sha256);
  assert.deepEqual(second.observations, first.observations);
  assert.equal(first.outputs.output.kind, "skinning");
  assert.equal(first.outputs.output.mediaType, THREE_D_SKINNING_MEDIA_TYPE);
  assert.equal(first.outputs.output.metadata.jointCount, 2);
  assert.equal(first.outputs.output.metadata.vertexInfluenceCount, 2);
  assert.equal(first.outputs.output.metadata.influenceSlotsPerVertex, 4);
  assert.equal(first.observations.jointCount, 2);
  assert.equal(first.observations.rootJointCount, 1);
  assert.equal(first.observations.vertexInfluenceCount, 2);
  assert.equal(first.observations.maxActiveInfluences, 2);
  assert.equal(first.observations.parentBeforeChild, true);
  assert.equal(first.observations.weightsNormalized, true);
  assert.equal(first.observations.activeJointIndicesInRange, true);
  assert.equal(first.observations.inverseBindMatchesBindPose, true);
  assert.equal(first.observations.maxBindPoseIdentityError, 0);
  assert.equal(first.observations.matrixLayout, "column-major-4x4");
  assert.equal(first.observations.skinMatrixRule, "joint-world-times-inverse-bind");

  const output = JSON.parse((await resolveAssetObject(root, first.outputs.output)).toString("utf8"));
  assert.deepEqual(output.joints, sourceDocument().joints);
  assert.deepEqual(output.influences[0], { joints: [0, 0, 0, 0], weights: [1, 0, 0, 0] });
  assert.deepEqual(output.influences[1], { joints: [0, 1, 0, 0], weights: [0.25, 0.75, 0, 0] });
});

test("skinning validation fails closed on invalid source structure and ambiguous parameters", async () => {
  const root = await workspace();
  const invalidSource = (
    await storeAssetObject(root, {
      bytes: Buffer.from(
        JSON.stringify({
          ...sourceDocument(),
          joints: [
            { parent: 1, inverseBind: IDENTITY, bindWorld: IDENTITY },
            sourceDocument().joints[1],
          ],
        }),
        "utf8",
      ),
      kind: "skinning",
      mediaType: THREE_D_SKINNING_MEDIA_TYPE,
      metadata: {},
    })
  ).asset;
  await assert.rejects(
    () =>
      executeMeshSkinningValidateOperation(
        root,
        {
          parameters: { bindPoseIdentityTolerance: 0.0001 },
          inputs: { source: invalidSource },
        },
        PROCESSOR,
      ),
    /parent must reference an earlier joint/,
  );
  const source = await storedSource(root);
  await assert.rejects(
    () =>
      executeMeshSkinningValidateOperation(
        root,
        {
          parameters: { bindPoseIdentityTolerance: -1 },
          inputs: { source },
        },
        PROCESSOR,
      ),
    /bindPoseIdentityTolerance must be non-negative/,
  );
});
