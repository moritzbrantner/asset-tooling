// Young residents (docs/young-residents.md, #556): the recipe builds a verified gltf-resources-v1 bundle of four dressed
// figures on the adults' rig, with the adults' joint rotations, the declared heights, every face slider as a morph target,
// nothing kept from the base body below the neck, and a byte-identical rebuild.
// The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import { YOUNG_DESCRIPTOR_ATTACHMENT, YOUNG_FIGURES, YOUNG_JOINT_COUNT, YOUNG_LOOKS, YOUNG_PEOPLES, YOUNG_RELEASE, YOUNG_SKIN_TONES, YOUNG_SLIDERS, YOUNG_TRIANGLE_BUDGET, buildYoungResidents, createYoungSpec, youngKey } from "../../../scripts/build-young-residents.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";

const repository = path.resolve(import.meta.dir, "../../..");
const SKIRTED = new Set(["teen-girl", "child-girl"]);

test("the spec runs the packaged recipe for one figure with its declared files", () => {
  const spec = createYoungSpec({ figure: "teen-girl", scriptSha256: "a".repeat(64), faceSha256: "b".repeat(64), blenderVersion: "5.2.2", files: { "Male_Peasant.gltf": "c".repeat(64) } });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, figure: "teen-girl" } });
  assert.equal(spec.assetId, "young-residents.kit.teen-girl");
  assert.equal(YOUNG_RELEASE, "young-residents", "one rolling release, never numbered");
});

test("the looks and peoples only name real sliders and skin tones", () => {
  for (const look of Object.values(YOUNG_LOOKS)) {
    for (const key of Object.keys(look.sliders)) assert.ok(YOUNG_SLIDERS.includes(key), key);
    assert.ok(look.skin < YOUNG_SKIN_TONES.length);
  }
  for (const people of YOUNG_PEOPLES) {
    assert.ok(people.skin < YOUNG_SKIN_TONES.length);
    for (const [key, offset] of Object.entries(people.offsets)) {
      assert.ok(YOUNG_SLIDERS.includes(key), key);
      assert.ok(Math.abs(offset) <= .9, `${people.id}.${key} stays moderate`);
    }
  }
});

test("the recipe builds a verified, reproducible kit on the adults' rig", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 900_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "young-residents-"));
  const rebuildDir = await mkdtemp(path.join(os.tmpdir(), "young-residents-rebuild-"));
  try {
    const built = await buildYoungResidents({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => entry.key).sort(), YOUNG_FIGURES.map(youngKey).sort());
    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, youngKey(YOUNG_FIGURES[0]), "default", YOUNG_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.deepEqual(descriptor.morphs.groups.flatMap((group: { sliders: { target: string }[] }) => group.sliders.map((slider) => slider.target)), YOUNG_SLIDERS);

    const adult = JSON.parse(await readFile(path.join(repository, "assets/canonical/quaternius.modular-character-outfits-fantasy-standard.male-peasant-gltf/Male_Peasant.gltf"), "utf8"));
    const adultRotation = new Map<string, number[]>(adult.skins[0].joints.map((index: number) => [adult.nodes[index].name, adult.nodes[index].rotation ?? [0, 0, 0, 1]]));
    for (const figure of YOUNG_FIGURES) {
      const document = built.documents[figure];
      const root = document.getRoot();
      const skin = root.listSkins()[0]!;
      assert.equal(skin.listJoints().length, YOUNG_JOINT_COUNT, figure);
      for (const joint of skin.listJoints()) {
        const expected = adultRotation.get(joint.getName());
        assert.ok(expected, `${figure}: unknown joint ${joint.getName()}`);
        const dot = Math.abs(joint.getRotation().reduce((sum, value, index) => sum + value * expected[index]!, 0));
        assert.ok(dot > .99999, `${figure}: ${joint.getName()} keeps the adult's rotation (dot ${dot})`);
      }

      const summary = descriptor.figures.find((entry: { figure: string }) => entry.figure === figure);
      assert.ok(Math.abs(summary.bounds.max[1] - summary.bounds.min[1] - YOUNG_LOOKS[figure].heightM) < .01, `${figure} height`);
      assert.ok(Math.abs(summary.bounds.min[1]) < .005, `${figure} stands on the ground`);
      assert.ok(summary.triangles <= YOUNG_TRIANGLE_BUDGET, `${figure}: ${summary.triangles} triangles`);
      assert.ok(summary.pelvisScale > .5 && summary.pelvisScale < 1, `${figure} pelvisScale`);

      const nodeNames = root.listNodes().map((node) => node.getName());
      assert.equal(nodeNames.includes("skirt"), SKIRTED.has(figure), `${figure} skirt`);
      assert.equal(nodeNames.includes("outfit.legs"), !SKIRTED.has(figure), `${figure} trousers`);
      const materials = root.listMaterials().map((material) => material.getName()).sort();
      assert.deepEqual(materials, ["brows", "eyes", "hair", "hands", "outfit", "skin", ...(SKIRTED.has(figure) ? ["skirt"] : [])].sort(), figure);

      for (const node of root.listNodes().filter((candidate) => ["head", "eyes", "brows"].includes(candidate.getName()))) {
        const targets = node.getMesh()!.getExtras().targetNames as string[];
        assert.deepEqual(targets, YOUNG_SLIDERS, `${figure} ${node.getName()} morph targets`);
      }

      // Nothing from the base body below the neck ships, even hidden: the skin mesh is bound only to the neck and head.
      const head = root.listNodes().find((node) => node.getName() === "head")!;
      const joints = head.getSkin()!.listJoints();
      for (const primitive of head.getMesh()!.listPrimitives()) {
        const indices = primitive.getAttribute("JOINTS_0")!, weights = primitive.getAttribute("WEIGHTS_0")!;
        const j: number[] = [], w: number[] = [];
        for (let vertex = 0; vertex < indices.getCount(); vertex += 1) {
          indices.getElement(vertex, j);
          weights.getElement(vertex, w);
          j.forEach((joint, slot) => { if (w[slot]! > 1e-4) assert.ok(["neck_01", "Head"].includes(joints[joint]!.getName()), `${figure}: head vertex on ${joints[joint]!.getName()}`); });
        }
      }
    }

    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[YOUNG_RELEASE]!), []);

    const rebuilt = await buildYoungResidents({ outDir: rebuildDir });
    assert.equal(rebuilt.tarSha256, built.tarSha256, "two builds are byte-identical");
  } finally {
    await Promise.all([rm(outDir, { recursive: true, force: true }), rm(rebuildDir, { recursive: true, force: true })]);
  }
});
