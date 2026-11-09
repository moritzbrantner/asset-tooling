// Ivy (docs/ivy.md, #552): the recipe builds a verified gltf-resources-v1 bundle of seven pieces on one leaf atlas, with cards
// that face outward, LODs that at least halve and scale with size, collision declared absent, and a byte-identical rebuild.
// The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import { IVY_DESCRIPTOR_ATTACHMENT, IVY_LEAF_MATERIAL, IVY_LOD_DISTANCES, IVY_PIECES, IVY_RELEASE, IVY_STEM_MATERIAL, IVY_TRIANGLE_BUDGET, IVY_VARIANTS, buildIvy, createIvySpec, ivyKey } from "../../../scripts/build-ivy.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";
import { scaledLodDistances } from "../../../src/kit-bundle.js";

test("the ivy spec runs the packaged recipe for exactly one level of one piece", () => {
  const spec = createIvySpec({ piece: "curtain", level: 1, scriptSha256: "a".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, piece: "curtain", level: 1 } });
  assert.equal(spec.assetId, "ivy.kit.curtain");
  assert.equal(IVY_RELEASE, "ivy", "one rolling release, never numbered");
});

test("the recipe builds a verified, reproducible kit on one atlas within its limits", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 900_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "ivy-"));
  const rebuildDir = await mkdtemp(path.join(os.tmpdir(), "ivy-rebuild-"));
  try {
    const built = await buildIvy({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(),
      IVY_PIECES.flatMap((piece) => IVY_VARIANTS.map((variant) => `${ivyKey(piece)}#${variant}`)).sort());

    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png") || name.endsWith(".jpg")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 1, "one shared leaf atlas");
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual([...cost.materials].sort(), [IVY_LEAF_MATERIAL, IVY_STEM_MATERIAL].sort(), "one cut-out and one opaque material");
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[IVY_RELEASE]!), []);
    assert.ok(cost.maxima.triangles <= IVY_TRIANGLE_BUDGET, `${cost.maxima.triangles} triangles`);

    const d = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, ivyKey(IVY_PIECES[0]), "default", IVY_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(d.assets.length, IVY_PIECES.length);
    for (const entry of d.assets) {
      assert.equal(entry.collision, "none", `${entry.role}: walk-through foliage declares no collision`);
      const [lod0, lod1, lod2] = entry.lods.levels;
      assert.ok(lod1.triangles * 2 <= lod0.triangles && lod2.triangles * 2 <= lod1.triangles, `${entry.role}: LODs ${lod0.triangles} ${lod1.triangles} ${lod2.triangles} at least halve`);
      assert.deepEqual(entry.lods.levels.map((level: any) => level.referenceMaxDistance), [...scaledLodDistances(IVY_LOD_DISTANCES, entry.bounds), null]);
    }

    for (const piece of IVY_PIECES) for (const mesh of built.documents[piece].getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
      // mmorpg reads a missing COLOR_0 from WebGL's global default, and the leaves' hue is COLOR_0.
      assert.ok(primitive.getAttribute("COLOR_0"), `${piece} has vertex colours`);
    }
    // A wall piece's cards look out of the wall, towards +Z.
    const leaves = built.documents["wall-patch"].getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives()).find((primitive) => primitive.getMaterial()?.getName() === IVY_LEAF_MATERIAL)!;
    assert.equal(leaves.getMaterial()!.getAlphaMode(), "MASK", "the leaves are a cut-out");
    const normals = leaves.getAttribute("NORMAL")!;
    let outward = 0;
    for (let i = 0, n = [0, 0, 0]; i < normals.getCount(); i += 1) outward += normals.getElement(i, n)[2]! > 0 ? 1 : -1;
    assert.ok(outward > normals.getCount() * 0.8, `${outward} of ${normals.getCount()} leaf normals point out of the wall`);

    const rebuilt = await buildIvy({ outDir: rebuildDir });
    assert.equal(rebuilt.tarSha256, built.tarSha256, "two builds give identical tars");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(rebuildDir, { recursive: true, force: true });
  }
});
