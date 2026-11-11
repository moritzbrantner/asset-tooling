// Greyhaven deadwood (docs/greyhaven-deadwood.md, #573): the recipe builds a verified gltf-resources-v1 bundle of fallen
// logs, stumps, a root plate and branches on one opaque atlas, with LODs that at least halve, distance switch points
// scaled by size, closed collision meshes on the solid pieces and none on the walk-through branches. The build skips
// unless ASSET_TOOLING_BLENDER names Blender 5.2.2; it needs the hydrated bark, moss and soil scans (suite.json).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import { scaledLodDistances } from "../../../src/kit-bundle.js";
import {
  DEADWOOD_DESCRIPTOR_ATTACHMENT, DEADWOOD_LOD_DISTANCES, DEADWOOD_MATERIAL, DEADWOOD_PIECES, DEADWOOD_RELEASE, DEADWOOD_TRIANGLES, DEADWOOD_WALK_THROUGH,
  buildGreyhavenDeadwood, createDeadwoodSpec, deadwoodKey,
} from "../../../scripts/build-greyhaven-deadwood.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";

test("the deadwood spec runs the packaged recipe for exactly one piece and level", () => {
  const hashes = { script: "a", trees: "b", pines: "c", moss: "d", bark: "e", mossColour: "f", soil: "0" };
  const spec = createDeadwoodSpec({ piece: "root-plate", level: 1, hashes: Object.fromEntries(Object.entries(hashes).map(([k, v]) => [k, v.repeat(64)])) as typeof hashes, blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, piece: "root-plate", level: 1 } });
  assert.equal(spec.assetId, "greyhaven-deadwood.kit.root-plate");
  assert.equal(DEADWOOD_RELEASE, "greyhaven-deadwood", "one rolling release, never numbered");
  assert.ok(DEADWOOD_LOD_DISTANCES[0] >= 60 && DEADWOOD_LOD_DISTANCES[1] >= 180, "full detail to at least 60 m, the last level beyond 180 m");
});

test("the recipe builds a verified kit on one opaque atlas within its limits", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_200_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "greyhaven-deadwood-"));
  try {
    const built = await buildGreyhavenDeadwood({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(),
      DEADWOOD_PIECES.flatMap((piece) => ["default", "lod1", "lod2"].map((variant) => `${deadwoodKey(piece)}#${variant}`)).sort());

    // One opaque atlas, KTX2 and stored once, inside the kit's cost limit.
    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 1);
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [DEADWOOD_MATERIAL]);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[DEADWOOD_RELEASE]!), []);

    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, deadwoodKey(DEADWOOD_PIECES[0]), "default", DEADWOOD_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(descriptor.assets.length, DEADWOOD_PIECES.length);
    const tan = Math.tan(30 * Math.PI / 180);
    for (const asset of descriptor.assets) {
      const [lod0, lod1, lod2] = asset.lods.levels;
      assert.ok(lod0.triangles <= DEADWOOD_TRIANGLES, `${asset.key}: ${lod0.triangles} triangles`);
      assert.ok(lod1.triangles * 2 <= lod0.triangles, `${asset.key}: lod1 ${lod1.triangles} is at most half of ${lod0.triangles}`);
      assert.ok(lod2.triangles * 2 <= lod1.triangles, `${asset.key}: lod2 ${lod2.triangles} is at most half of ${lod1.triangles}`);
      const distances = scaledLodDistances(DEADWOOD_LOD_DISTANCES, asset.bounds);
      assert.deepEqual(asset.lods.levels.map((level: any) => level.referenceMaxDistance), [...distances, null]);
      assert.ok(distances[0]! >= 60 && distances[1]! >= 180, `${asset.key}: switches far out`);
      // minScreenSize keeps four decimals, so far out the distance it gives back is only good to a couple of per cent.
      assert.ok(Math.abs(asset.lods.boundingSphere.radius / (lod1.minScreenSize * tan) / distances[1]! - 1) < 0.02, `${asset.key}: lod1 ends about ${distances[1]} m away`);
      assert.equal(lod2.minScreenSize, 0);
      // Lying on the ground at the origin: nothing floats, and only stumps and the root plate reach well below it.
      assert.ok(asset.bounds.min[1] < 0.02, `${asset.key} touches the ground`);
      assert.ok(asset.bounds.min[1] > -0.4, `${asset.key} is not buried deep`);

      if (DEADWOOD_WALK_THROUGH.includes(asset.kind)) {
        assert.equal(asset.collision, "none", `${asset.key} is walk-through`);
        assert.equal(asset.collisionMesh, undefined);
        continue;
      }
      // Solid: a closed, outward-wound collision mesh of at most 240 triangles, every edge shared twice, that a
      // character can step or climb onto (it never stands taller than the piece).
      const mesh = asset.collisionMesh;
      assert.equal(mesh.shape, "triangle-mesh");
      assert.ok(mesh.triangles.length <= 240, `${asset.key}: ${mesh.triangles.length} collision triangles`);
      const edges = new Map<string, number>();
      for (const [a, b, c] of mesh.triangles) for (const [p, q] of [[a, b], [b, c], [c, a]]) edges.set(`${p}>${q}`, (edges.get(`${p}>${q}`) ?? 0) + 1);
      for (const [key, count] of edges) {
        assert.equal(count, 1, `${asset.key}: collision edge ${key} is used once in its direction`);
        assert.ok(edges.has(key.split(">").reverse().join(">")), `${asset.key}: collision edge ${key} has its opposite`);
      }
      let volume = 0;
      for (const [a, b, c] of mesh.triangles) {
        const [p, q, r] = [mesh.vertices[a], mesh.vertices[b], mesh.vertices[c]];
        volume += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
      }
      assert.ok(volume > 0, `${asset.key}: collision winds outward (${volume})`);
      const ys = mesh.vertices.map((v: number[]) => v[1]);
      assert.ok(Math.min(...ys) <= 0.05, `${asset.key}: collision reaches the ground`);
      assert.ok(Math.max(...ys) <= asset.bounds.max[1] + 0.01, `${asset.key}: collision stands no taller than the wood`);
    }
    const piece = (kind: string) => descriptor.assets.find((asset: any) => asset.kind === kind);
    for (const log of ["log-oak", "log-pine", "log-hollow"]) {
      const { footprint } = piece(log);
      assert.ok(footprint.width > 3 && footprint.width > footprint.depth * 2.5, `${log} lies along X`);
      assert.ok(footprint.height < 1.0, `${log} is low enough to climb onto`);
    }
    assert.ok(piece("log-pine").footprint.width > piece("log-oak").footprint.width, "the pine log is the longest");
    assert.ok(piece("stump-oak").footprint.height < 1.0 && piece("stump-pine").footprint.height < 1.1, "stumps are low");
    assert.ok(piece("root-plate").footprint.height > 1.5, "the root plate stands up");
    assert.ok(piece("branches-scatter").footprint.height < 0.15, "the scatter lies flat");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
