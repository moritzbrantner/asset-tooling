import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  GLB_MEDIA_TYPE,
  SCENE_EXPORT_GLB_OPERATION,
  SCENE_NORMALIZE_OPERATION,
  THREE_D_SCENE_MEDIA_TYPE,
  createSceneExportGlbOperationBuildIdentity,
  createSceneNormalizeOperationBuildIdentity,
  executeSceneExportGlbOperation,
  executeSceneNormalizeOperation,
} from "../src/scene-processing-operations.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/scene-process-adapter.js", import.meta.url));
const REVISION = "3333333333333333333333333333333333333333";
const PROCESSOR = {
  repository: "moritzbrantner/3d-lab",
  revision: REVISION,
  executable: process.execPath,
  scriptPath: FIXTURE,
  prefixArguments: [],
  sourceFiles: [FIXTURE],
};

function sourceDocument() {
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

async function workspaceWithScene(document = sourceDocument()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-scene-"));
  const stored = await storeAssetObject(root, {
    bytes: Buffer.from(JSON.stringify(document), "utf8"),
    kind: "scene",
    mediaType: THREE_D_SCENE_MEDIA_TYPE,
    metadata: { sceneSchemaVersion: 1 },
  });
  return { root, source: stored.asset };
}

test("scene normalization and export descriptors expose focused typed boundaries", () => {
  assert.equal(SCENE_NORMALIZE_OPERATION.id, "scene.normalize");
  assert.equal(SCENE_NORMALIZE_OPERATION.inputs[0].assetKinds[0], "scene");
  assert.equal(SCENE_NORMALIZE_OPERATION.outputs[0].mediaTypes[0], THREE_D_SCENE_MEDIA_TYPE);
  assert.equal(SCENE_EXPORT_GLB_OPERATION.id, "scene.export.glb");
  assert.equal(SCENE_EXPORT_GLB_OPERATION.outputs[0].assetKinds[0], "scene");
  assert.equal(SCENE_EXPORT_GLB_OPERATION.outputs[0].mediaTypes[0], GLB_MEDIA_TYPE);
});

test("scene normalization build identity binds source and exact processor evidence", async () => {
  const { root, source } = await workspaceWithScene();
  try {
    const identity = await createSceneNormalizeOperationBuildIdentity(
      root,
      { parameters: {}, inputs: { source } },
      PROCESSOR,
    );
    assert.deepEqual(identity.operation, { id: "scene.normalize", version: "1" });
    assert.equal(identity.implementation.id, "three-d-scene-normalize");
    assert.equal(identity.implementation.source.revision, REVISION);
    assert.equal(identity.implementation.probe.algorithm, "three-d-scene-normalize-v1");
    assert.equal(identity.implementation.probe.codec, "three-d-scene-json-v1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scene normalization is content-addressed, idempotent, and emits canonical meter-space mechanics", async () => {
  const { root, source } = await workspaceWithScene();
  try {
    const invocation = { parameters: {}, inputs: { source } };
    const first = await executeSceneNormalizeOperation(root, invocation, PROCESSOR);
    const second = await executeSceneNormalizeOperation(root, invocation, PROCESSOR);
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
    assert.equal(output.meshes[1].vertices.length, 3);
    assert.deepEqual(output.meshes[1].indices, [0, 1, 2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical GLB export is deterministic and carries normalized scene evidence", async () => {
  const { root, source } = await workspaceWithScene();
  try {
    const invocation = { parameters: {}, inputs: { source } };
    const identity = await createSceneExportGlbOperationBuildIdentity(root, invocation, PROCESSOR);
    assert.equal(identity.implementation.id, "three-d-scene-export-glb");
    assert.equal(identity.implementation.probe.algorithm, "three-d-export-glb-v1");

    const first = await executeSceneExportGlbOperation(root, invocation, PROCESSOR);
    const second = await executeSceneExportGlbOperation(root, invocation, PROCESSOR);
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scene processing fails closed on unknown parameters and invalid source profile", async () => {
  const { root, source } = await workspaceWithScene();
  try {
    await assert.rejects(
      executeSceneNormalizeOperation(root, { parameters: { hidden: true }, inputs: { source } }, PROCESSOR),
      /unknown field 'hidden'/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const invalid = sourceDocument();
  invalid.coordinateSystem = "left-handed-y-up";
  const workspace = await workspaceWithScene(invalid);
  try {
    await assert.rejects(
      executeSceneNormalizeOperation(
        workspace.root,
        { parameters: {}, inputs: { source: workspace.source } },
        PROCESSOR,
      ),
      /coordinateSystem/,
    );
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});
