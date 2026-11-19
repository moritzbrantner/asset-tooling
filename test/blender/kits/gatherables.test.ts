// Greyhaven gatherables (docs/gatherables.md, #762): the recipe builds a verified gltf-resources-v1 bundle of an ore vein in two
// states and three material drops on one atlas, each with LODs that at least halve, collision or a declared absence, and the
// items' inventory icons. The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import {
  GATHERABLE_DESCRIPTOR_ATTACHMENT, GATHERABLE_ICON_EDGE, GATHERABLE_ICONS_ATTACHMENT, GATHERABLE_ITEMS, GATHERABLE_LOD_DISTANCES, GATHERABLE_MATERIAL,
  GATHERABLE_PIECES, GATHERABLE_RELEASE, GATHERABLE_TRIANGLE_BUDGET, GATHERABLE_VARIANTS, buildGatherables, createGatherableSpec, gatherableKey,
} from "../../../scripts/build-gatherables.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";
import { scaledLodDistances } from "../../../src/kit-bundle.js";

test("the gatherables spec runs the packaged recipe for exactly one piece and level", () => {
  const spec = createGatherableSpec({ piece: "ore-vein-depleted", level: 2, scriptSha256: "a".repeat(64), commonSha256: "b".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, piece: "ore-vein-depleted", level: 2 } });
  assert.equal(spec.assetId, "gatherables.kit.ore-vein-depleted");
  assert.equal(GATHERABLE_RELEASE, "gatherables", "one rolling release, never numbered");
});

test("the recipe builds a verified kit on one atlas within its limits, with icons for the items", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 900_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "gatherables-"));
  try {
    const built = await buildGatherables({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(),
      GATHERABLE_PIECES.flatMap((piece) => GATHERABLE_VARIANTS.map((variant) => `${gatherableKey(piece)}#${variant}`)).sort());

    // One opaque material on one atlas of colour, normal and ORM, stored once as KTX2, inside the cost limit.
    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 3);
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [GATHERABLE_MATERIAL]);
    assert.equal(cost.maxima.drawCalls, 1);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[GATHERABLE_RELEASE]!), []);

    // mmorpg's lit material reads tangents and COLOR_0: every primitive carries both.
    for (const [piece, document] of Object.entries(built.documents)) {
      for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
        assert.ok(primitive.getAttribute("TANGENT"), `${piece} has tangents`);
        assert.ok(primitive.getAttribute("COLOR_0"), `${piece} has COLOR_0`);
      }
    }

    const first = gatherableKey(GATHERABLE_PIECES[0]);
    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, first, "default", GATHERABLE_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(descriptor.assets.length, GATHERABLE_PIECES.length);
    const tan = Math.tan(30 * Math.PI / 180);
    for (const asset of descriptor.assets) {
      const [lod0, lod1, lod2] = asset.lods.levels;
      assert.ok(lod0.triangles <= GATHERABLE_TRIANGLE_BUDGET, `${asset.key}: ${lod0.triangles} triangles`);
      assert.ok(lod1.triangles * 2 <= lod0.triangles, `${asset.key}: lod1 ${lod1.triangles} is at most half of ${lod0.triangles}`);
      assert.ok(lod2.triangles * 2 <= lod1.triangles, `${asset.key}: lod2 ${lod2.triangles} is at most half of ${lod1.triangles}`);
      const distances = scaledLodDistances(GATHERABLE_LOD_DISTANCES, asset.bounds);
      assert.deepEqual(asset.lods.levels.map((level: any) => level.referenceMaxDistance), [...distances, null]);
      const lod1End = asset.lods.boundingSphere.radius / (lod1.minScreenSize * tan);
      assert.ok(Math.abs(lod1End / distances[1]! - 1) < 0.02, `${asset.key}: lod1 ends about ${distances[1]} m away, not ${lod1End}`);
    }
    const byRole = Object.fromEntries(descriptor.assets.map((asset: any) => [asset.role, asset]));
    // The vein's two states are one node in the same frame; each is solid, with a closed convex mesh of at most 240 triangles.
    for (const [role, state] of [["ore-vein", "full"], ["ore-vein-depleted", "depleted"]] as const) {
      const vein = byRole[role];
      assert.deepEqual([vein.kind, vein.node, vein.state], ["node", "ore-vein", state]);
      assert.ok(vein.bury > 0 && Math.abs(vein.bounds.min[1] + vein.bury) < 1e-3, `${role} is buried by its bury`);
      const hull = vein.collisionMesh;
      assert.ok(hull.triangles.length >= 4 && hull.triangles.length <= 240, `${role}: ${hull.triangles.length} collision triangles`);
      // Closed: every edge is shared by exactly two triangles, once in each direction.
      const edges = new Map<string, number>();
      for (const [a, b, c] of hull.triangles) for (const [p, q] of [[a, b], [b, c], [c, a]]) edges.set(`${p}-${q}`, (edges.get(`${p}-${q}`) ?? 0) + 1);
      for (const [edge, count] of edges) assert.ok(count === 1 && edges.get(edge.split("-").reverse().join("-")) === 1, `${role}: edge ${edge} is closed`);
    }
    assert.deepEqual(byRole["ore-vein"].footprint.width, byRole["ore-vein-depleted"].footprint.width, "both states share the outcrop");
    for (const item of GATHERABLE_ITEMS) {
      assert.deepEqual([byRole[item].kind, byRole[item].collision, byRole[item].icon], ["item", "none", item]);
      assert.ok(Math.abs(byRole[item].bounds.min[1]) < 1e-3, `${item} lies on the ground`);
    }

    // Each item's icon is a transparent square PNG of the declared edge, hashed as shipped.
    const icons = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, first, "default", GATHERABLE_ICONS_ATTACHMENT)).toString("utf8"));
    assert.deepEqual(Object.keys(icons.icons).sort(), [...GATHERABLE_ITEMS].sort());
    for (const [item, icon] of Object.entries<any>(icons.icons)) {
      const png = Buffer.from(icon.base64, "base64");
      assert.equal(icon.sha256, createHash("sha256").update(png).digest("hex"), `${item} icon hash`);
      assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
      assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20), png[25]], [GATHERABLE_ICON_EDGE, GATHERABLE_ICON_EDGE, 6], `${item} icon is ${GATHERABLE_ICON_EDGE} px RGBA`);
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
