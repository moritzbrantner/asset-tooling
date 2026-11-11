// Monuments (docs/monuments.md, #550): the recipe builds a verified gltf-resources-v1 bundle of nine pieces on one atlas, whose
// solid pieces carry box collision, whose LODs at least halve and scale with size, whose walk-in mausoleum is a real room with
// a separate roof, and whose rebuild is byte-identical. The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import { MONUMENT_DESCRIPTOR_ATTACHMENT, MONUMENT_LOD_DISTANCES, MONUMENT_MATERIAL, MONUMENT_PARTS, MONUMENT_RELEASE, buildMonuments, createMonumentSpec, monumentKey } from "../../../scripts/build-monuments.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";
import { scaledLodDistances } from "../../../src/kit-bundle.js";

const box = (proxy: any) => ({ min: proxy.center.map((c: number, i: number) => c - proxy.size[i] / 2), max: proxy.center.map((c: number, i: number) => c + proxy.size[i] / 2) });

test("the monument spec runs the packaged recipe for exactly one piece", () => {
  const spec = createMonumentSpec({
    part: "statue", recipeSha256: { script: "a".repeat(64), outcrop: "b".repeat(64), limestone: "c".repeat(64), gravestones: "d".repeat(64) },
    inputSha256: { rockColour: "e".repeat(64), rockHeight: "f".repeat(64), mossColour: "0".repeat(64) }, blenderVersion: "5.2.2",
  });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, part: "statue" } });
  assert.equal(spec.assetId, "monuments.kit.statue");
  assert.equal(MONUMENT_RELEASE, "monuments", "one rolling release, never numbered");
});

test("the recipe builds a verified, reproducible kit on one atlas within its limits", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_500_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "monuments-"));
  const rebuildDir = await mkdtemp(path.join(os.tmpdir(), "monuments-rebuild-"));
  try {
    const built = await buildMonuments({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(),
      MONUMENT_PARTS.flatMap((part) => ["default", "lod1", "lod2"].map((variant) => `${monumentKey(part)}#${variant}`)).sort());

    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png") || name.endsWith(".jpg")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 3);
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [MONUMENT_MATERIAL]);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[MONUMENT_RELEASE]!), []);
    assert.ok(cost.maxima.triangles <= 9000, `${cost.maxima.triangles} triangles is within the hero-object guide`);

    const d = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, monumentKey(MONUMENT_PARTS[0]), "default", MONUMENT_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(d.assets.length, MONUMENT_PARTS.length);
    // mmorpg's lit material needs both, or a piece renders black up close.
    for (const part of MONUMENT_PARTS) for (const mesh of built.documents[part].getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
      assert.ok(primitive.getAttribute("COLOR_0") && primitive.getAttribute("TANGENT"), `${part} has vertex colours and tangents`);
    }
    for (const entry of d.assets) {
      const [lod0, lod1, lod2] = entry.lods.levels;
      assert.ok(lod1.triangles * 2 <= lod0.triangles && lod2.triangles * 2 <= lod1.triangles, `${entry.role}: LODs ${lod0.triangles} ${lod1.triangles} ${lod2.triangles} at least halve`);
      assert.deepEqual(entry.lods.levels.map((level: any) => level.referenceMaxDistance), [...scaledLodDistances(MONUMENT_LOD_DISTANCES, entry.bounds), null]);
      if (entry.role === "mausoleum-walk-in-roof") {
        assert.equal(entry.collision, "none", "the roof is out of reach, and is hidden while a character is inside");
        continue;
      }
      assert.ok(entry.collisionProxies.length >= 1, `${entry.role} has collision`);
      for (const proxy of entry.collisionProxies) assert.ok(proxy.size.every((side: number) => side > 0.05), `${entry.role}: ${proxy.name} is a real box`);
    }

    const byRole = Object.fromEntries(d.assets.map((entry: any) => [entry.role, entry]));
    const walkIn = byRole["mausoleum-walk-in"];
    assert.equal(walkIn.interior.roof, "mausoleum-walk-in-roof", "the walk-in names its roof piece");
    const { center, size } = walkIn.interior.volume;
    const room = { min: center.map((c: number, i: number) => c - size[i] / 2), max: center.map((c: number, i: number) => c + size[i] / 2) };
    const proxies = Object.fromEntries(walkIn.collisionProxies.map((proxy: any) => [proxy.name, box(proxy)]));
    const halfDoor = 0.8;
    assert.ok(proxies["side-left"].max[0] <= room.min[0] + 0.1 && proxies["side-right"].min[0] >= room.max[0] - 0.1, "the side walls stand outside the room");
    assert.ok(proxies.back.max[2] <= room.min[2] + 0.1, "the back wall stands behind the room");
    assert.ok(proxies["pier-left"].max[0] <= -halfDoor + 0.05 && proxies["pier-right"].min[0] >= halfDoor - 0.05, "the piers leave the doorway open");
    assert.ok(proxies.lintel.min[1] >= 2.5, "a character can walk under the lintel");
    assert.ok(proxies.floor.max[1] < 0.4, "the floor is a low step");
    // The two pieces share one frame, so the roof lands on top of the walls.
    const roof = byRole["mausoleum-walk-in-roof"];
    assert.ok(Math.abs(roof.bounds.min[1] - walkIn.bounds.max[1]) < 0.15, `roof ${roof.bounds.min[1]} meets walls ${walkIn.bounds.max[1]}`);
    assert.ok(Math.abs((roof.bounds.min[0] + roof.bounds.max[0]) / 2) < 0.1, "the roof is centred in the shared frame");

    const rebuilt = await buildMonuments({ outDir: rebuildDir });
    assert.equal(rebuilt.tarSha256, built.tarSha256, "two builds give identical tars");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(rebuildDir, { recursive: true, force: true });
  }
});
