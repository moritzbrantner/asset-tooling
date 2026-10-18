import { test } from "node:test";
import assert from "node:assert/strict";
import { LOD_LEVELS, LOD_RATIOS, LOD_SWITCH_DISTANCE_HINTS, createLodAssetSpec } from "../src/lod-recipe.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";

test("LOD levels follow the owner's answer: about 50 % and 20 % (characters 25 %), with 15 m / 35 m hints", () => {
  assert.deepEqual([...LOD_LEVELS], ["lod1", "lod2"]);
  assert.deepEqual({ ...LOD_RATIOS.static }, { lod1: 0.5, lod2: 0.2 });
  assert.deepEqual({ ...LOD_RATIOS.character }, { lod1: 0.5, lod2: 0.25 });
  assert.deepEqual({ ...LOD_SWITCH_DISTANCE_HINTS }, { lod1: 15, lod2: 35 });
});

test("the LOD spec pins the recipe and the source and rejects out-of-range ratios", async () => {
  const script = await readBlenderRecipeSource("lod.py");
  const spec = createLodAssetSpec({ assetId: "lod.barrel.lod1", ratio: 0.5, scriptSha256: script.sha256, sourceSha256: "b".repeat(64), blenderVersion: script.blenderVersion });
  assert.deepEqual(Object.keys(spec.inputs).sort(), ["script", "source"]);
  for (const ratio of [0, 0.01, 1, 1.5]) {
    assert.throws(() => createLodAssetSpec({ assetId: "lod.x", ratio, scriptSha256: script.sha256, sourceSha256: "b".repeat(64), blenderVersion: script.blenderVersion }), /ratio/);
  }
});
