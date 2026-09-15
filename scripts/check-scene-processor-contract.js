import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  GLB_MEDIA_TYPE,
  THREE_D_SCENE_MEDIA_TYPE,
  createSceneExportGlbOperationBuildIdentity,
  createSceneNormalizeOperationBuildIdentity,
  executeSceneExportGlbOperation,
  executeSceneNormalizeOperation,
} from "../src/scene-processing-operations.js";

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
  manifestRelativePath
    .split("/")
    .some((segment) => segment === "" || segment === "." || segment === "..")
) {
  throw new Error("processor manifest path must be a normalized portable relative path");
}
if (operation !== "scene.normalize" && operation !== "scene.export.glb") {
  throw new Error("scene processor contract proof supports scene.normalize and scene.export.glb");
}

const manifestPath = path.join(processorCheckout, ...manifestRelativePath.split("/"));
const fetchProcess = Bun.spawn(["cargo", "fetch", "--manifest-path", manifestPath], {
  cwd: processorCheckout,
  stdout: "inherit",
  stderr: "inherit",
});
if ((await fetchProcess.exited) !== 0) {
  throw new Error("explicit processor dependency acquisition failed");
}

const prefixArguments = ["--quiet", "--offline", "--manifest-path", manifestPath];
if (operation === "scene.export.glb") prefixArguments.push("--bin", "scene_export_glb");
prefixArguments.push("--");
const processor = {
  repository,
  revision,
  executable: "cargo",
  scriptPath: "run",
  prefixArguments,
  checkoutRoot: processorCheckout,
};
const verifiedSource = { repository, revision, verification: "git-clean-exact-head" };

