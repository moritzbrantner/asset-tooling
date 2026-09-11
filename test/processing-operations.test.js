import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { sha256Bytes } from "../src/hash.js";
import {
  MESH_LOD_CHAIN_OPERATION,
  MESH_SIMPLIFY_OPERATION,
  THREE_D_LOD_CHAIN_MEDIA_TYPE,
  THREE_D_MESH_MEDIA_TYPE,
  createMeshLodChainOperationBuildIdentity,
  createMeshSimplifyOperationBuildIdentity,
  executeMeshLodChainOperation,
  executeMeshSimplifyOperation,
} from "../src/processing-operations.js";

const FIXTURE_ADAPTER = fileURLToPath(new URL("./fixtures/mesh-process-adapter.js", import.meta.url));
const LOD_FIXTURE_ADAPTER = fileURLToPath(
  new URL("./fixtures/lod-chain-process-adapter.js", import.meta.url),
);
const PROCESSOR = {
  repository: "fixture/three-d-lod",
  revision: "f".repeat(40),
  executable: process.execPath,
  scriptPath: FIXTURE_ADAPTER,
  prefixArguments: [],
};
const LOD_PROCESSOR = {
  repository: "fixture/three-d-lod",
  revision: "e".repeat(40),
  executable: process.execPath,
  scriptPath: LOD_FIXTURE_ADAPTER,
  prefixArguments: [],
};
const PARAMETERS = {
  sourceTriangleCount: 8,
  targetTriangleCount: 4,
  targetError: 1,
  lockBorder: false,
};
const LOD_PARAMETERS = {
  sourceTriangleCount: 8,
  sourceBased: true,
  budgetRounding: "nearest-ties-away-from-zero",
  levels: [
    { triangleRatio: 0.75, targetTriangleCount: 6, targetError: 1, lockBorder: false },
    { triangleRatio: 0.5, targetTriangleCount: 4, targetError: 1, lockBorder: false },
    { triangleRatio: 0.25, targetTriangleCount: 2, targetError: 1, lockBorder: false },
  ],
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

function indexHash(indices) {
  const bytes = Buffer.alloc(indices.length * 4);
  indices.forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
  return sha256Bytes(bytes);
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

test("mesh.lod_chain exposes a source mesh and an ordered LOD bundle", () => {
  assert.equal(MESH_LOD_CHAIN_OPERATION.id, "mesh.lod_chain");
  assert.equal(MESH_LOD_CHAIN_OPERATION.version, "1");
  assert.deepEqual(MESH_LOD_CHAIN_OPERATION.inputs[0].assetKinds, ["mesh"]);
  assert.deepEqual(MESH_LOD_CHAIN_OPERATION.inputs[0].mediaTypes, [THREE_D_MESH_MEDIA_TYPE]);
  assert.deepEqual(MESH_LOD_CHAIN_OPERATION.outputs[0].assetKinds, ["lod-chain"]);
  assert.deepEqual(MESH_LOD_CHAIN_OPERATION.outputs[0].mediaTypes, [THREE_D_LOD_CHAIN_MEDIA_TYPE]);
});

test("mesh.lod_chain build identity binds the exact external processor revision", async () => {
  const { root, source } = await workspaceWithSource();
  const identity = await createMeshLodChainOperationBuildIdentity(
    root,
    { parameters: LOD_PARAMETERS, inputs: { source } },
    LOD_PROCESSOR,
  );

  assert.deepEqual(identity.operation, { id: "mesh.lod_chain", version: "1" });
  assert.equal(identity.inputs.source.sha256, source.sha256);
  assert.deepEqual(identity.implementation.source, {
    repository: "fixture/three-d-lod",
    revision: "e".repeat(40),
  });
  assert.equal(identity.implementation.probe.id, "three-d-lod-chain");
  assert.equal(identity.implementation.probe.codec, "three-d-lod-chain-json-v1");
  assert.equal(identity.implementation.probe.protocol, "asset-tooling-process-adapter-v1");
  assert.equal(JSON.stringify(identity).includes(LOD_FIXTURE_ADAPTER), false);
});

test("mesh.lod_chain stores a deterministic source-based bundle with per-level index hashes", async () => {
  const { root, source } = await workspaceWithSource();
  const first = await executeMeshLodChainOperation(
    root,
    { parameters: LOD_PARAMETERS, inputs: { source } },
    LOD_PROCESSOR,
  );
  const second = await executeMeshLodChainOperation(
    root,
    { parameters: LOD_PARAMETERS, inputs: { source } },
    LOD_PROCESSOR,
  );

  assert.equal(first.outputs.output.kind, "lod-chain");
  assert.equal(first.outputs.output.mediaType, THREE_D_LOD_CHAIN_MEDIA_TYPE);
  assert.deepEqual(first.outputs.output.metadata, {
    levelCount: 3,
    lodSchemaVersion: 1,
    sourceTriangleCount: 8,
    sourceVertexBufferPreserved: true,
    sourceVertexCount: 9,
  });
  assert.equal(second.outputs.output.sha256, first.outputs.output.sha256);
  assert.deepEqual(second.observations, first.observations);
  assert.deepEqual(
    first.observations.levels.map((level) => ({
      level: level.level,
      requestedTriangleCount: level.requestedTriangleCount,
      resultTriangleCount: level.resultTriangleCount,
      resultIndexCount: level.resultIndexCount,
      indexSha256: level.indexSha256,
    })),
    [6, 4, 2].map((triangleCount, index) => ({
      level: index + 1,
      requestedTriangleCount: triangleCount,
      resultTriangleCount: triangleCount,
      resultIndexCount: triangleCount * 3,
      indexSha256: indexHash(meshDocument().indices.slice(0, triangleCount * 3)),
    })),
  );

  const output = JSON.parse((await resolveAssetObject(root, first.outputs.output)).toString("utf8"));
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.sourceVertices.length, 9);
  assert.deepEqual(output.levels.map((level) => level.indices.length), [18, 12, 6]);
});

test("mesh.lod_chain rejects non-source-based and non-decreasing level contracts before processor execution", async () => {
  const { root, source } = await workspaceWithSource();
  await assert.rejects(
    () =>
      executeMeshLodChainOperation(
        root,
        {
          parameters: { ...LOD_PARAMETERS, sourceBased: false },
          inputs: { source },
        },
        LOD_PROCESSOR,
      ),
    /sourceBased must be true/,
  );
  await assert.rejects(
    () =>
      executeMeshLodChainOperation(
        root,
        {
          parameters: {
            ...LOD_PARAMETERS,
            levels: [
              LOD_PARAMETERS.levels[0],
              { ...LOD_PARAMETERS.levels[1], targetTriangleCount: 6 },
            ],
          },
          inputs: { source },
        },
        LOD_PROCESSOR,
      ),
    /targetTriangleCount values must be strictly decreasing/,
  );
});
