// Humanoid equipment (#517, docs/humanoid-equipment.md): the weapons, throwables, archery pieces and headwear build once
// as their own verified kit, every item with its grip frame and `humanoid-item` attachment, within the kit's limits.
// The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, readAssetBundleGltf, verifyAssetBundle } from "../../../src/asset-bundle.js";
import { validateHumanoidItemDescriptor } from "../../../src/humanoid-sockets.js";
import { EQUIPMENT_RELEASE, buildHumanoidEquipment } from "../../../scripts/build-humanoid-equipment.ts";
import { RANGER_ARCHERY, RANGER_HEADWEAR, RANGER_ITEM_ATTACHMENT, RANGER_THROWABLES, RANGER_WEAPONS } from "../../../scripts/humanoid-equipment.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";

const ITEMS = [...RANGER_WEAPONS, ...RANGER_ARCHERY, ...RANGER_HEADWEAR, ...RANGER_THROWABLES].map(({ key }) => key);

test("the equipment is one rolling release with a budget and the Ranger's item keys", () => {
  assert.equal(EQUIPMENT_RELEASE, "humanoid-equipment");
  assert.ok(KIT_BUDGETS[EQUIPMENT_RELEASE], "the release has a cost budget");
  assert.equal(new Set(ITEMS).size, ITEMS.length);
  for (const key of ITEMS) assert.match(key, /^equipment\./);
});

test("the recipe builds a verified equipment kit within its limits", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 900_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "humanoid-equipment-"));
  try {
    const built = await buildHumanoidEquipment({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    const throwables = RANGER_THROWABLES.map(({ key }) => key);
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(),
      [...ITEMS.map((key) => `${key}#default`), ...throwables.flatMap((key) => [`${key}#lod1`, `${key}#lod2`])].sort());
    assert.deepEqual(kitBudgetViolations(await kitCost(built.bundleDir), KIT_BUDGETS[EQUIPMENT_RELEASE]!), []);
    for (const key of ITEMS) {
      const item = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, key, "default", RANGER_ITEM_ATTACHMENT)).toString("utf8"));
      validateHumanoidItemDescriptor(item);
      assert.equal(item.item, key);
      // Every item's origin is its grip frame, and it ships no textures.
      const gltf = JSON.parse((await readAssetBundleGltf(built.bundleDir, manifest, key, "default")).gltf.toString("utf8"));
      assert.equal(gltf.images, undefined, `${key} has no textures`);
      if (throwables.includes(key)) assert.deepEqual(item.lods.levels.map((level: any) => level.variant), ["default", "lod1", "lod2"]);
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
