// Strike effect meshes (#724, #771, docs/strike-effects.md): the recipe builds a verified gltf-resources-v1 bundle of eleven small
// animated effects, each under 200 triangles with one Play clip of its declared length, vertex colour and opacity in
// COLOR_0 and core-glTF blended materials, and replays to the same tar. The build skips unless ASSET_TOOLING_BLENDER
// names Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import {
  STRIKE_CLIPS, STRIKE_DESCRIPTOR_ATTACHMENT, STRIKE_DESCRIPTOR_SCHEMA, STRIKE_EFFECTS, STRIKE_MATERIALS, STRIKE_RELEASE, STRIKE_TRIANGLE_BUDGET,
  buildStrikeEffects, createStrikeSpec, strikeKey,
} from "../../../scripts/build-strike-effects.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";

const GROUND = ["ground-slam", "lunge-dust", "leap-slam", "dash-dust"];

test("the strike effect spec runs the packaged recipe for exactly one entry", () => {
  const spec = createStrikeSpec({ entry: "ground-slam", scriptSha256: "a".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, entry: "ground-slam" } });
  assert.equal(spec.assetId, "strike.effects.ground-slam");
  assert.equal(STRIKE_RELEASE, "strike-effects", "one rolling release, never numbered");
});

test("the recipe builds a verified, reproducible bundle of small animated effects", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 900_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "strike-effects-"));
  const replayDir = await mkdtemp(path.join(os.tmpdir(), "strike-effects-replay-"));
  try {
    const built = await buildStrikeEffects({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => entry.key).sort(), STRIKE_EFFECTS.map(strikeKey).sort());

    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [...STRIKE_MATERIALS]);
    assert.equal(cost.textures, 0, "no textures: colour and opacity are per vertex");
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[STRIKE_RELEASE]!), []);

    for (const [entry, document] of Object.entries(built.documents)) {
      const root = document.getRoot();
      assert.deepEqual(root.listAnimations().map((clip) => clip.getName()), ["Play"], `${entry} has one clip`);
      for (const material of root.listMaterials()) {
        assert.equal(material.getAlphaMode(), "BLEND", `${entry} ${material.getName()} blends`);
        assert.ok(material.getDoubleSided(), `${entry} ${material.getName()} is double-sided`);
        assert.equal(material.listExtensions().length, 0, `${entry} ${material.getName()} is core glTF`);
      }
      for (const mesh of root.listMeshes()) for (const primitive of mesh.listPrimitives()) {
        assert.equal(primitive.getAttribute("COLOR_0")?.getType(), "VEC4", `${entry} carries RGBA vertex colour`);
      }
    }

    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, strikeKey(STRIKE_EFFECTS[0]), "default", STRIKE_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(descriptor.schema, STRIKE_DESCRIPTOR_SCHEMA);
    const byRole = Object.fromEntries(descriptor.assets.map((asset: any) => [asset.role, asset]));
    for (const entry of STRIKE_EFFECTS) {
      const asset = byRole[entry];
      assert.ok(asset.triangles <= STRIKE_TRIANGLE_BUDGET, `${entry}: ${asset.triangles} triangles`);
      assert.deepEqual(asset.clip, { name: "Play", duration: STRIKE_CLIPS[entry], loop: false });
      assert.equal(asset.align, GROUND.includes(entry) ? "ground" : entry === "combo-glint" ? "weapon" : entry === "dash-trail" ? "path" : "strike");
    }
    // The arcs' outer edge passes through the contact point, curving back to the swing centre at -X; the ground
    // effects stay on and above the ground.
    for (const arc of ["strike-arc-cut", "strike-arc-heavy", "cleave-sweep"]) {
      assert.equal(byRole[arc].bounds.max[0], 0, `${arc} reaches the contact point`);
      assert.ok(byRole[arc].bounds.min[0] < -byRole[arc].swingRadius, `${arc} curves back past its swing centre`);
    }
    for (const ground of GROUND) assert.equal(byRole[ground].bounds.min[1], 0, `${ground} rests on the ground`);
    assert.ok(byRole["leap-slam"].bounds.max[2] > -byRole["leap-slam"].bounds.min[2], "the leap slam's cracks and stones run ahead of the attacker");
    assert.deepEqual([byRole["dash-trail"].bounds.min[2], byRole["dash-trail"].bounds.max[2], byRole["dash-trail"].length], [0, 1, 1], "the dash trail runs from its start to z = 1");
    assert.ok(byRole["dash-dust"].bounds.min[2] < -0.5, "the dash dust is kicked back behind the start foot");
    assert.ok(byRole["strike-thrust"].bounds.min[2] < -1, "the thrust streak trails back along -Z");

    const replay = await buildStrikeEffects({ outDir: replayDir });
    assert.equal(replay.tarSha256, built.tarSha256, "a rebuild packs the same tar");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(replayDir, { recursive: true, force: true });
  }
});
