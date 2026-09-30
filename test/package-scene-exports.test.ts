import test from "node:test";
import assert from "node:assert/strict";

test("package exports scene normalization and canonical GLB processing", async () => {
  const scene = await import("asset-tooling/operations/processing/scene");
  assert.equal(scene.SCENE_NORMALIZE_OPERATION.id, "scene.normalize");
  assert.equal(scene.SCENE_EXPORT_GLB_OPERATION.id, "scene.export.glb");
  assert.equal(scene.THREE_D_SCENE_MEDIA_TYPE, "application/vnd.moritzbrantner.three-d.scene+json");
  assert.equal(scene.GLB_MEDIA_TYPE, "model/gltf-binary");
  const gltf = await import("asset-tooling/operations/processing/gltf");
  assert.equal(gltf.GLTF_IMPORT_OPERATION.id, "scene.import.gltf");
  const material = await import("asset-tooling/operations/processing/gltf-material");
  assert.equal(material.GLTF_BASE_COLOR_OPERATION.id, "scene.material.base-color");
  const production = await import("asset-tooling/operations/processing/gltf-production");
  assert.equal(production.GLTF_PRODUCTION_IMPORT_OPERATION.version, "2");
  assert.equal(production.GLTF_ANALYZE_OPERATION.id, "scene.analyze.gltf");
});
