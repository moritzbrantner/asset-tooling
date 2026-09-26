import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  MESH_RIGGED_COLLISION_FIT_OPERATION,
  THREE_D_RIGGED_COLLISION_INPUT_MEDIA_TYPE,
  THREE_D_RIGGED_COLLISION_MEDIA_TYPE,
  createMeshRiggedCollisionFitOperationBuildIdentity,
  executeMeshRiggedCollisionFitOperation,
} from "../src/rigged-collision-processing-operations.js";

const FIXTURE_ADAPTER = fileURLToPath(
  new URL("./fixtures/rigged-collision-process-adapter.js", import.meta.url),
);
const PROCESSOR = {
  repository: "fixture/3d-lab",
  revision: "e".repeat(40),
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

function sourceDocument() {
  const positions = [];
  for (const x of [-0.2, 0.2]) {
    for (const y of [-1, 1]) {
      for (const z of [-0.2, 0.2]) {
        positions.push([x, y, z]);
      }
    }
  }
  return {
    schemaVersion: 1,
    positions,
    joints: [{ parent: null, inverseBind: IDENTITY }],
    influences: positions.map(() => ({
      joints: [0, 0, 0, 0],
      weights: [1, 0, 0, 0],
    })),
  };
}

function parameters() {
  return {
    minVerticesPerJoint: 4,
    minDominantWeight: 0.5,
    padding: 0.01,
    minimumExtent: 0.01,
    sphereAspectRatio: 1.25,
    capsuleAspectRatio: 1.75,
  };
}

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), "asset-tooling-rigged-collision-"));
}

async function storedSource(root) {
  return (
    await storeAssetObject(root, {
      bytes: Buffer.from(JSON.stringify(sourceDocument()), "utf8"),
      kind: "rigged-mesh",
      mediaType: THREE_D_RIGGED_COLLISION_INPUT_MEDIA_TYPE,
      metadata: { riggedCollisionSchemaVersion: 1, jointCount: 1, vertexCount: 8 },
    })
  ).asset;
}

test("rigged collision descriptor exposes a focused processor boundary", () => {
  assert.equal(MESH_RIGGED_COLLISION_FIT_OPERATION.id, "mesh.rigged-collision.fit");
  assert.equal(MESH_RIGGED_COLLISION_FIT_OPERATION.version, "1");
  assert.deepEqual(MESH_RIGGED_COLLISION_FIT_OPERATION.inputs[0].assetKinds, ["rigged-mesh"]);
  assert.deepEqual(MESH_RIGGED_COLLISION_FIT_OPERATION.outputs[0].assetKinds, ["collision"]);
});

test("build identity pins source, probe, parameters, and adapter bytes", async () => {
  const root = await workspace();
  const source = await storedSource(root);
  const identity = await createMeshRiggedCollisionFitOperationBuildIdentity(
    root,
    { parameters: parameters(), inputs: { source } },
    PROCESSOR,
  );
  assert.deepEqual(identity.operation, { id: "mesh.rigged-collision.fit", version: "1" });
  assert.equal(identity.implementation.id, "three-d-rigged-collision-fit");
  assert.equal(
    identity.implementation.probe.algorithm,
    "three-d-rigged-assets-joint-proxy-fit-v1",
  );
  assert.equal(identity.implementation.probe.protocol, "asset-tooling-process-adapter-v1");
  assert.equal(identity.implementation.probe.codec, "three-d-rigged-collision-json-v1");
  assert.equal(identity.implementation.source.repository, "fixture/3d-lab");
  assert.equal(identity.implementation.source.revision, "e".repeat(40));
  assert.match(identity.implementation.source.sourceSha256, /^[0-9a-f]{64}$/);
});

test("rigged collision fitting stores deterministic proxy evidence", async () => {
  const root = await workspace();
  const source = await storedSource(root);
  const invocation = { parameters: parameters(), inputs: { source } };
  const first = await executeMeshRiggedCollisionFitOperation(root, invocation, PROCESSOR);
  const second = await executeMeshRiggedCollisionFitOperation(root, invocation, PROCESSOR);

  assert.equal(second.outputs.output.sha256, first.outputs.output.sha256);
  assert.deepEqual(second.observations, first.observations);
  assert.equal(first.outputs.output.kind, "collision");
  assert.equal(first.outputs.output.mediaType, THREE_D_RIGGED_COLLISION_MEDIA_TYPE);
  assert.equal(first.outputs.output.metadata.jointCount, 1);
  assert.equal(first.outputs.output.metadata.vertexCount, 8);
  assert.equal(first.outputs.output.metadata.proxyCount, 1);
  assert.equal(first.observations.assignedVertices, 8);
  assert.equal(first.observations.lowConfidenceVertices, 0);
  assert.equal(first.observations.representedVertices, 8);
  assert.equal(first.observations.proxyCount, 1);
  assert.deepEqual(first.observations.shapeCounts, {
    boxCount: 0,
    sphereCount: 0,
    capsuleCount: 1,
  });

  const output = JSON.parse((await resolveAssetObject(root, first.outputs.output)).toString("utf8"));
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.transformSpace, "joint-bind-local");
  assert.equal(output.capsuleAxis, "local-y");
  assert.equal(output.proxies[0].shape, "capsule");
  assert.equal(output.proxies[0].joint, 0);
});

test("rigged collision fitting fails closed on malformed source and parameters", async () => {
  const root = await workspace();
  const invalidDocument = sourceDocument();
  invalidDocument.influences[0] = {
    joints: [4, 0, 0, 0],
    weights: [1, 0, 0, 0],
  };
  const invalidSource = (
    await storeAssetObject(root, {
      bytes: Buffer.from(JSON.stringify(invalidDocument), "utf8"),
      kind: "rigged-mesh",
      mediaType: THREE_D_RIGGED_COLLISION_INPUT_MEDIA_TYPE,
      metadata: {},
    })
  ).asset;
  await assert.rejects(
    () =>
      executeMeshRiggedCollisionFitOperation(
        root,
        { parameters: parameters(), inputs: { source: invalidSource } },
        PROCESSOR,
      ),
    /outside the skeleton/,
  );

  const source = await storedSource(root);
  await assert.rejects(
    () =>
      executeMeshRiggedCollisionFitOperation(
        root,
        {
          parameters: { ...parameters(), capsuleAspectRatio: 1 },
          inputs: { source },
        },
        PROCESSOR,
      ),
    /capsuleAspectRatio must be greater than 1/,
  );
});
