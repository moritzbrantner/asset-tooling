// Greyhaven trees (docs/greyhaven-trees.md, #568): the recipe builds a verified gltf-resources-v1 bundle of eight trees
// on one bark atlas and one leaf atlas, each rooted at its trunk foot, with LODs that at least halve, far switch
// distances and trunk collision. The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2; it needs the
// hydrated Quaternius bark (suite.json).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import {
  TREES_DESCRIPTOR_ATTACHMENT, TREES_MATERIALS, TREES_RELEASE, TREE_LOD_DISTANCES, TREE_PIECES, TREE_TRIANGLES, buildGreyhavenTrees, createTreeSpec, treeKey,
} from "../../../scripts/build-greyhaven-trees.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";

test("the tree spec runs the packaged recipe for exactly one piece and level", () => {
  const spec = createTreeSpec({ piece: "birch", level: 2, scriptSha256: "a".repeat(64), bushesSha256: "b".repeat(64), lodSha256: "c".repeat(64), barkSha256: "d".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, piece: "birch", level: 2 } });
  assert.equal(spec.assetId, "greyhaven-trees.kit.birch");
  assert.equal(TREES_RELEASE, "greyhaven-trees", "one rolling release, never numbered");
  assert.ok(TREE_LOD_DISTANCES[0] >= 60 && TREE_LOD_DISTANCES[1] >= 180, "full detail to at least 60 m, the last level beyond 180 m");
});

test("the recipe builds a verified kit on two atlases within its limits", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_200_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "greyhaven-trees-"));
  try {
    const built = await buildGreyhavenTrees({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(),
      TREE_PIECES.flatMap((piece) => ["default", "lod1", "lod2"].map((variant) => `${treeKey(piece)}#${variant}`)).sort());

    // One opaque bark atlas and one cut-out leaf atlas, KTX2 and stored once, inside the kit's cost limit.
    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 2);
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [...TREES_MATERIALS]);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[TREES_RELEASE]!), []);

    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, treeKey(TREE_PIECES[0]), "default", TREES_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(descriptor.assets.length, TREE_PIECES.length);
    const tan = Math.tan(30 * Math.PI / 180);
    for (const asset of descriptor.assets) {
      // Rooted at the trunk foot: the flare runs below the ground, and the tree stands up from it.
      assert.ok(asset.bounds.min[1] < -0.2 && asset.bounds.min[1] > -0.5, `${asset.key} roots below the ground`);
      assert.ok(asset.footprint.height > 2, `${asset.key} stands up`);
      const [lod0, lod1, lod2] = asset.lods.levels;
      assert.ok(lod0.triangles <= TREE_TRIANGLES, `${asset.key}: ${lod0.triangles} triangles`);
      assert.ok(lod1.triangles * 2 <= lod0.triangles, `${asset.key}: lod1 ${lod1.triangles} is at most half of ${lod0.triangles}`);
      assert.ok(lod2.triangles * 2 <= lod1.triangles, `${asset.key}: lod2 ${lod2.triangles} is at most half of ${lod1.triangles}`);
      assert.deepEqual(asset.lods.levels.map((level: any) => level.referenceMaxDistance), [...TREE_LOD_DISTANCES, null]);
      assert.ok(Math.abs(asset.lods.boundingSphere.radius / (lod1.minScreenSize * tan) - TREE_LOD_DISTANCES[1]) < 3, `${asset.key}: lod1 ends about ${TREE_LOD_DISTANCES[1]} m away`);
      assert.equal(lod2.minScreenSize, 0);

      // The trunk's collision: a closed tube of at most 240 triangles around the origin, every edge shared twice.
      const mesh = asset.collisionMesh;
      assert.equal(mesh.shape, "triangle-mesh");
      assert.ok(mesh.triangles.length <= 240, `${asset.key}: ${mesh.triangles.length} collision triangles`);
      const edges = new Map<string, number>();
      for (const [a, b, c] of mesh.triangles) for (const [p, q] of [[a, b], [b, c], [c, a]]) edges.set(`${p}>${q}`, (edges.get(`${p}>${q}`) ?? 0) + 1);
      for (const key of edges.keys()) assert.ok(edges.has(key.split(">").reverse().join(">")), `${asset.key}: collision edge ${key} has its opposite`);
      const ys = mesh.vertices.map((v: number[]) => v[1]);
      assert.ok(Math.min(...ys) < 0 && Math.max(...ys) > 1, `${asset.key}: collision runs from below the ground up the trunk`);
      // Outward winding: the signed volume is positive.
      let volume = 0;
      for (const [a, b, c] of mesh.triangles) {
        const [p, q, r] = [mesh.vertices[a], mesh.vertices[b], mesh.vertices[c]];
        volume += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
      }
      assert.ok(volume > 0, `${asset.key}: collision winds outward (${volume})`);
    }
    const height = (piece: string) => descriptor.assets.find((asset: any) => asset.kind === piece).footprint.height;
    const width = (piece: string) => descriptor.assets.find((asset: any) => asset.kind === piece).footprint.width;
    assert.ok(height("beech") > height("oak") && width("oak") > width("beech"), "the beech is taller, the oak wider");
    assert.ok(width("birch") < width("oak") / 2, "the birch is slender");
    assert.ok(height("sapling") < 3, "the sapling is small");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