function sceneDocument() {
  return {
    schemaVersion: 1,
    coordinateSystem: "right-handed-y-up",
    unit: "centimeter",
    meshes: [
      {
        id: "z-mesh",
        vertices: [
          [999, 999, 999],
          [-0, 0, 0],
          [100, 0, 0],
          [0, 100, 0],
        ],
        indices: [1, 2, 3],
        normals: [
          [0, 0, 1],
          [0, 0, 1],
          [0, 0, 1],
          [0, 0, 1],
        ],
      },
      {
        id: "a-mesh",
        vertices: [
          [0, 0, 0],
          [50, 0, 0],
          [0, 50, 0],
        ],
        indices: [0, 1, 2],
      },
    ],
    nodes: [
      {
        id: "z-child",
        parent: "z-root",
        mesh: null,
        translation: [0, 25, 0],
        rotation: [0, -1, 0, 0],
        scale: [1, 1, 1],
      },
      {
        id: "a-root",
        parent: null,
        mesh: "a-mesh",
        translation: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      {
        id: "z-root",
        parent: null,
        mesh: "z-mesh",
        translation: [200, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    ],
  };
}

async function storedSceneSource(root) {
  const source = (
    await storeAssetObject(root, {
      bytes: Buffer.from(JSON.stringify(sceneDocument()), "utf8"),
      kind: "scene",
      mediaType: THREE_D_SCENE_MEDIA_TYPE,
      metadata: { sceneSchemaVersion: 1 },
    })
  ).asset;
  return source;
}

function assertRuntime(identity) {
  assert.deepEqual(identity.implementation.source, verifiedSource);
  assert.equal(identity.implementation.runtime.kind, "cargo-rust-v1");
  assert.match(identity.implementation.runtime.cargo, /^cargo 1\.98\.1/m);
  assert.match(identity.implementation.runtime.rustc, /^rustc 1\.98\.1/m);
  assert.equal(identity.implementation.probe.protocol, "asset-tooling-process-adapter-v1");
  assert.equal(identity.implementation.probe.dependencies.threeDScene, "0.1.0");
  assert.equal(identity.implementation.probe.dependencies.threeDExport, "0.1.0");
  assert.match(identity.implementation.probe.cargoLock, /name = "three-d-scene"/);
  assert.match(identity.implementation.probe.cargoLock, /name = "three-d-export"/);
}

async function checkNormalize(root) {
  const source = await storedSceneSource(root);
  const invocation = { parameters: {}, inputs: { source } };
  const identity = await createSceneNormalizeOperationBuildIdentity(root, invocation, processor);
  assert.deepEqual(identity.operation, { id: operation, version: "1" });
  assertRuntime(identity);
  assert.equal(identity.implementation.probe.id, "three-d-scene-normalize");
  assert.equal(identity.implementation.probe.algorithm, "three-d-scene-normalize-v1");
  assert.equal(identity.implementation.probe.codec, "three-d-scene-json-v1");

  const first = await executeSceneNormalizeOperation(root, invocation, processor);
  const second = await executeSceneNormalizeOperation(root, invocation, processor);
  assert.equal(second.outputs.output.sha256, first.outputs.output.sha256);
  assert.deepEqual(second.observations, first.observations);
  assert.equal(first.outputs.output.kind, "scene");
  assert.equal(first.outputs.output.mediaType, THREE_D_SCENE_MEDIA_TYPE);
  assert.equal(first.observations.sourceUnit, "centimeter");
  assert.equal(first.observations.outputUnit, "meter");
  assert.equal(first.observations.sourceVertexCount, 7);
  assert.equal(first.observations.resultVertexCount, 6);
  assert.equal(first.observations.removedUnusedVertexCount, 1);
  assert.equal(first.observations.triangleCount, 2);

  const output = JSON.parse((await resolveAssetObject(root, first.outputs.output)).toString("utf8"));
  assert.equal(output.unit, "meter");
  assert.deepEqual(output.meshes.map((mesh) => mesh.id), ["a-mesh", "z-mesh"]);
  assert.deepEqual(output.nodes.map((node) => node.id), ["a-root", "z-root", "z-child"]);
  assert.deepEqual(output.nodes[1].translation, [2, 0, 0]);
  assert.deepEqual(output.nodes[2].translation, [0, 0.25, 0]);
  assert.deepEqual(output.nodes[2].rotation, [0, 1, 0, 0]);
  assert.deepEqual(output.meshes[1].indices, [0, 1, 2]);

  return {
    status: "processor-contract-valid",
    processor: identity.implementation.source,
    runtime: identity.implementation.runtime,
    algorithm: identity.implementation.probe.algorithm,
    codec: identity.implementation.probe.codec,
    inputSha256: source.sha256,
    outputSha256: first.outputs.output.sha256,
    resultVertexCount: first.observations.resultVertexCount,
    triangleCount: first.observations.triangleCount,
  };
}

async function checkExport(root) {
  const source = await storedSceneSource(root);
  const invocation = { parameters: {}, inputs: { source } };
  const identity = await createSceneExportGlbOperationBuildIdentity(root, invocation, processor);
  assert.deepEqual(identity.operation, { id: operation, version: "1" });
  assertRuntime(identity);
  assert.equal(identity.implementation.probe.id, "three-d-scene-export-glb");
  assert.equal(identity.implementation.probe.algorithm, "three-d-export-glb-v1");
  assert.equal(identity.implementation.probe.codec, "gltf-binary-v2");

  const first = await executeSceneExportGlbOperation(root, invocation, processor);
  const second = await executeSceneExportGlbOperation(root, invocation, processor);
  assert.equal(second.outputs.output.sha256, first.outputs.output.sha256);
  assert.deepEqual(second.observations, first.observations);
  assert.equal(first.outputs.output.kind, "scene");
  assert.equal(first.outputs.output.mediaType, GLB_MEDIA_TYPE);
  assert.equal(first.observations.meshCount, 2);
  assert.equal(first.observations.nodeCount, 3);
  assert.equal(first.observations.vertexCount, 6);
  assert.equal(first.observations.triangleCount, 2);
  assert.equal(first.observations.unit, "meter");
  assert.equal(first.observations.format, "glb-2.0");
  assert.equal(first.observations.normalizedBeforeExport, true);

  const bytes = await resolveAssetObject(root, first.outputs.output);
  assert.equal(bytes.toString("ascii", 0, 4), "glTF");
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);

  return {
    status: "processor-contract-valid",
    processor: identity.implementation.source,
    runtime: identity.implementation.runtime,
    algorithm: identity.implementation.probe.algorithm,
    codec: identity.implementation.probe.codec,
    inputSha256: source.sha256,
    outputSha256: first.outputs.output.sha256,
    byteLength: bytes.length,
    vertexCount: first.observations.vertexCount,
    triangleCount: first.observations.triangleCount,
  };
}

const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-real-scene-processor-"));
try {
  const result =
    operation === "scene.normalize" ? await checkNormalize(root) : await checkExport(root);
  console.log(JSON.stringify(result));
} finally {
  await rm(root, { recursive: true, force: true });
}
