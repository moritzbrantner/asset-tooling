import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  MESH_SIMPLIFY_OPERATION,
  THREE_D_MESH_MEDIA_TYPE,
  createMeshSimplifyOperationBuildIdentity,
  executeMeshSimplifyOperation,
} from "../src/processing-operations.js";

const FIXTURE_ADAPTER = fileURLToPath(new URL("./fixtures/mesh-process-adapter.js", import.meta.url));
const PROCESSOR = {
  repository: "fixture/three-d-lod",
  revision: "f".repeat(40),
  executable: process.execPath,
  scriptPath: FIXTURE_ADAPTER,
  prefixArguments: [],
};
const PARAMETERS = {
  sourceTriangleCount: 8,
  targetTriangleCount: 4,
  targetError: 1,
  lockBorder: false,
};

function meshDocument() {
  return {
    schemaVersion: 1,
    vertices: [
      [0, 0, 0], [1, 0, 0], [2, 0, 0],
      [0, 1, 0], [1, 1, 0], [2, 1, 0],
      [0, 2, 0], [1, 2, 0], [2, 2, 0],
    ],
    indices: [
      0, 1, 3, 1, 4, 3,
      1, 2, 4, 2, 5, 4,
      3, 4, 6, 4, 7, 6,
      4, 5, 7, 5, 8, 7,
    ],
  };
}

async function workspaceWithSource() {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-mesh-operation-"));
  const bytes = Buffer.from(JSON.stringify(meshDocument()), "utf8");
  const stored = await storeAssetObject(root, {
    bytes,
    kind: "mesh",
    mediaType: THREE_D_MESH_MEDIA_TYPE,
    metadata: { meshSchemaVersion: 1, triangleCount: 8, vertexCount: 9 },
  });
  return { root, source: stored.asset };
}

test("mesh.simplify exposes one typed mesh input and output", () => {
  assert.equal(MESH_SIMPLIFY_OPERATION.id, "mesh.simplify");
  assert.equal(MESH_SIMPLIFY_OPERATION.version, "1");
  assert.deepEqual(MESH_SIMPLIFY_OPERATION.inputs[0].assetKinds, ["mesh"]);
  assert.deepEqual(MESH_SIMPLIFY_OPERATION.inputs[0].mediaTypes, [THREE_D_MESH_MEDIA_TYPE]);
  assert.deepEqual(MESH_SIMPLIFY_OPERATION.outputs[0].mediaTypes, [THREE_D_MESH_MEDIA_TYPE]);
});

test("mesh.simplify build identity records semantic processor identity, not checkout paths", async () => {
  const { root, source } = await workspaceWithSource();
  const identity = await createMeshSimplifyOperationBuildIdentity(
    root,
    { parameters: PARAMETERS, inputs: { source } },
    PROCESSOR,
  );

  assert.deepEqual(identity.operation, { id: "mesh.simplify", version: "1" });
  assert.equal(identity.inputs.source.sha256, source.sha256);
  assert.deepEqual(identity.implementation.source, {
    repository: "fixture/three-d-lod",
    revision: "f".repeat(40),
  });
  assert.equal(identity.implementation.probe.protocol, "asset-tooling-process-adapter-v1");
  assert.equal(identity.implementation.probe.codec, "three-d-mesh-json-v1");
  assert.equal(identity.implementation.probe.cargoLock, "fixture-lock-v1");
  assert.equal(JSON.stringify(identity).includes(FIXTURE_ADAPTER), false);
});

test("mesh.simplify resolves a stored input and stores a validated derived mesh", async () => {
  const { root, source } = await workspaceWithSource();
  const first = await executeMeshSimplifyOperation(
    root,
    { parameters: PARAMETERS, inputs: { source } },
    PROCESSOR,
  );
  const second = await executeMeshSimplifyOperation(
    root,
    { parameters: PARAMETERS, inputs: { source } },
    PROCESSOR,
  );

  assert.equal(first.outputs.output.kind, "mesh");
  assert.equal(first.outputs.output.mediaType, THREE_D_MESH_MEDIA_TYPE);
  assert.equal(first.outputs.output.metadata.triangleCount, 4);
  assert.equal(first.outputs.output.metadata.sourceVertexCount, 9);
  assert.equal(first.outputs.output.metadata.vertexCount, undefined);
  assert.equal(first.outputs.output.metadata.sourceVertexBufferPreserved, true);
  assert.equal(second.outputs.output.sha256, first.outputs.output.sha256);
  assert.deepEqual(second.observations, first.observations);
  assert.deepEqual(first.observations, {
    sourceTriangleCount: 8,
    sourceVertexCount: 9,
    requestedTriangleCount: 4,
    resultTriangleCount: 4,
    resultIndexCount: 12,
    relativeError: 0,
    sharedSourceVertexBuffer: true,
  });

  const output = JSON.parse((await resolveAssetObject(root, first.outputs.output)).toString("utf8"));
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.vertices.length, 9);
  assert.equal(output.indices.length, 12);
});

test("mesh.simplify validates parameters before invoking a processor", async () => {
  const { root, source } = await workspaceWithSource();
  await assert.rejects(
    () =>
      executeMeshSimplifyOperation(
        root,
        {
          parameters: { ...PARAMETERS, targetTriangleCount: 9 },
          inputs: { source },
        },
        PROCESSOR,
      ),
    /targetTriangleCount must not exceed sourceTriangleCount/,
  );
  await assert.rejects(
    () =>
      executeMeshSimplifyOperation(
        root,
        {
          parameters: { ...PARAMETERS, surprise: true },
          inputs: { source },
        },
        PROCESSOR,
      ),
    /does not accept parameter 'surprise'/,
  );
});
