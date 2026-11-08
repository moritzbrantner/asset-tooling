// Woodland-edge bushes (docs/woodland-bushes.md, #532): the recipe builds a verified gltf-resources-v1 bundle of twelve
// pieces on one leaf atlas, each with a footprint-centred frame, LODs that at least halve, and collision declared absent.
// The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import {
  WOODLAND_BUSHES_DESCRIPTOR_ATTACHMENT, WOODLAND_BUSHES_RELEASE, WOODLAND_BUSH_KINDS, WOODLAND_BUSH_PIECES, WOODLAND_BUSH_TRIANGLES, buildWoodlandBushes, createWoodlandBushSpec,
} from "../../../scripts/build-woodland-bushes.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";

test("the bush spec runs the packaged recipe for exactly one piece", () => {
  const spec = createWoodlandBushSpec({ kind: "holly", variant: 2, scriptSha256: "a".repeat(64), bushSha256: "b".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, kind: "holly", variant: 2 } });
  assert.equal(spec.assetId, "woodland-bushes.kit.holly-2");
  assert.equal(WOODLAND_BUSHES_RELEASE, "woodland-bushes", "one rolling release, never numbered");
  assert.equal(WOODLAND_BUSH_PIECES.length, WOODLAND_BUSH_KINDS.length * 2);
});

test("the recipe builds a verified kit on one atlas within its limits", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 900_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "woodland-bushes-"));
  try {
    const built = await buildWoodlandBushes({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(),
      WOODLAND_BUSH_PIECES.flatMap(({ key }) => ["default", "lod1", "lod2"].map((variant) => `${key}#${variant}`)).sort());

    // One cut-out atlas plus one untextured core, KTX2 and stored once, inside the kit's cost limit.
    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 1);
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, ["Leaves_Bush_Woodland", "Leaves_Core_Woodland"]);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[WOODLAND_BUSHES_RELEASE]!), []);

    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, WOODLAND_BUSH_PIECES[0]!.key, "default", WOODLAND_BUSHES_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(descriptor.assets.length, WOODLAND_BUSH_PIECES.length);
    for (const asset of descriptor.assets) {
      assert.equal(asset.collision, "none", `${asset.key}: walk-through foliage declares no collision`);
      assert.ok(Math.abs(asset.bounds.min[1]) < 1e-3, `${asset.key} stands on the ground`);
      for (const axis of [0, 2]) assert.ok(Math.abs(asset.bounds.min[axis] + asset.bounds.max[axis]) < 1e-3, `${asset.key} is centred on its footprint`);
      const [lod0, lod1, lod2] = asset.lods.levels;
      assert.ok(lod0.triangles <= WOODLAND_BUSH_TRIANGLES, `${asset.key}: ${lod0.triangles} triangles`);
      assert.ok(lod1.triangles * 2 <= lod0.triangles, `${asset.key}: lod1 ${lod1.triangles} is at most half of ${lod0.triangles}`);
      assert.ok(lod2.triangles * 2 <= lod1.triangles, `${asset.key}: lod2 ${lod2.triangles} is at most half of ${lod1.triangles}`);
    }
    assert.ok(new Set(descriptor.assets.map((asset: any) => asset.footprint.height)).size >= 4, "the kinds differ in height");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
