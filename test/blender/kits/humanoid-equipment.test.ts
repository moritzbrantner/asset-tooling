// Humanoid equipment (#517, docs/humanoid-equipment.md): the weapons, throwables, archery pieces and headwear build once
// as their own verified kit, every item with its grip frame and `humanoid-item` attachment, within the kit's limits.
// The item checks moved here from the Ranger test when the figures dropped their copies.
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
import { RANGER_ARCHERY, RANGER_HEADWEAR, RANGER_HELD_ITEMS, RANGER_ITEM_ATTACHMENT, RANGER_THROWABLES, RANGER_TINKER_ITEMS, RANGER_WEAPONS, SOCKET_ROLES, rangerItemDescriptor } from "../../../scripts/humanoid-equipment.ts";
import { WEAPON_ROLES } from "../../../src/weapon-recipes.js";
import { ARCHERY_ROLES } from "../../../src/archery-recipes.js";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";

const ITEMS = [...RANGER_WEAPONS, ...RANGER_ARCHERY, ...RANGER_HEADWEAR, ...RANGER_THROWABLES, ...RANGER_HELD_ITEMS, ...RANGER_TINKER_ITEMS].map(({ key }) => key);

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
      [...ITEMS.map((key) => `${key}#default`), ...throwables.flatMap((key) => [`${key}#lod1`, `${key}#lod2`]),
        ...RANGER_TINKER_ITEMS.flatMap(({ key, variants }) => variants.slice(1).map(({ variant }) => `${key}#${variant}`))].sort());
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
    // Weapons are separate, unskinned, unanimated entries; the consumer parents them via the sockets.
    for (const { key, piece } of RANGER_WEAPONS) {
      const weapon = manifest.assets.find((candidate) => candidate.key === key)!;
      assert.equal(weapon.observations.skins, 0, key);
      assert.deepEqual(weapon.observations.animations, [], key);
      assert.ok(weapon.observations.triangles > 0, key);
      // Each item ships its humanoid-item-v2 descriptor (#264): its role and its identity `grip` frame.
      assert.deepEqual(weapon.attachments.map((attachment: any) => attachment.name), [RANGER_ITEM_ATTACHMENT], key);
      const item = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, key, "default", RANGER_ITEM_ATTACHMENT)).toString("utf8"));
      assert.deepEqual(item, rangerItemDescriptor(key, WEAPON_ROLES[piece]), key);
      const scene = await readAssetBundleGltf(built.bundleDir, manifest, key, "default");
      const json = JSON.parse(scene.gltf.toString("utf8"));
      assert.deepEqual(json.nodes.map((node: any) => node.name).sort(), ["grip", piece].sort(), key);
    }
    // #467: each throwable ships default, lod1 and lod2, and its descriptor lists them nearest first.
    for (const { key, piece } of RANGER_THROWABLES) {
      const variants = manifest.assets.filter((candidate) => candidate.key === key);
      assert.deepEqual(variants.map((variant) => variant.variant), ["default", "lod1", "lod2"], key);
      const item = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, key, "default", RANGER_ITEM_ATTACHMENT)).toString("utf8"));
      assert.deepEqual(item.roles, [WEAPON_ROLES[piece]], key);
      assert.deepEqual(item.lods.levels.map((level: any) => [level.variant, level.triangles]),
        variants.map((variant) => [variant.variant, variant.observations.triangles]), key);
      assert.ok(item.lods.levels[0].triangles > item.lods.levels[1].triangles && item.lods.levels[1].triangles > item.lods.levels[2].triangles, key);
    }
    // v7 archery: the arrow and quiver are static like the weapons; the bows are skinned to grip and nock.
    for (const { key, piece } of RANGER_ARCHERY) {
      const item = manifest.assets.find((candidate) => candidate.key === key)!;
      assert.deepEqual(item.observations.animations, [], key);
      const json = JSON.parse((await readAssetBundleGltf(built.bundleDir, manifest, key, "default")).gltf.toString("utf8"));
      const names = json.nodes.map((node: any) => node.name);
      if (ARCHERY_ROLES[piece] === "bow") {
        assert.equal(item.observations.skins, 1, key);
        assert.deepEqual(json.skins[0].joints.map((index: number) => json.nodes[index].name), ["grip", "nock"]);
        assert.ok(names.includes(piece), key);
      } else {
        assert.equal(item.observations.skins, 0, key);
        assert.deepEqual(names.sort(), ["grip", piece].sort(), key);
      }
    }
    // #661: the held items are static, held by an identity grip, and fill a role an existing socket accepts.
    for (const { key, item } of RANGER_HELD_ITEMS) {
      const entry = manifest.assets.find((candidate) => candidate.key === key)!;
      assert.equal(entry.observations.skins, 0, key);
      assert.deepEqual(entry.observations.animations, [], key);
      const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, key, "default", RANGER_ITEM_ATTACHMENT)).toString("utf8"));
      assert.ok((SOCKET_ROLES as readonly string[]).includes(descriptor.roles[0]), key);
      assert.deepEqual(descriptor.frames[0], { name: "grip", translation: [0, 0, 0], rotation: [0, 0, 0, 1] }, key);
      const json = JSON.parse((await readAssetBundleGltf(built.bundleDir, manifest, key, "default")).gltf.toString("utf8"));
      assert.deepEqual(json.nodes.map((node: any) => node.name).sort(), ["grip", item].sort(), key);
    }
    // #775: the Tinker's devices: one entry per device, a variant per state, held on `hand_r.weapon`; the trap turns
    // its ground, trigger and collision frames up to +Z and records the trigger radius and the collider's half extents.
    for (const { key, variants } of RANGER_TINKER_ITEMS) {
      assert.deepEqual(manifest.assets.filter((candidate) => candidate.key === key).map((entry) => entry.variant), variants.map(({ variant }) => variant), key);
      const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, key, "default", RANGER_ITEM_ATTACHMENT)).toString("utf8"));
      assert.equal(descriptor.roles[0], "one-hand-weapon", key);
    }
    const trap = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, "equipment.tinker.trap", "default", RANGER_ITEM_ATTACHMENT)).toString("utf8"));
    assert.deepEqual(trap.roles, ["one-hand-weapon", "trap"]);
    assert.deepEqual(trap.frames.map((frame: any) => frame.name), ["grip", "ground", "trigger", "collision"]);
    const byName = Object.fromEntries(trap.frames.map((frame: any) => [frame.name, frame]));
    assert.deepEqual(byName.trigger.scale, [.25, .25, .25]);
    assert.deepEqual(byName.collision.scale, [.17, .045, .15]);
    for (const name of ["ground", "trigger", "collision"]) assert.deepEqual(byName[name].rotation, [.707107, 0, 0, .707107], name);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
