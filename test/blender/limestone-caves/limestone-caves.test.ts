// Limestone caves (docs/limestone-caves.md, #559): the recipe builds a verified gltf-resources-v1 bundle of twelve pieces on two tiling
// materials, whose modules declare their openings and end exactly on the shared arch, whose LODs at least halve and whose rebuild is
// byte-identical. The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import { CAVE_DESCRIPTOR_ATTACHMENT, CAVE_LOD_DISTANCES, CAVE_MATERIALS, CAVE_PIECES, CAVE_RELEASE, CAVE_TRIANGLE_BUDGET, CAVE_VARIANTS, buildLimestoneCaves, caveKey, createCaveSpec } from "../../../scripts/build-limestone-caves.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";
import { scaledLodDistances } from "../../../src/kit-bundle.js";

const HALF = 2.15, TALL = 3.3, OVERLAP = 0.25;

test("the cave spec runs the packaged recipe for exactly one piece", () => {
  const spec = createCaveSpec({
    piece: "ramp", recipeSha256: { script: "a".repeat(64), outcrop: "b".repeat(64), common: "c".repeat(64) },
    inputSha256: { rockColour: "d".repeat(64), rockHeight: "e".repeat(64), gravelColour: "f".repeat(64), earthColour: "0".repeat(64) }, blenderVersion: "5.2.2",
  });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, piece: "ramp" } });
  assert.equal(spec.assetId, "limestone-caves.kit.ramp");
  assert.equal(CAVE_RELEASE, "limestone-caves", "one rolling release, never numbered");
});

test("the recipe builds a verified, reproducible kit whose modules meet on the shared arch", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_500_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "limestone-caves-"));
  const rebuildDir = await mkdtemp(path.join(os.tmpdir(), "limestone-caves-rebuild-"));
  try {
    const built = await buildLimestoneCaves({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(),
      CAVE_PIECES.flatMap((piece) => CAVE_VARIANTS.map((variant) => `${caveKey(piece)}#${variant}`)).sort());

    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png") || name.endsWith(".jpg")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 4, "a colour and a normal map for rock and for floor");
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual([...cost.materials].sort(), [...CAVE_MATERIALS]);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[CAVE_RELEASE]!), []);
    assert.ok(cost.maxima.triangles <= CAVE_TRIANGLE_BUDGET, `${cost.maxima.triangles} triangles`);

    const d = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, caveKey(CAVE_PIECES[0]), "default", CAVE_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(d.assets.length, CAVE_PIECES.length);
    for (const entry of d.assets) {
      const [lod0, lod1, lod2] = entry.lods.levels;
      assert.ok(lod1.triangles * 2 <= lod0.triangles && lod2.triangles * 2 <= lod1.triangles, `${entry.role}: LODs ${lod0.triangles} ${lod1.triangles} ${lod2.triangles} at least halve`);
      assert.deepEqual(entry.lods.levels.map((level: any) => level.referenceMaxDistance), [...scaledLodDistances(CAVE_LOD_DISTANCES, entry.bounds), null]);
      if (entry.role.startsWith("spikes")) continue;
      assert.ok(entry.openings.length >= 1, `${entry.role} has openings`);
      assert.ok(entry.collisionMesh.triangles.length <= 430, `${entry.role}: ${entry.collisionMesh.triangles.length} collision triangles`);
      for (const opening of entry.openings) {
        assert.equal(opening.width, 4);
        assert.equal(opening.height, 3);
        assert.equal(Math.abs(opening.facing[0]) + Math.abs(opening.facing[2]), 1, `${entry.role}: ${opening.name} faces along an axis`);
      }
    }
    const byRole = Object.fromEntries(d.assets.map((entry: any) => [entry.role, entry]));
    assert.deepEqual(byRole.tunnel.openings.map((opening: any) => opening.position), [[0, 0, 4], [0, 0, -4]]);
    assert.deepEqual(byRole.ramp.openings.map((opening: any) => opening.position[1]), [0, -4], "the ramp drops 4 m");
    assert.equal(byRole["room-large"].openings.length, 4);
    assert.equal(byRole["spikes-roof"].collision, "none");

    for (const piece of CAVE_PIECES) for (const mesh of built.documents[piece].getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
      // mmorpg's lit material needs both, or a piece renders black up close.
      assert.ok(primitive.getAttribute("COLOR_0") && primitive.getAttribute("TANGENT"), `${piece} has vertex colours and tangents`);
    }
    // Every vertex at the end of a passage sits on the one arch, so neighbouring modules meet.
    for (const piece of ["tunnel", "ramp"] as const) {
      let rim = 0;
      for (const mesh of built.documents[piece].getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
        const position = primitive.getAttribute("POSITION")!;
        for (let i = 0, p = [0, 0, 0]; i < position.getCount(); i += 1) {
          position.getElement(i, p);
          if (Math.abs(Math.abs(p[2]!) - (4 + OVERLAP)) > 1e-3) continue;
          rim += 1;
          const rise = p[1]! - (piece === "ramp" && p[2]! < 0 ? -4 : 0);
          if (rise < 0.08) assert.ok(Math.abs(p[0]!) <= HALF + 1e-3, `${piece}: floor rim ${p}`);
          else assert.ok(Math.abs(Math.hypot(p[0]! / HALF, rise / TALL) - 1) < 1e-3, `${piece}: rim vertex ${p} is on the arch`);
        }
      }
      assert.ok(rim >= 20, `${piece} has a rim at each end (${rim} vertices)`);
    }

    const rebuilt = await buildLimestoneCaves({ outDir: rebuildDir });
    assert.equal(rebuilt.tarSha256, built.tarSha256, "two builds give identical tars");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(rebuildDir, { recursive: true, force: true });
  }
});
