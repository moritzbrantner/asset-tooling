// Gravestones (docs/gravestones.md, #548): the recipe builds a verified gltf-resources-v1 bundle of nine pieces on one atlas,
// whose solid pieces carry box collision, whose LODs at least halve and scale with size, and whose rebuild is byte-identical.
// The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import { GRAVESTONE_DESCRIPTOR_ATTACHMENT, GRAVESTONE_LOD_DISTANCES, GRAVESTONE_MATERIAL, GRAVESTONE_PARTS, GRAVESTONE_RELEASE, buildGravestones, createGravestoneSpec, gravestoneKey } from "../../../scripts/build-gravestones.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";
import { scaledLodDistances } from "../../../src/kit-bundle.js";

test("the gravestone spec runs the packaged recipe for exactly one piece", () => {
  const spec = createGravestoneSpec({
    part: "cross", recipeSha256: { script: "a".repeat(64), outcrop: "b".repeat(64), limestone: "c".repeat(64) },
    inputSha256: { rockColour: "d".repeat(64), rockHeight: "e".repeat(64), mossColour: "f".repeat(64) }, blenderVersion: "5.2.2",
  });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, part: "cross" } });
  assert.equal(spec.assetId, "gravestones.kit.cross");
  assert.equal(GRAVESTONE_RELEASE, "gravestones", "one rolling release, never numbered");
});

test("the recipe builds a verified, reproducible kit on one atlas within its limits", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_200_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "gravestones-"));
  const rebuildDir = await mkdtemp(path.join(os.tmpdir(), "gravestones-rebuild-"));
  try {
    const built = await buildGravestones({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(),
      GRAVESTONE_PARTS.flatMap((part) => ["default", "lod1", "lod2"].map((variant) => `${gravestoneKey(part)}#${variant}`)).sort());

    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png") || name.endsWith(".jpg")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 3);
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [GRAVESTONE_MATERIAL]);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[GRAVESTONE_RELEASE]!), []);
    assert.ok(cost.maxima.triangles <= 2000, `${cost.maxima.triangles} triangles is within the small-prop guide`);

    const d = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, gravestoneKey(GRAVESTONE_PARTS[0]), "default", GRAVESTONE_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(d.assets.length, GRAVESTONE_PARTS.length);
    // mmorpg's lit material needs both, or a piece renders black up close.
    for (const part of GRAVESTONE_PARTS) for (const mesh of built.documents[part].getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
      assert.ok(primitive.getAttribute("COLOR_0") && primitive.getAttribute("TANGENT"), `${part} has vertex colours and tangents`);
    }
    for (const entry of d.assets) {
      const [lod0, lod1, lod2] = entry.lods.levels;
      assert.ok(lod1.triangles * 2 <= lod0.triangles && lod2.triangles * 2 <= lod1.triangles, `${entry.role}: LODs ${lod0.triangles} ${lod1.triangles} ${lod2.triangles} at least halve`);
      assert.deepEqual(entry.lods.levels.map((level: any) => level.referenceMaxDistance), [...scaledLodDistances(GRAVESTONE_LOD_DISTANCES, entry.bounds), null]);
      assert.ok(entry.bounds.min[1] < 0 && entry.bounds.max[1] > 0, `${entry.role} stands across y = 0`);
      if (entry.role === "footstone") {
        assert.equal(entry.collision, "none", "a footstone is low enough to step over");
        continue;
      }
      assert.ok(entry.collisionProxies.length >= 1, `${entry.role} has collision`);
      for (const proxy of entry.collisionProxies) assert.ok(proxy.size.every((side: number) => side > 0.05), `${entry.role}: ${proxy.name} is a real box`);
    }
    const byRole = Object.fromEntries(d.assets.map((entry: any) => [entry.role, entry]));
    const tomb = byRole["chest-tomb"].collisionProxies[0];
    assert.ok(tomb.center[1] + tomb.size[1] / 2 > 0.85, "the chest tomb's box reaches its lid");
    const arm = byRole.cross.collisionProxies.find((proxy: any) => proxy.name === "arm");
    assert.ok(arm.center[1] - arm.size[1] / 2 > 1, "the cross's arm box stays up at the arm, so a character can pass under it");

    const rebuilt = await buildGravestones({ outDir: rebuildDir });
    assert.equal(rebuilt.tarSha256, built.tarSha256, "two builds give identical tars");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(rebuildDir, { recursive: true, force: true });
  }
});
