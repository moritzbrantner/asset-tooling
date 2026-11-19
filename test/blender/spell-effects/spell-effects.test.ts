// Spell effect meshes (#726, #771, docs/spell-effects.md): the recipe builds a verified gltf-resources-v1 bundle of school
// bolts, impacts, a frost nova, a beam segment, heal motes and three static shot models, each under 240 triangles; the
// effects carry one Loop or Play clip of their declared length, RGBA COLOR_0 and core-glTF blended materials, the shots
// one opaque material; and it replays to the same tar. The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import {
  SPELL_CLIPS, SPELL_DESCRIPTOR_ATTACHMENT, SPELL_DESCRIPTOR_SCHEMA, SPELL_EFFECTS, SPELL_MATERIALS, SPELL_RELEASE, SPELL_TRIANGLE_BUDGET,
  buildSpellEffects, createSpellSpec, spellKey,
} from "../../../scripts/build-spell-effects.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";

const SHOTS = ["arrow", "crossbow-bolt", "throwing-knife"];
const HOLDS = ["roots-hold-loop", "roots-hold-end", "frost-hold-loop", "frost-hold-end"];

test("the spell effect spec runs the packaged recipe for exactly one entry", () => {
  const spec = createSpellSpec({ entry: "frost-nova", scriptSha256: "a".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, entry: "frost-nova" } });
  assert.equal(spec.assetId, "spell.effects.frost-nova");
  assert.equal(SPELL_RELEASE, "spell-effects", "one rolling release, never numbered");
});

test("the recipe builds a verified, reproducible bundle of small spell effects and shots", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_200_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "spell-effects-"));
  const replayDir = await mkdtemp(path.join(os.tmpdir(), "spell-effects-replay-"));
  try {
    const built = await buildSpellEffects({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => entry.key).sort(), SPELL_EFFECTS.map(spellKey).sort());

    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [...SPELL_MATERIALS]);
    assert.equal(cost.textures, 0, "no textures: colour and opacity are per vertex");
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[SPELL_RELEASE]!), []);

    for (const [entry, document] of Object.entries(built.documents)) {
      const root = document.getRoot();
      const clip = SPELL_CLIPS[entry as keyof typeof SPELL_CLIPS];
      assert.deepEqual(root.listAnimations().map((animation) => animation.getName()), clip ? [clip.name] : [], `${entry} clips`);
      for (const material of root.listMaterials()) {
        assert.equal(material.getAlphaMode(), material.getName() === "shot" ? "OPAQUE" : "BLEND", `${entry} ${material.getName()} alpha mode`);
        assert.ok(material.getDoubleSided(), `${entry} ${material.getName()} is double-sided`);
        assert.equal(material.listExtensions().length, 0, `${entry} ${material.getName()} is core glTF`);
      }
      for (const mesh of root.listMeshes()) for (const primitive of mesh.listPrimitives()) {
        assert.equal(primitive.getAttribute("COLOR_0")?.getType(), "VEC4", `${entry} carries RGBA vertex colour`);
      }
    }

    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, spellKey(SPELL_EFFECTS[0]), "default", SPELL_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(descriptor.schema, SPELL_DESCRIPTOR_SCHEMA);
    const byRole = Object.fromEntries(descriptor.assets.map((asset: any) => [asset.role, asset]));
    for (const entry of SPELL_EFFECTS) {
      const asset = byRole[entry];
      assert.ok(asset.triangles <= SPELL_TRIANGLE_BUDGET, `${entry}: ${asset.triangles} triangles`);
      const clip = SPELL_CLIPS[entry];
      assert.deepEqual(asset.clip, clip ? { ...clip, loop: clip.name === "Loop" } : null);
      assert.match(asset.tint.colour, /^#[0-9a-f]{6}$/, `${entry} names its tint`);
    }
    // Bolts and shots start at their tip and trail back along -Z; the nova and motes stay on and above the ground;
    // the beam runs from 0 to its tile length.
    for (const entry of ["bolt-fire", "bolt-shadow", "bolt-holy", "bolt-nature", ...SHOTS, "grapple-hook"]) {
      assert.equal(byRole[entry].align, "tip");
      assert.ok(byRole[entry].bounds.max[2] <= 0.01, `${entry} starts at its tip`);
      assert.ok(byRole[entry].bounds.min[2] < -0.2, `${entry} trails back along -Z`);
    }
    assert.ok(Math.abs(byRole.arrow.bounds.min[2] + 0.8) < 0.01, "the arrow is 0.8 m long");
    for (const ground of ["frost-nova", "heal-motes", "blink-out", "blink-in", ...HOLDS]) {
      assert.equal(byRole[ground].align, "ground");
      assert.ok(byRole[ground].bounds.min[1] >= -0.2, `${ground} rests on the ground`);
    }
    for (const hold of HOLDS) assert.ok(Math.max(...byRole[hold].bounds.max.map(Math.abs), ...byRole[hold].bounds.min.map(Math.abs)) < 0.8, `${hold} stays at the feet`);
    assert.ok(byRole["frost-nova"].bounds.max[0] > 7.5, "the nova reaches its 8 m radius");
    for (const beam of ["beam-segment", "grapple-rope"]) assert.deepEqual([byRole[beam].bounds.min[2], byRole[beam].bounds.max[2], byRole[beam].tileLength], [0, 1, 1], `${beam} tiles from 0 to 1`);
    assert.equal(byRole["grapple-hook"].length, 0.4, "the hook's eye is 0.4 m behind its crown");
    assert.equal(byRole["ice-slip-scrape"].align, "path");
    assert.deepEqual([byRole["ice-slip-scrape"].bounds.min[1], byRole["ice-slip-scrape"].bounds.max[2], byRole["ice-slip-scrape"].length], [0, 1, 1], "the scrape lies on the ground from 0 to 1");

    const replay = await buildSpellEffects({ outDir: replayDir });
    assert.equal(replay.tarSha256, built.tarSha256, "a rebuild packs the same tar");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(replayDir, { recursive: true, force: true });
  }
});
