// River stones (docs/river-stones.md, #538): the recipe builds a verified gltf-resources-v1 bundle of eleven pieces on one
// atlas, whose solid stones carry closed collision, whose debris declares none and whose LODs at least halve.
// The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import { RIVER_DESCRIPTOR_ATTACHMENT, RIVER_LOD_DISTANCES, RIVER_MATERIAL, RIVER_PARTS, RIVER_RELEASE, buildRiverStones, createRiverSpec, riverKey } from "../../../scripts/build-river-stones.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";

test("the river spec runs the packaged recipe for exactly one piece", () => {
  const spec = createRiverSpec({
    part: "bank-1", recipeSha256: { script: "a".repeat(64), outcrop: "b".repeat(64), limestone: "c".repeat(64) },
    inputSha256: { rockColour: "d".repeat(64), rockHeight: "e".repeat(64), grassColour: "f".repeat(64), gravelColour: "0".repeat(64), mossColour: "1".repeat(64) }, blenderVersion: "5.2.2",
  });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, part: "bank-1" } });
  assert.equal(spec.assetId, "river-stones.kit.bank-1");
  assert.equal(RIVER_RELEASE, "river-stones", "one rolling release, never numbered");
});

test("the recipe builds a verified kit on one atlas within its limits", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_500_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "river-stones-"));
  try {
    const built = await buildRiverStones({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(),
      RIVER_PARTS.flatMap((part) => ["default", "lod1", "lod2"].map((variant) => `${riverKey(part)}#${variant}`)).sort());

    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png") || name.endsWith(".jpg")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 3);
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [RIVER_MATERIAL]);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[RIVER_RELEASE]!), []);

    const d = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, riverKey(RIVER_PARTS[0]), "default", RIVER_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(d.assets.length, RIVER_PARTS.length);
    for (const entry of d.assets) {
      const [lod0, lod1, lod2] = entry.lods.levels;
      assert.ok(lod1.triangles * 2 <= lod0.triangles && lod2.triangles * 2 <= lod1.triangles, `${entry.role}: LODs ${lod0.triangles} ${lod1.triangles} ${lod2.triangles} at least halve`);
      assert.deepEqual(entry.lods.levels.map((level: any) => level.referenceMaxDistance), [...RIVER_LOD_DISTANCES, null]);
      assert.ok(entry.bounds.min[1] < 0 && entry.bounds.max[1] > 0, `${entry.role} stands across y = 0`);
      if (entry.kind !== "boulder" && entry.kind !== "step") {
        assert.equal(entry.collision, "none", `${entry.role}: walk-on debris declares no collision`);
        continue;
      }
      const { vertices, triangles: faces } = entry.collisionMesh as { vertices: number[][]; triangles: [number, number, number][] };
      const edges = new Map<string, number>();
      let signed = 0;
      for (const [a, b, c] of faces) {
        for (const [from, to] of [[a, b], [b, c], [c, a]] as const) edges.set(`${from}>${to}`, (edges.get(`${from}>${to}`) ?? 0) + 1);
        const [p, q, r] = [vertices[a]!, vertices[b]!, vertices[c]!];
        signed += (p[0]! * (q[1]! * r[2]! - q[2]! * r[1]!) - p[1]! * (q[0]! * r[2]! - q[2]! * r[0]!) + p[2]! * (q[0]! * r[1]! - q[1]! * r[0]!)) / 6;
      }
      for (const [edge, count] of edges) {
        const [from, to] = edge.split(">");
        assert.equal(count, 1, `${entry.role}: directed edge ${edge} repeats`);
        assert.equal(edges.get(`${to}>${from}`), 1, `${entry.role}: edge ${edge} has no partner, so the mesh is open`);
      }
      assert.ok(faces.length <= 240, `${entry.role}: ${faces.length} collision triangles`);
      assert.ok(signed > 0, `${entry.role}: the collision mesh winds outward`);
      if (entry.kind === "step") {
        // A stepping stone's top is cut nearly flat, so a character can stand on it.
        const ys = vertices.map((v) => v[1]!);
        const top = Math.max(...ys);
        assert.ok(ys.filter((y) => y > top - 0.04).length >= 3, `${entry.role} has a flat top`);
      }
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
