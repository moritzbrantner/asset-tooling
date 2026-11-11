// Greyhaven marsh plants (docs/greyhaven-marsh-plants.md, #571): the recipe builds a verified gltf-resources-v1 bundle
// of seven walk-through reed, cattail, sedge, rush, water-lily and marsh-marigold patches on one cut-out atlas, each at
// most a few hundred triangles, with LODs that at least halve, distance switch points and no collision. The build
// skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2; it needs the hydrated Quaternius grass and flower textures
// (suite.json).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import {
  MARSH_DESCRIPTOR_ATTACHMENT, MARSH_LOD_DISTANCES, MARSH_MATERIAL, MARSH_PIECES, MARSH_RELEASE, MARSH_TRIANGLES,
  buildGreyhavenMarshPlants, createMarshSpec, marshKey,
} from "../../../scripts/build-greyhaven-marsh-plants.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";

test("the marsh spec runs the packaged recipe, with the meadow helpers, for exactly one piece and level", () => {
  const hashes = { script: "a".repeat(64), meadow: "d".repeat(64), grass: "b".repeat(64), flowers: "c".repeat(64) };
  const spec = createMarshSpec({ piece: "water-lilies", level: 1, hashes, blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, piece: "water-lilies", level: 1 } });
  assert.equal(spec.assetId, "greyhaven-marsh-plants.kit.water-lilies");
  assert.equal(MARSH_RELEASE, "greyhaven-marsh-plants", "one rolling release, never numbered");
  assert.ok(MARSH_LOD_DISTANCES[0] >= 60 && MARSH_LOD_DISTANCES[1] >= 180, "full detail to at least 60 m, the last level beyond 180 m");
});

test("the recipe builds a verified, cheap walk-through marsh kit on one cut-out atlas", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_200_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "greyhaven-marsh-plants-"));
  try {
    const built = await buildGreyhavenMarshPlants({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(),
      MARSH_PIECES.flatMap((piece) => ["default", "lod1", "lod2"].map((variant) => `${marshKey(piece)}#${variant}`)).sort());

    // One cut-out atlas, KTX2 and stored once, inside the kit's cost limit.
    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 1);
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [MARSH_MATERIAL]);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[MARSH_RELEASE]!), []);

    // Cut-out, double-sided cards that carry COLOR_0, so the game can tint them.
    for (const [name, document] of Object.entries(built.documents)) {
      const materials = document.getRoot().listMaterials();
      assert.deepEqual(materials.map((material) => material.getName()), [MARSH_MATERIAL], `${name}: one material`);
      assert.equal(materials[0]!.getAlphaMode(), "MASK", `${name}: cut-out`);
      assert.equal(materials[0]!.getDoubleSided(), true, `${name}: double-sided cards`);
      for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) assert.ok(primitive.getAttribute("COLOR_0"), `${name}: cards carry COLOR_0`);
    }

    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, marshKey(MARSH_PIECES[0]), "default", MARSH_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(descriptor.assets.length, MARSH_PIECES.length);
    const tan = Math.tan(30 * Math.PI / 180);
    for (const asset of descriptor.assets) {
      assert.equal(asset.collision, "none", `${asset.key} is walk-through`);
      // Ragged patches that wander along X, not round blobs.
      assert.ok(asset.footprint.width > asset.footprint.depth, `${asset.key} is longer than it is wide`);
      const [lod0, lod1, lod2] = asset.lods.levels;
      assert.ok(lod0.triangles <= MARSH_TRIANGLES, `${asset.key}: ${lod0.triangles} triangles`);
      assert.ok(lod1.triangles * 2 <= lod0.triangles, `${asset.key}: lod1 ${lod1.triangles} is at most half of ${lod0.triangles}`);
      assert.ok(lod2.triangles * 2 <= lod1.triangles, `${asset.key}: lod2 ${lod2.triangles} is at most half of ${lod1.triangles}`);
      assert.ok(lod0.referenceMaxDistance >= MARSH_LOD_DISTANCES[0] && lod1.referenceMaxDistance >= MARSH_LOD_DISTANCES[1]);
      assert.ok(Math.abs(asset.lods.boundingSphere.radius / (lod1.minScreenSize * tan) - lod1.referenceMaxDistance) < lod1.referenceMaxDistance * 0.02, `${asset.key}: lod1 ends about ${lod1.referenceMaxDistance} m away`);
      assert.equal(lod2.minScreenSize, 0);
      assert.ok(asset.coverM2 > 0.2, `${asset.key} covers ${asset.coverM2} m²`);
      if (asset.kind === "water-lilies") {
        // The origin is the water line; flat pads float just above it.
        assert.equal(asset.origin, "water-line");
        assert.ok(asset.bounds.min[1] > 0 && asset.bounds.min[1] < 0.02, `${asset.key}: pads float ${asset.bounds.min[1]} m above the water line`);
        assert.ok(asset.footprint.height < 0.08, `${asset.key} lies flat`);
      } else {
        assert.ok(asset.bounds.min[1] < 0 && asset.bounds.min[1] > -0.05, `${asset.key}: card feet sink just below the ground`);
      }
    }
    const piece = (kind: string) => descriptor.assets.find((asset: any) => asset.kind === kind);
    for (const kind of ["reeds-stand", "reeds-edge"]) {
      assert.ok(piece(kind).footprint.height > 2, `${kind} stands over 2 m`);
      assert.ok(piece(kind).plumeCards >= 30, `${kind} carries brown plumes`);
    }
    assert.ok(piece("cattails").footprint.height > 1.4 && piece("rushes").footprint.height < piece("cattails").footprint.height);
    assert.ok(piece("water-lilies").pads >= 12 && piece("water-lilies").flowers >= 2, "a raft of pads with a few flowers");
    assert.ok(piece("marsh-marigold").flowers >= 8 && piece("marsh-marigold").footprint.height < 0.6, "low marigold clumps in flower");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
