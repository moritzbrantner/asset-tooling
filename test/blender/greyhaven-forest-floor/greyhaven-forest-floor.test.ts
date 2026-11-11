// Greyhaven forest floor (docs/greyhaven-forest-floor.md, #572): the recipe builds a verified gltf-resources-v1 bundle
// of seven walk-through fern, bracken, bluebell, wood-anemone, mushroom and leaf-litter patches on one cut-out atlas,
// each at most a few hundred triangles, with LODs that at least halve, distance switch points and no collision. The
// build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2; it needs the hydrated Quaternius grass, flower and
// leaf textures (suite.json).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import {
  FLOOR_DESCRIPTOR_ATTACHMENT, FLOOR_LITTER_FLOAT, FLOOR_LOD_DISTANCES, FLOOR_MATERIAL, FLOOR_PIECES, FLOOR_RELEASE, FLOOR_TRIANGLES,
  buildGreyhavenForestFloor, createFloorSpec, floorKey,
} from "../../../scripts/build-greyhaven-forest-floor.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";

test("the forest floor spec runs the packaged recipe, with the meadow and marsh helpers, for exactly one piece and level", () => {
  const hashes = { script: "a".repeat(64), meadow: "d".repeat(64), marsh: "e".repeat(64), grass: "b".repeat(64), flowers: "c".repeat(64), leaves: "f".repeat(64) };
  const spec = createFloorSpec({ piece: "leaf-litter", level: 1, hashes, blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, piece: "leaf-litter", level: 1 } });
  assert.equal(spec.assetId, "greyhaven-forest-floor.kit.leaf-litter");
  assert.equal(FLOOR_RELEASE, "greyhaven-forest-floor", "one rolling release, never numbered");
  assert.ok(FLOOR_LOD_DISTANCES[0] >= 60 && FLOOR_LOD_DISTANCES[1] >= 180, "full detail to at least 60 m, the last level beyond 180 m");
});

test("the recipe builds a verified, cheap walk-through forest floor kit on one cut-out atlas", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_200_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "greyhaven-forest-floor-"));
  try {
    const built = await buildGreyhavenForestFloor({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(),
      FLOOR_PIECES.flatMap((piece) => ["default", "lod1", "lod2"].map((variant) => `${floorKey(piece)}#${variant}`)).sort());

    // One cut-out atlas, KTX2 and stored once, inside the kit's cost limit.
    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 1);
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [FLOOR_MATERIAL]);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[FLOOR_RELEASE]!), []);

    // Cut-out, double-sided cards that carry COLOR_0, so the game can tint them.
    for (const [name, document] of Object.entries(built.documents)) {
      const materials = document.getRoot().listMaterials();
      assert.deepEqual(materials.map((material) => material.getName()), [FLOOR_MATERIAL], `${name}: one material`);
      assert.equal(materials[0]!.getAlphaMode(), "MASK", `${name}: cut-out`);
      assert.equal(materials[0]!.getDoubleSided(), true, `${name}: double-sided cards`);
      for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) assert.ok(primitive.getAttribute("COLOR_0"), `${name}: cards carry COLOR_0`);
    }

    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, floorKey(FLOOR_PIECES[0]), "default", FLOOR_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(descriptor.assets.length, FLOOR_PIECES.length);
    const tan = Math.tan(30 * Math.PI / 180);
    for (const asset of descriptor.assets) {
      assert.equal(asset.collision, "none", `${asset.key} is walk-through`);
      assert.equal(asset.origin, "patch-centre-on-ground");
      // Ragged patches that wander along X, not round blobs.
      assert.ok(asset.footprint.width > asset.footprint.depth, `${asset.key} is longer than it is wide`);
      const [lod0, lod1, lod2] = asset.lods.levels;
      assert.ok(lod0.triangles <= FLOOR_TRIANGLES, `${asset.key}: ${lod0.triangles} triangles`);
      assert.ok(lod1.triangles * 2 <= lod0.triangles, `${asset.key}: lod1 ${lod1.triangles} is at most half of ${lod0.triangles}`);
      assert.ok(lod2.triangles * 2 <= lod1.triangles, `${asset.key}: lod2 ${lod2.triangles} is at most half of ${lod1.triangles}`);
      assert.ok(lod0.referenceMaxDistance >= FLOOR_LOD_DISTANCES[0] && lod1.referenceMaxDistance >= FLOOR_LOD_DISTANCES[1]);
      assert.ok(Math.abs(asset.lods.boundingSphere.radius / (lod1.minScreenSize * tan) - lod1.referenceMaxDistance) < lod1.referenceMaxDistance * 0.02, `${asset.key}: lod1 ends about ${lod1.referenceMaxDistance} m away`);
      assert.equal(lod2.minScreenSize, 0);
      assert.ok(asset.coverM2 > (asset.kind === "mushrooms" ? 0.03 : 0.3), `${asset.key} covers ${asset.coverM2} m²`);
      if (asset.kind === "leaf-litter") {
        // Flat on the ground, floating just above the origin so it doesn't z-fight the terrain.
        assert.ok(asset.bounds.min[1] >= FLOOR_LITTER_FLOAT - 1e-4 && asset.bounds.min[1] < 0.02, `${asset.key}: litter floats ${asset.bounds.min[1]} m above the ground`);
        assert.ok(asset.footprint.height < 0.03, `${asset.key} lies flat`);
      } else {
        assert.ok(asset.bounds.min[1] < 0 && asset.bounds.min[1] > -0.05, `${asset.key}: feet sink just below the ground`);
      }
    }
    const piece = (kind: string) => descriptor.assets.find((asset: any) => asset.kind === kind);
    assert.ok(piece("bracken").footprint.height > 1 && piece("bracken").footprint.height > piece("fern-large").footprint.height, "bracken stands tallest");
    assert.ok(piece("fern-large").footprint.height > piece("fern").footprint.height * 1.6, "the large ferns stand well above the low ones");
    for (const kind of ["fern", "fern-large", "bracken"]) assert.ok(piece(kind).fronds >= 20, `${kind} has fronds`);
    assert.ok(piece("bluebells").flowers >= 30 && piece("wood-anemone").flowers >= 15, "the drifts are in flower");
    assert.ok(piece("wood-anemone").footprint.height < 0.3, "wood anemone stays low");
    assert.ok(piece("mushrooms").caps >= 5 && piece("mushrooms").footprint.height < 0.2, "a small, low cluster of caps");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
