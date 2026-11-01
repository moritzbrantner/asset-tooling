// Climbing kit (#394, docs/climbing-kit.md): the scripted Blender recipe builds a verified gltf-resources-v1 bundle of
// ladders, ropes and ivy whose rungs sit exactly 0.30 m apart (the Ranger's Ladder_* rungSpacingMeters), whose
// tiles stack on the same pitch, whose grip-line empties match the descriptor and whose LOD chains shrink. The
// build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2 and the ivy-leaf payload is hydrated.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Document } from "@gltf-transform/core";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import { emptyTranslation } from "../../../src/kit-bundle.js";
import {
  CLIMBING_DESCRIPTOR_ATTACHMENT, CLIMBING_LEAVES, CLIMBING_PARTS, CLIMBING_RELEASE, buildClimbingKit, climbingKey, createClimbingAssetSpec,
} from "../../../scripts/build-climbing-kit.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const storage = JSON.parse(await readFile(path.join(root, "catalog/storage.json"), "utf8"));
const leaves = storage.entries.find((entry: any) => entry.sourceId === CLIMBING_LEAVES);
const hydrated = leaves && !(await readFile(path.join(root, leaves.path))).subarray(0, 64).toString().startsWith("version https://git-lfs");
const skip = !process.env.ASSET_TOOLING_BLENDER ? "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)"
  : !hydrated ? "requires the hydrated ivy-leaf payload (git lfs pull)" : false;

/** Heights of the rung axes, from the vertex rings of the rungs' tenon ends (LOD0). */
function rungHeights(document: Document, radius: number): number[] {
  const ys = new Map<number, number>();
  for (const node of document.getRoot().listNodes()) for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
    if (primitive.getMaterial()?.getName() !== "climbing-wood") continue;
    const position = primitive.getAttribute("POSITION")!, v: number[] = [0, 0, 0];
    for (let i = 0; i < position.getCount(); i += 1) {
      position.getElement(i, v);
      // Only the rungs' tenon ends reach past the rails' outer faces (|x| > 0.3 m); group their rings by height.
      if (Math.abs(v[0]!) > 0.303) { const key = Math.round(v[1]! * 1000); ys.set(key, (ys.get(key) ?? 0) + 1); }
    }
  }
  // A rung's ring spans y ± radius; its axis is the mean of the extreme rows.
  const rows = [...ys.keys()].sort((a, b) => a - b).map((k) => k / 1000);
  const axes: number[] = [];
  for (const y of rows) if (!axes.length || y - axes[axes.length - 1]! > radius * 3) axes.push(y);
  return axes.map((low) => Number((low + radius).toFixed(3)));
}

test("the climbing spec runs the packaged recipe with one part at one level", () => {
  const spec = createClimbingAssetSpec({ part: "ladder-6m", lod: 1, scriptSha256: "a".repeat(64), commonSha256: "b".repeat(64), leavesSha256: "c".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, part: "ladder-6m", lod: 1 } });
  assert.equal(spec.assetId, "climbing.kit.ladder-6m");
  assert.equal(CLIMBING_PARTS.length, 15);
  assert.equal(CLIMBING_RELEASE, "climbing-kit", "one rolling release, never numbered");
});

test("the climbing recipe builds a verified bundle with 0.30 m rungs, stackable tiles, grip lines and shrinking LOD chains", { skip, timeout: 1_800_000 }, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "climbing-kit-"));
  try {
    const built = await buildClimbingKit({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}/${entry.variant}`).sort(),
      CLIMBING_PARTS.flatMap((part) => ["default", "lod1", "lod2"].map((v) => `${climbingKey(part)}/${v}`)).sort());
    const d = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, "climbing.kit.ladder-3m", "default", CLIMBING_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    const asset = Object.fromEntries(d.assets.map((a: any) => [a.role, a]));

    // Ladders: rungs exactly 0.30 m apart, in the geometry and the descriptor; a section stacks on the same pitch.
    for (const part of ["ladder-3m", "ladder-6m", "ladder-9m", "ladder-section", "ladder-top"] as const) {
      const { rungs, gripLine } = asset[part].climb;
      assert.equal(rungs.spacing, 0.3);
      const measured = rungHeights(built.documents[`${part}.default`]!, rungs.radius);
      assert.equal(measured.length, rungs.count, `${part} rung count`);
      measured.forEach((y, k) => assert.ok(Math.abs(y - (rungs.first + 0.3 * k)) < 2e-3, `${part} rung ${k} at ${y}`));
      assert.deepEqual(emptyTranslation(built.documents[`${part}.default`]!, "climb.bottom"), gripLine.from);
      assert.deepEqual(emptyTranslation(built.documents[`${part}.default`]!, "climb.top"), gripLine.to);
      assert.ok(Math.abs(asset[part].footprint.width - 0.6) < 1e-6);
    }
    const section = asset["ladder-section"].climb;
    assert.ok(Math.abs(section.rungs.first + section.rungs.count * 0.3 - (section.tile.pitch + section.rungs.first)) < 1e-6, "the next section's first rung is one pitch on");

    // Ropes: 50 mm thick, 0.30 m off the face, a knot every 0.6 m.
    for (const part of ["rope-4m", "rope-8m", "rope-12m", "rope-section"] as const) {
      const { radius, gripLine, knots } = asset[part].climb;
      assert.equal(radius, 0.025);
      assert.equal(gripLine.from[2], 0.3);
      for (let k = 1; k < knots.length; k += 1) assert.ok(Math.abs(knots[k] - knots[k - 1] - 0.6) < 1e-6, `${part} knot pitch`);
    }
    for (const part of ["rope-4m", "rope-8m", "rope-12m"] as const) assert.ok(Math.abs(asset[part].bounds.max[1] - Number(part.slice(5, -1))) < 0.01, `${part} reaches its length`);

    // Vines: the leaf cards are alpha-masked cut-outs over a 1 m wide strip.
    const leaf = built.documents["vine-strip.default"]!.getRoot().listMaterials().find((m) => m.getName() === "climbing-leaf");
    assert.equal(leaf?.getAlphaMode(), "MASK");
    assert.equal(asset["vine-strip"].climb.tile.pitch, 2);

    // Every chain shrinks and every part has a climbable proxy.
    for (const a of d.assets) {
      const counts = a.lods.levels.map((l: any) => l.triangles);
      assert.ok(counts[0] > counts[1] && counts[1] > counts[2], `${a.role} LOD chain ${counts}`);
      assert.deepEqual(a.lods.levels.map((l: any) => l.variant), ["default", "lod1", "lod2"]);
      if (a.role !== "rope-anchor") assert.ok(a.collisionProxies.some((p: any) => p.tag === "climbable"), `${a.role} proxy`);
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
