// Greyhaven pines (docs/greyhaven-pines.md, #569): the recipe builds a verified gltf-resources-v1 bundle of six upland
// conifers on one bark atlas and one needle atlas, each rooted at its trunk foot, with LODs that at least halve, far
// switch distances and trunk collision. The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2; it needs the
// hydrated Quaternius bark and Poly Haven fir twig maps (suite.json).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import {
  PINES_DESCRIPTOR_ATTACHMENT, PINES_MATERIALS, PINES_RELEASE, PINE_LOD_DISTANCES, PINE_PIECES, PINE_TRIANGLES, buildGreyhavenPines, createPineSpec, pineKey,
} from "../../../scripts/build-greyhaven-pines.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";

test("the pine spec runs the packaged recipe for exactly one piece and level", () => {
  const hashes = { script: "a", trees: "b", conifer: "c", lod: "d", bark: "e", needles: "f", needleAlpha: "0" };
  const spec = createPineSpec({ piece: "spruce", level: 2, hashes: Object.fromEntries(Object.entries(hashes).map(([k, v]) => [k, v.repeat(64)])) as typeof hashes, blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, piece: "spruce", level: 2 } });
  assert.equal(spec.assetId, "greyhaven-pines.kit.spruce");
  assert.equal(PINES_RELEASE, "greyhaven-pines", "one rolling release, never numbered");
  assert.ok(PINE_LOD_DISTANCES[0] >= 60 && PINE_LOD_DISTANCES[1] >= 180, "full detail to at least 60 m, the last level beyond 180 m");
});

test("the recipe builds a verified kit on two atlases within its limits", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_200_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "greyhaven-pines-"));
  try {
    const built = await buildGreyhavenPines({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(),
      PINE_PIECES.flatMap((piece) => ["default", "lod1", "lod2"].map((variant) => `${pineKey(piece)}#${variant}`)).sort());

    // One opaque bark atlas and one cut-out needle atlas, KTX2 and stored once, inside the kit's cost limit.
    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 2);
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [...PINES_MATERIALS]);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[PINES_RELEASE]!), []);

    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, pineKey(PINE_PIECES[0]), "default", PINES_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(descriptor.assets.length, PINE_PIECES.length);
    const tan = Math.tan(30 * Math.PI / 180);
    for (const asset of descriptor.assets) {
      // Rooted at the trunk foot: the flare runs below the ground, and the tree stands up from it.
      assert.ok(asset.bounds.min[1] < -0.2 && asset.bounds.min[1] > -0.5, `${asset.key} roots below the ground`);
      assert.ok(asset.footprint.height > 2, `${asset.key} stands up`);
      const [lod0, lod1, lod2] = asset.lods.levels;
      assert.ok(lod0.triangles <= PINE_TRIANGLES, `${asset.key}: ${lod0.triangles} triangles`);
      assert.ok(lod1.triangles * 2 <= lod0.triangles, `${asset.key}: lod1 ${lod1.triangles} is at most half of ${lod0.triangles}`);
      assert.ok(lod2.triangles * 2 <= lod1.triangles, `${asset.key}: lod2 ${lod2.triangles} is at most half of ${lod1.triangles}`);
      assert.deepEqual(asset.lods.levels.map((level: any) => level.referenceMaxDistance), [...PINE_LOD_DISTANCES, null]);
      assert.ok(Math.abs(asset.lods.boundingSphere.radius / (lod1.minScreenSize * tan) - PINE_LOD_DISTANCES[1]) < 3, `${asset.key}: lod1 ends about ${PINE_LOD_DISTANCES[1]} m away`);
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
      let volume = 0;
      for (const [a, b, c] of mesh.triangles) {
        const [p, q, r] = [mesh.vertices[a], mesh.vertices[b], mesh.vertices[c]];
        volume += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
      }
      assert.ok(volume > 0, `${asset.key}: collision winds outward (${volume})`);
    }
    const piece = (kind: string) => descriptor.assets.find((asset: any) => asset.kind === kind);
    assert.ok(piece("scots-pine").footprint.height > piece("spruce").footprint.height, "the Scots pine is the tallest");
    assert.ok(piece("scots-pine").footprint.width > piece("scots-pine").footprint.height / 4, "the Scots pine's crown spreads wide");
    assert.ok(piece("spruce-young").footprint.height < piece("spruce").footprint.height / 2, "the young spruce is small");
    assert.ok(piece("pine-sapling").footprint.height < 3, "the sapling is small");
    const windswept = piece("scots-pine-windswept");
    assert.ok(windswept.bounds.max[0] > -windswept.bounds.min[0] + 1, "the windswept pine leans towards +X");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
