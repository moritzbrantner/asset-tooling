import test from "node:test";
import assert from "node:assert/strict";
import {
  PRODUCTION_PROP_COLLISION_PRESETS,
  PRODUCTION_PROP_MATERIAL_POLICY,
  PRODUCTION_PROP_VISUAL_SOURCE_CANDIDATES,
  getProductionPropCollisionPreset,
} from "../src/production-prop-kit.js";

test("production prop kit covers the first reusable environment asset families", () => {
  assert.deepEqual(Object.keys(PRODUCTION_PROP_COLLISION_PRESETS), [
    "barrel",
    "barricade",
    "box",
    "crate",
    "door",
    "wall",
    "window",
  ]);
  assert.deepEqual(PRODUCTION_PROP_VISUAL_SOURCE_CANDIDATES, [
    "quaternius.fantasy-props-megakit-standard",
    "quaternius.medieval-village-megakit-standard",
  ]);
});

test("collision presets prefer simple or compound primitives instead of render-mesh collision", () => {
  assert.equal(getProductionPropCollisionPreset("barrel").proxies[0]?.shape, "capsule");
  assert.equal(getProductionPropCollisionPreset("crate").proxies.length, 1);
  assert.equal(getProductionPropCollisionPreset("crate").proxies[0]?.shape, "box");
  assert.equal(getProductionPropCollisionPreset("barricade").proxies.length, 6);
  assert.equal(getProductionPropCollisionPreset("wall").proxies.length, 1);
  assert.equal(getProductionPropCollisionPreset("window").proxies.length, 4);
});

test("doors separate the moving leaf from the frame and windows keep their opening free", () => {
  const door = getProductionPropCollisionPreset("door");
  assert.deepEqual(new Set(door.proxies.map((proxy) => proxy.target)), new Set(["door-frame", "door-leaf"]));

  const window = getProductionPropCollisionPreset("window");
  assert.equal(window.proxies.every((proxy) => proxy.shape === "box"), true);
  assert.equal(
    window.proxies.some((proxy) => proxy.center[0] === "0" && proxy.center[1] === "1.25"),
    false,
  );
});

test("material policy preserves artist-authored UV and texture semantics without fabricated channels", () => {
  assert.equal(PRODUCTION_PROP_MATERIAL_POLICY.model, "pbr-metallic-roughness");
  assert.equal(PRODUCTION_PROP_MATERIAL_POLICY.sourceUvPolicy, "preserve-explicit-source-uvs");
  assert.equal(PRODUCTION_PROP_MATERIAL_POLICY.textureMappingPolicy, "explicit-semantic-mapping");
  assert.equal(PRODUCTION_PROP_MATERIAL_POLICY.missingChannelPolicy, "do-not-fabricate-pbr-semantics");
  assert.equal(PRODUCTION_PROP_MATERIAL_POLICY.lineagePolicy, "preserve-source-texture-hashes");
});
