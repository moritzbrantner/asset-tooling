// Wooden spike traps (docs/spike-traps.md): the recipe builds a verified gltf-resources-v1 bundle of six pieces on one wood
// atlas, each with LODs that at least halve, and collision proxies or a declared absence.
// The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import {
  SPIKE_DESCRIPTOR_ATTACHMENT, SPIKE_LOD_DISTANCES, SPIKE_MATERIAL, SPIKE_PIECES, SPIKE_RELEASE, SPIKE_TRIANGLE_BUDGET, SPIKE_VARIANTS, buildSpikeTraps, createSpikeSpec, spikeKey,
} from "../../../scripts/build-spike-traps.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";
import { scaledLodDistances } from "../../../src/kit-bundle.js";

const byRoleDistances = (descriptor: any, role: string) =>
  descriptor.assets.find((asset: any) => asset.role === role).lods.levels.slice(0, 2).map((level: any) => level.referenceMaxDistance);

test("the spike trap spec runs the packaged recipe for exactly one piece and level", () => {
  const spec = createSpikeSpec({ piece: "cheval", level: 1, scriptSha256: "a".repeat(64), commonSha256: "b".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, piece: "cheval", level: 1 } });
  assert.equal(spec.assetId, "spike-traps.kit.cheval");
  assert.equal(SPIKE_RELEASE, "spike-traps", "one rolling release, never numbered");
});

test("the recipe builds a verified kit on one atlas within its limits", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 900_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "spike-traps-"));
  try {
    const built = await buildSpikeTraps({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(),
      SPIKE_PIECES.flatMap((piece) => SPIKE_VARIANTS.map((variant) => `${spikeKey(piece)}#${variant}`)).sort());

    // One opaque material on one atlas of colour, normal and roughness, stored once as KTX2, inside the cost limit.
    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 3);
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [SPIKE_MATERIAL]);
    assert.equal(cost.maxima.drawCalls, 1);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[SPIKE_RELEASE]!), []);

    // mmorpg's lit material reads tangents and COLOR_0: every primitive carries both.
    for (const [piece, document] of Object.entries(built.documents)) {
      for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
        assert.ok(primitive.getAttribute("TANGENT"), `${piece} has tangents`);
        assert.ok(primitive.getAttribute("COLOR_0"), `${piece} has COLOR_0`);
      }
    }

    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, spikeKey(SPIKE_PIECES[0]), "default", SPIKE_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(descriptor.assets.length, SPIKE_PIECES.length);
    const tan = Math.tan(30 * Math.PI / 180);
    for (const asset of descriptor.assets) {
      assert.ok(asset.collisionProxies?.length || asset.collision === "none", `${asset.key} declares its collision`);
      const [lod0, lod1, lod2] = asset.lods.levels;
      assert.ok(lod0.triangles <= SPIKE_TRIANGLE_BUDGET, `${asset.key}: ${lod0.triangles} triangles`);
      assert.ok(lod1.triangles * 2 <= lod0.triangles, `${asset.key}: lod1 ${lod1.triangles} is at most half of ${lod0.triangles}`);
      assert.ok(lod2.triangles * 2 <= lod1.triangles, `${asset.key}: lod2 ${lod2.triangles} is at most half of ${lod1.triangles}`);
      // Every piece keeps at least 60 and 180 m, and larger pieces switch further out.
      const distances = scaledLodDistances(SPIKE_LOD_DISTANCES, asset.bounds);
      assert.deepEqual(asset.lods.levels.map((level: any) => level.referenceMaxDistance), [...distances, null]);
      assert.ok(distances[0]! >= 60 && distances[1]! >= 180, `${asset.key}: ${distances} m`);
      const lod1End = asset.lods.boundingSphere.radius / (lod1.minScreenSize * tan);
      assert.ok(Math.abs(lod1End / distances[1]! - 1) < 0.02, `${asset.key}: lod1 ends about ${distances[1]} m away, not ${lod1End}`);
      assert.equal(lod2.minScreenSize, 0);
    }
    assert.deepEqual(byRoleDistances(descriptor, "cheval"), [180, 540], "the 3 m cheval holds detail three times as far");
    assert.deepEqual(byRoleDistances(descriptor, "spike-board"), [60, 180], "the 1 m board keeps the base distances");
    const byRole = Object.fromEntries(descriptor.assets.map((asset: any) => [asset.role, asset]));
    assert.deepEqual(byRole["stake-row"].module, { axis: "x", length: 2 });
    assert.deepEqual([byRole["stake-row"].bounds.min[0], byRole["stake-row"].bounds.max[0]], [-1, 1], "a stake row's rails end on its module");
    assert.deepEqual(byRole["swing-log"].pivot, [0, 3.6, 0]);
    assert.equal(byRole["spike-board"].collision, "none", "the board lies flat and is walked over");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
