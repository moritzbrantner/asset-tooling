import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { storeAssetObject } from "../src/asset-store.js";
import {
  THREE_D_MESH_MEDIA_TYPE,
  createMeshLodChainOperationBuildIdentity,
  executeMeshLodChainOperation,
} from "../src/processing-operations.js";

const LOD_FIXTURE_ADAPTER = fileURLToPath(
  new URL("./fixtures/lod-chain-process-adapter.js", import.meta.url),
);
const LOD_PROCESSOR = {
  repository: "fixture/three-d-lod",
  revision: "e".repeat(40),
  executable: process.execPath,
  scriptPath: LOD_FIXTURE_ADAPTER,
  prefixArguments: [],
};

function repeatedTriangleMesh(triangleCount, vertexCount = 3) {
  const vertices = Array.from({ length: vertexCount }, (_, index) => [index, 0, 0]);
  const triangle = vertexCount >= 3 ? [0, 1, 2] : [0, 1, 0];
  return {
    schemaVersion: 1,
    vertices,
    indices: Array.from({ length: triangleCount }, () => triangle).flat(),
  };
}

async function workspaceWithMesh(document) {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-lod-contract-"));
  const bytes = Buffer.from(JSON.stringify(document), "utf8");
  const stored = await storeAssetObject(root, {
    bytes,
    kind: "mesh",
    mediaType: THREE_D_MESH_MEDIA_TYPE,
    metadata: {
      meshSchemaVersion: 1,
      triangleCount: document.indices.length / 3,
      vertexCount: document.vertices.length,
    },
  });
  return { root, source: stored.asset };
}

test("mesh.lod_chain materializes ratio budgets from exact decimal values", async () => {
  const { root, source } = await workspaceWithMesh(repeatedTriangleMesh(25));
  const parameters = {
    sourceTriangleCount: 25,
    sourceBased: true,
    budgetRounding: "nearest-ties-away-from-zero",
    levels: [
      {
        triangleRatio: 0.58,
        targetTriangleCount: 15,
        targetError: 1,
        lockBorder: false,
      },
    ],
  };

  const identity = await createMeshLodChainOperationBuildIdentity(
    root,
    { parameters, inputs: { source } },
    LOD_PROCESSOR,
  );
  assert.equal(identity.parameters.levels[0].targetTriangleCount, 15);

  await assert.rejects(
    () =>
      createMeshLodChainOperationBuildIdentity(
        root,
        {
          parameters: {
            ...parameters,
            levels: [{ ...parameters.levels[0], targetTriangleCount: 14 }],
          },
          inputs: { source },
        },
        LOD_PROCESSOR,
      ),
    /materialized ratio budget 15/,
  );
});

test("mesh.lod_chain rejects receipt-incompatible source vertex observations", async () => {
  const { root, source } = await workspaceWithMesh(repeatedTriangleMesh(2, 2));
  await assert.rejects(
    () =>
      executeMeshLodChainOperation(
        root,
        {
          parameters: {
            sourceTriangleCount: 2,
            sourceBased: true,
            budgetRounding: "nearest-ties-away-from-zero",
            levels: [
              {
                triangleRatio: 0.5,
                targetTriangleCount: 1,
                targetError: 1,
                lockBorder: false,
              },
            ],
          },
          inputs: { source },
        },
        LOD_PROCESSOR,
      ),
    /sourceVertexCount must be at least 3/,
  );
});
