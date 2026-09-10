import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  THREE_D_MESH_MEDIA_TYPE,
  createMeshSimplifyOperationBuildIdentity,
  executeMeshSimplifyOperation,
} from "../src/processing-operations.js";

const [processorCheckout, revision, repository, manifestRelativePath, operation] = process.argv.slice(2);
if (!processorCheckout || !path.isAbsolute(processorCheckout)) {
  throw new Error("processor checkout must be an absolute path");
}
if (!/^[0-9a-f]{40}$/.test(revision ?? "")) {
  throw new Error("processor revision must be an exact lowercase Git commit SHA");
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
  throw new Error("processor repository must use owner/repository form");
}
if (
  !manifestRelativePath ||
  path.isAbsolute(manifestRelativePath) ||
  manifestRelativePath.includes("\\") ||
  manifestRelativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
) {
  throw new Error("processor manifest path must be a normalized portable relative path");
}
if (operation !== "mesh.simplify") {
  throw new Error("processor contract proof currently supports only mesh.simplify");
}

const manifestPath = path.join(processorCheckout, ...manifestRelativePath.split("/"));
const processor = {
  repository,
  revision,
  executable: "cargo",
  scriptPath: "run",
  prefixArguments: ["--quiet", "--manifest-path", manifestPath, "--"],
};

function gridMesh(segments) {
  const vertices = [];
  const indices = [];
  for (let y = 0; y <= segments; y += 1) {
    for (let x = 0; x <= segments; x += 1) {
      vertices.push([x / segments, y / segments, 0]);
    }
  }
  const stride = segments + 1;
  for (let y = 0; y < segments; y += 1) {
    for (let x = 0; x < segments; x += 1) {
      const topLeft = y * stride + x;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + stride;
      const bottomRight = bottomLeft + 1;
      indices.push(topLeft, topRight, bottomLeft, topRight, bottomRight, bottomLeft);
    }
  }
  return { schemaVersion: 1, vertices, indices };
}

const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-real-processor-"));
try {
  const sourceDocument = gridMesh(8);
  const sourceTriangleCount = sourceDocument.indices.length / 3;
  const sourceBytes = Buffer.from(JSON.stringify(sourceDocument), "utf8");
  const source = (
    await storeAssetObject(root, {
      bytes: sourceBytes,
      kind: "mesh",
      mediaType: THREE_D_MESH_MEDIA_TYPE,
      metadata: {
        meshSchemaVersion: 1,
        triangleCount: sourceTriangleCount,
        vertexCount: sourceDocument.vertices.length,
      },
    })
  ).asset;
  const invocation = {
    parameters: {
      sourceTriangleCount,
      targetTriangleCount: Math.floor(sourceTriangleCount / 2),
      targetError: 1,
      lockBorder: false,
    },
    inputs: { source },
  };

  const identity = await createMeshSimplifyOperationBuildIdentity(root, invocation, processor);
  assert.deepEqual(identity.operation, { id: operation, version: "1" });
  assert.deepEqual(identity.implementation.source, { repository, revision });
  assert.equal(identity.implementation.probe.id, "three-d-lod");
  assert.equal(identity.implementation.probe.algorithm, "meshopt-0.6.2");
  assert.equal(identity.implementation.probe.protocol, "asset-tooling-process-adapter-v1");
  assert.equal(identity.implementation.probe.codec, "three-d-mesh-json-v1");
  assert.equal(identity.implementation.probe.dependencies.meshopt, "0.6.2");
  assert.match(identity.implementation.probe.cargoLock, /name = "meshopt"/);
  assert.match(identity.implementation.probe.cargoLock, /version = "0\.6\.2"/);
  assert.match(identity.implementation.probe.cargoLock, /name = "serde_json"/);

  const first = await executeMeshSimplifyOperation(root, invocation, processor);
  const second = await executeMeshSimplifyOperation(root, invocation, processor);
  assert.equal(second.outputs.output.sha256, first.outputs.output.sha256);
  assert.deepEqual(second.observations, first.observations);
  assert.equal(first.observations.sourceTriangleCount, sourceTriangleCount);
  assert.equal(first.observations.requestedTriangleCount, invocation.parameters.targetTriangleCount);
  assert.ok(first.observations.resultTriangleCount <= sourceTriangleCount);
  assert.equal(
    first.observations.resultIndexCount,
    first.observations.resultTriangleCount * 3,
  );
  assert.ok(first.observations.relativeError <= invocation.parameters.targetError);
  assert.equal(first.observations.sharedSourceVertexBuffer, true);

  const outputBytes = await resolveAssetObject(root, first.outputs.output);
  const output = JSON.parse(outputBytes.toString("utf8"));
  assert.equal(output.schemaVersion, 1);
  assert.deepEqual(output.vertices, sourceDocument.vertices);
  assert.equal(output.indices.length, first.observations.resultIndexCount);

  console.log(
    JSON.stringify({
      status: "processor-contract-valid",
      processor: identity.implementation.source,
      algorithm: identity.implementation.probe.algorithm,
      codec: identity.implementation.probe.codec,
      inputSha256: source.sha256,
      outputSha256: first.outputs.output.sha256,
      sourceTriangleCount,
      resultTriangleCount: first.observations.resultTriangleCount,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
