// Wolf den (docs/wolf-den.md, #754): the recipe builds a verified gltf-resources-v1 bundle of the den mouth and its ground
// dressing on one atlas, whose den carries box collision that leaves the bedding in front free, whose LODs at least halve and
// scale with size, and whose rebuild is byte-identical. The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import { WOLF_DEN_DESCRIPTOR_ATTACHMENT, WOLF_DEN_LOD_DISTANCES, WOLF_DEN_MATERIAL, WOLF_DEN_PARTS, WOLF_DEN_RELEASE, buildWolfDen, createWolfDenSpec, wolfDenKey } from "../../../scripts/build-wolf-den.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";
import { scaledLodDistances } from "../../../src/kit-bundle.js";

test("the wolf den spec runs the packaged recipe for exactly one piece", () => {
  const spec = createWolfDenSpec({
    part: "den-mouth", recipeSha256: { script: "a".repeat(64), outcrop: "b".repeat(64), limestone: "c".repeat(64) },
    inputSha256: { rockColour: "d".repeat(64), rockHeight: "e".repeat(64), mossColour: "f".repeat(64), groundColour: "0".repeat(64) }, blenderVersion: "5.2.2",
  });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, part: "den-mouth" } });
  assert.equal(spec.assetId, "wolf-den.kit.den-mouth");
  assert.equal(WOLF_DEN_RELEASE, "wolf-den", "one rolling release, never numbered");
});

test("the recipe builds a verified, reproducible den on one atlas within its limits", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_200_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "wolf-den-"));
  const rebuildDir = await mkdtemp(path.join(os.tmpdir(), "wolf-den-rebuild-"));
  try {
    const built = await buildWolfDen({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(),
      WOLF_DEN_PARTS.flatMap((part) => ["default", "lod1", "lod2"].map((variant) => `${wolfDenKey(part)}#${variant}`)).sort());

    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png") || name.endsWith(".jpg")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 3);
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [WOLF_DEN_MATERIAL]);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[WOLF_DEN_RELEASE]!), []);
    assert.ok(cost.maxima.triangles <= 9000, `${cost.maxima.triangles} triangles is within the hero-object guide`);

    const d = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, wolfDenKey(WOLF_DEN_PARTS[0]), "default", WOLF_DEN_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(d.assets.length, WOLF_DEN_PARTS.length);
    // mmorpg's lit material needs both, or a piece renders black up close.
    for (const part of WOLF_DEN_PARTS) for (const mesh of built.documents[part].getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
      assert.ok(primitive.getAttribute("COLOR_0") && primitive.getAttribute("TANGENT"), `${part} has vertex colours and tangents`);
    }
    for (const entry of d.assets) {
      const [lod0, lod1, lod2] = entry.lods.levels;
      assert.ok(lod1.triangles * 2 <= lod0.triangles && lod2.triangles * 2 <= lod1.triangles, `${entry.role}: LODs ${lod0.triangles} ${lod1.triangles} ${lod2.triangles} at least halve`);
      assert.deepEqual(entry.lods.levels.map((level: any) => level.referenceMaxDistance), [...scaledLodDistances(WOLF_DEN_LOD_DISTANCES, entry.bounds), null]);
    }
    const byRole = Object.fromEntries(d.assets.map((entry: any) => [entry.role, entry]));
    for (const role of ["bone-scatter", "bedding-patch"]) assert.equal(byRole[role].collision, "none", `${role} is walk-on dressing`);
    const den = byRole["den-mouth"];
    assert.ok(den.bounds.min[1] < 0 && den.bounds.max[1] > 2, "the den's bank stands across y = 0 and rises over two metres");
    assert.deepEqual(den.collisionProxies.map((proxy: any) => proxy.name), ["left", "right", "bank"]);
    for (const proxy of den.collisionProxies) {
      assert.ok(proxy.size.every((side: number) => side > 0.5), `${proxy.name} is a real box`);
      // The bedding in front of the mouth, where a wolf rests, stays outside every box.
      assert.ok(proxy.center[2] + proxy.size[2] / 2 < 1.0, `${proxy.name} leaves the bedding free`);
    }

    const rebuilt = await buildWolfDen({ outDir: rebuildDir });
    assert.equal(rebuilt.tarSha256, built.tarSha256, "two builds give identical tars");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(rebuildDir, { recursive: true, force: true });
  }
});
