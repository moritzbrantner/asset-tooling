// Moss (docs/moss.md, #554): the recipe builds a verified gltf-resources-v1 bundle of seven pieces on one cut-out atlas, with
// tangents, upward-facing surfaces, LODs that at least halve and scale with size, collision declared absent, and a byte-identical
// rebuild. The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import { MOSS_DESCRIPTOR_ATTACHMENT, MOSS_LOD_DISTANCES, MOSS_MATERIAL, MOSS_PIECES, MOSS_RELEASE, MOSS_TRIANGLE_BUDGET, MOSS_VARIANTS, buildMoss, createMossSpec, mossKey } from "../../../scripts/build-moss.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";
import { scaledLodDistances } from "../../../src/kit-bundle.js";

test("the moss spec runs the packaged recipe for exactly one level of one piece", () => {
  const spec = createMossSpec({ piece: "scatter", level: 2, scriptSha256: "a".repeat(64), outcropSha256: "b".repeat(64), scanSha256: "c".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, piece: "scatter", level: 2 } });
  assert.equal(spec.assetId, "moss.kit.scatter");
  assert.equal(MOSS_RELEASE, "moss", "one rolling release, never numbered");
});

test("the recipe builds a verified, reproducible kit on one atlas within its limits", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 900_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "moss-"));
  const rebuildDir = await mkdtemp(path.join(os.tmpdir(), "moss-rebuild-"));
  try {
    const built = await buildMoss({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(),
      MOSS_PIECES.flatMap((piece) => MOSS_VARIANTS.map((variant) => `${mossKey(piece)}#${variant}`)).sort());

    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png") || name.endsWith(".jpg")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 2, "one shared colour and one shared normal map");
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [MOSS_MATERIAL]);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[MOSS_RELEASE]!), []);
    assert.ok(cost.maxima.triangles <= MOSS_TRIANGLE_BUDGET, `${cost.maxima.triangles} triangles`);

    const d = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, mossKey(MOSS_PIECES[0]), "default", MOSS_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(d.assets.length, MOSS_PIECES.length);
    for (const entry of d.assets) {
      assert.equal(entry.collision, "none", `${entry.role}: walk-on moss declares no collision`);
      const [lod0, lod1, lod2] = entry.lods.levels;
      assert.ok(lod1.triangles * 2 <= lod0.triangles && lod2.triangles * 2 <= lod1.triangles, `${entry.role}: LODs ${lod0.triangles} ${lod1.triangles} ${lod2.triangles} at least halve`);
      assert.deepEqual(entry.lods.levels.map((level: any) => level.referenceMaxDistance), [...scaledLodDistances(MOSS_LOD_DISTANCES, entry.bounds), null]);
    }

    for (const piece of MOSS_PIECES) for (const mesh of built.documents[piece].getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
      // mmorpg's lit material needs both, or a piece renders black up close.
      assert.ok(primitive.getAttribute("COLOR_0") && primitive.getAttribute("TANGENT"), `${piece} has vertex colours and tangents`);
      assert.equal(primitive.getMaterial()!.getAlphaMode(), "MASK", `${piece} is a cut-out`);
    }
    // A flat piece faces up, or culling would hide it.
    const primitive = built.documents["ground-mat"].getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    const normals = primitive.getAttribute("NORMAL")!;
    let upward = 0;
    for (let i = 0, n = [0, 0, 0]; i < normals.getCount(); i += 1) upward += normals.getElement(i, n)[1]! > 0 ? 1 : -1;
    assert.equal(upward, normals.getCount(), "every ground-mat normal points up");

    const rebuilt = await buildMoss({ outDir: rebuildDir });
    assert.equal(rebuilt.tarSha256, built.tarSha256, "two builds give identical tars");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(rebuildDir, { recursive: true, force: true });
  }
});
