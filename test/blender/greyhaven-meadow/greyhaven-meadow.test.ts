// Greyhaven meadow (docs/greyhaven-meadow.md, #570): the recipe builds a verified gltf-resources-v1 bundle of eight
// walk-through grass and flower patches on one cut-out atlas, each at most a few hundred triangles, with LODs that at
// least halve down to one card, distance switch points and no collision. The build skips unless ASSET_TOOLING_BLENDER
// names Blender 5.2.2; it needs the hydrated Quaternius grass and flower textures (suite.json).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import {
  MEADOW_DESCRIPTOR_ATTACHMENT, MEADOW_LOD_DISTANCES, MEADOW_MATERIAL, MEADOW_PIECES, MEADOW_RELEASE, MEADOW_TRIANGLES,
  buildGreyhavenMeadow, createMeadowSpec, meadowKey,
} from "../../../scripts/build-greyhaven-meadow.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";

test("the meadow spec runs the packaged recipe for exactly one piece and level", () => {
  const hashes = { script: "a".repeat(64), grass: "b".repeat(64), flowers: "c".repeat(64) };
  const spec = createMeadowSpec({ piece: "flowers-red", level: 1, hashes, blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, piece: "flowers-red", level: 1 } });
  assert.equal(spec.assetId, "greyhaven-meadow.kit.flowers-red");
  assert.equal(MEADOW_RELEASE, "greyhaven-meadow", "one rolling release, never numbered");
  assert.ok(MEADOW_LOD_DISTANCES[0] >= 60 && MEADOW_LOD_DISTANCES[1] >= 180, "full detail to at least 60 m, the last level beyond 180 m");
});

test("the recipe builds a verified, cheap walk-through kit on one cut-out atlas", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_200_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "greyhaven-meadow-"));
  try {
    const built = await buildGreyhavenMeadow({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(),
      MEADOW_PIECES.flatMap((piece) => ["default", "lod1", "lod2"].map((variant) => `${meadowKey(piece)}#${variant}`)).sort());

    // One cut-out atlas, KTX2 and stored once, inside the kit's cost limit.
    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 1);
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [MEADOW_MATERIAL]);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[MEADOW_RELEASE]!), []);

    // Cut-out, double-sided cards that carry COLOR_0, so the game can tint them.
    for (const [name, document] of Object.entries(built.documents)) {
      const materials = document.getRoot().listMaterials();
      assert.deepEqual(materials.map((material) => material.getName()), [MEADOW_MATERIAL], `${name}: one material`);
      assert.equal(materials[0]!.getAlphaMode(), "MASK", `${name}: cut-out`);
      assert.equal(materials[0]!.getDoubleSided(), true, `${name}: double-sided cards`);
      for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) assert.ok(primitive.getAttribute("COLOR_0"), `${name}: cards carry COLOR_0`);
    }

    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, meadowKey(MEADOW_PIECES[0]), "default", MEADOW_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(descriptor.assets.length, MEADOW_PIECES.length);
    const tan = Math.tan(30 * Math.PI / 180);
    for (const asset of descriptor.assets) {
      assert.equal(asset.collision, "none", `${asset.key} is walk-through`);
      assert.ok(asset.bounds.min[1] < 0 && asset.bounds.min[1] > -0.05, `${asset.key}: card feet sink just below the ground`);
      assert.ok(asset.footprint.height > 0.2 && asset.footprint.height < 1.2, `${asset.key}: ${asset.footprint.height} m tall`);
      // Ragged patches that wander along X, not round blobs.
      assert.ok(asset.footprint.width > asset.footprint.depth, `${asset.key} is longer than it is wide`);
      const [lod0, lod1, lod2] = asset.lods.levels;
      assert.ok(lod0.triangles <= MEADOW_TRIANGLES, `${asset.key}: ${lod0.triangles} triangles`);
      assert.ok(lod1.triangles * 2 <= lod0.triangles, `${asset.key}: lod1 ${lod1.triangles} is at most half of ${lod0.triangles}`);
      assert.equal(lod2.triangles, 2, `${asset.key}: the last level is one card`);
      assert.ok(lod0.referenceMaxDistance >= MEADOW_LOD_DISTANCES[0] && lod1.referenceMaxDistance >= MEADOW_LOD_DISTANCES[1]);
      assert.ok(Math.abs(asset.lods.boundingSphere.radius / (lod1.minScreenSize * tan) - lod1.referenceMaxDistance) < 3, `${asset.key}: lod1 ends about ${lod1.referenceMaxDistance} m away`);
      assert.equal(lod2.minScreenSize, 0);
      assert.ok(asset.coverM2 > 0.3, `${asset.key} covers ${asset.coverM2} m²`);
    }
    const piece = (kind: string) => descriptor.assets.find((asset: any) => asset.kind === kind);
    assert.ok(piece("grass-tall").footprint.height > piece("grass-short").footprint.height * 1.5, "tall grass is tall");
    for (const kind of ["flowers-yellow", "flowers-white", "flowers-red", "flowers-mixed"]) assert.ok(piece(kind).flowers >= 10, `${kind} has flowers`);
    for (const kind of ["grass-short", "grass-tall", "grass-clump", "grass-dry"]) assert.equal(piece(kind).flowers, 0, `${kind} has no flowers`);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
