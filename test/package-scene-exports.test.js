import test from "node:test";
import assert from "node:assert/strict";

test("package exports scene normalization and canonical GLB processing", async () => {
  const scene = await import("asset-tooling/operations/processing/scene");
  assert.equal(scene.SCENE_NORMALIZE_OPERATION.id, "scene.normalize");
  assert.equal(scene.SCENE_EXPORT_GLB_OPERATION.id, "scene.export.glb");
  assert.equal(scene.THREE_D_SCENE_MEDIA_TYPE, "application/vnd.moritzbrantner.three-d.scene+json");
  assert.equal(scene.GLB_MEDIA_TYPE, "model/gltf-binary");
});
