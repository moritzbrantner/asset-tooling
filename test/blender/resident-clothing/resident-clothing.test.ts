// Resident clothing (docs/resident-clothing.md, #560): the recipe builds a verified gltf-resources-v1 bundle of every
// garment on every fit it belongs to, skinned to that fit's 65-joint rig at rest (the young fits on the young residents'
// published joints), with the #391 chains on skirts and aprons, two materials over one KTX2 atlas, lighting attributes,
// the kit's budget and a byte-identical rebuild. The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import {
  CLOTHING_DESCRIPTOR_ATTACHMENT, CLOTHING_FIT_NAMES, CLOTHING_JOINT_COUNT, CLOTHING_LOOKS, CLOTHING_MATERIALS, CLOTHING_PIECES, CLOTHING_RELEASE,
  buildResidentClothing, clothingChains, clothingKey, createClothingSpec,
} from "../../../scripts/build-resident-clothing.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";

const repository = path.resolve(import.meta.dir, "../../..");
/** A few joints of the published young-residents figures (glTF metres), which the young fits must reproduce. */
const YOUNG_JOINTS: Record<string, Record<string, number[]>> = {
  "teen-boy": { pelvis: [0, .87181, -.03846], Head: [0, 1.45738, -.01449], hand_l: [.59623, 1.32599, -.05846], foot_l: [.07131, .07654, -.0797] },
  "teen-girl": { pelvis: [0, .82853, -.03679], Head: [0, 1.39211, -.01284], hand_l: [.53511, 1.26811, -.04519], foot_l: [.06822, .06774, -.07624] },
  "child-boy": { pelvis: [0, .64332, -.03135], Head: [0, 1.09852, -.01603], hand_l: [.45845, 1.00979, -.04105], foot_l: [.06078, .06596, -.06082] },
  "child-girl": { pelvis: [0, .63536, -.03116], Head: [0, 1.08885, -.01559], hand_l: [.44258, 1.00176, -.03648], foot_l: [.0604, .06162, -.06044] },
};

test("the spec runs the packaged recipe for one fit with its declared source", () => {
  const spec = createClothingSpec({ fit: "teen-girl", scriptSha256: "a".repeat(64), youngSha256: "b".repeat(64), gltfSha256: "c".repeat(64), bufferSha256: "d".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, fit: "teen-girl" } });
  assert.deepEqual(Object.keys(spec.inputs).sort(), ["buffer", "gltf", "script", "young"]);
  assert.equal(CLOTHING_RELEASE, "resident-clothing", "one rolling release, never numbered");
});

test("skirts get four chains from the pelvis and aprons one, scaled to the fit", () => {
  const landmarks = { height: 1.3, pelvis: .64, pelvis_y: .031 };
  const skirt = clothingChains("skirt", "kirtle", landmarks);
  assert.deepEqual(skirt.map((chain) => chain.id), ["skirt.front", "skirt.back", "skirt.left", "skirt.right"]);
  assert.ok(skirt.every((chain) => chain.parent === "pelvis" && chain.top < .64 && chain.axis[1] === -.031));
  assert.deepEqual(clothingChains("apron", "apron.half", landmarks).map((chain) => chain.prefix), ["apron"]);
  assert.deepEqual(clothingChains(null, "shirt", landmarks), []);
});

test("the recipe builds a verified, reproducible kit on every fit's rig", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_500_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "resident-clothing-"));
  const rebuildDir = await mkdtemp(path.join(os.tmpdir(), "resident-clothing-rebuild-"));
  try {
    const built = await buildResidentClothing({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual([...new Set(manifest.assets.map((entry) => entry.key))].sort(), CLOTHING_PIECES.map(({ id }) => clothingKey(id)).sort());
    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, clothingKey(CLOTHING_PIECES[0].id), "child-boy", CLOTHING_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.deepEqual(Object.keys(descriptor.fits).sort(), [...CLOTHING_FIT_NAMES].sort());
    assert.equal(descriptor.looks.length, CLOTHING_LOOKS.length);

    // Every fit wears at least one garment, and every garment ships on the fits the mockup gave it.
    const fitsOf = (id: string) => new Set(built.variants.get(id)!.map((variant) => variant.fit));
    assert.deepEqual([...fitsOf("smock")].sort(), ["child-boy", "child-girl"]);
    assert.deepEqual([...fitsOf("smock.long")].sort(), ["child-girl", "teen-girl"]);
    assert.deepEqual([...fitsOf("kirtle")].sort(), ["female", "teen-girl"]);
    assert.deepEqual([...fitsOf("tunic")].sort(), ["male", "teen-boy"]);
    assert.deepEqual([...fitsOf("apron.leather")].sort(), ["female", "male"]);
    // The better-off adults have their own silhouettes (owner decision on #560 Q3).
    const cut = (id: string, fit: string, finish: string) => built.variants.get(id)!.find((variant) => variant.fit === fit && variant.finish === finish)!.cut;
    assert.equal(cut("kirtle", "female", "fine"), "gown");
    assert.equal(cut("tunic", "male", "fine"), "long");
    assert.equal(cut("tunic", "male", "poor"), "regular");

    const rotations = async (source: string) => {
      const gltf = JSON.parse(await readFile(path.join(repository, `assets/canonical/quaternius.modular-character-outfits-fantasy-standard.${source.toLowerCase().replace("_", "-")}-gltf/${source}.gltf`), "utf8"));
      return new Map<string, number[]>(gltf.skins[0].joints.map((index: number) => [gltf.nodes[index].name, gltf.nodes[index].rotation ?? [0, 0, 0, 1]]));
    };
    const sourceRotations = { Male_Peasant: await rotations("Male_Peasant"), Female_Peasant: await rotations("Female_Peasant") };
    for (const piece of descriptor.pieces) for (const variant of piece.variants) {
      const adultRotation = sourceRotations[descriptor.fits[variant.fit].source as keyof typeof sourceRotations];
      const label = `${piece.id}/${variant.variant}`;
      const document = built.documents.get(label)!;
      assert.ok(document?.getRoot().listNodes().some((node) => node.getName() === variant.node && node.getSkin()), label);
      const root = document.getRoot();
      const skin = root.listSkins()[0]!;
      const joints = skin.listJoints().map((joint) => joint.getName());
      const chainJoints = (variant.secondary ?? []).flatMap((chain: { joints: string[] }) => chain.joints);
      assert.equal(joints.length, CLOTHING_JOINT_COUNT + chainJoints.length, `${label}: the rig plus its chains`);
      assert.ok(variant.materials.every((name: string) => (CLOTHING_MATERIALS as readonly string[]).includes(name)), `${label} materials`);
      assert.ok(variant.triangles <= 11_000, `${label}: ${variant.triangles} triangles`);
      const expected = CLOTHING_PIECES.find(({ id }) => id === piece.id)!.chains;
      assert.equal((variant.secondary ?? []).length, expected === "skirt" ? 4 : expected === "apron" ? 1 : 0, `${label} chains`);
      for (const mesh of root.listMeshes()) for (const primitive of mesh.listPrimitives()) {
        for (const attribute of ["COLOR_0", "TANGENT", "JOINTS_0", "WEIGHTS_0"]) assert.ok(primitive.getAttribute(attribute), `${label} ${attribute}`);
      }
      for (const joint of skin.listJoints().filter((node) => adultRotation.has(node.getName()))) {
        const want = adultRotation.get(joint.getName())!;
        const dot = Math.abs(joint.getRotation().reduce((sum, value, index) => sum + value * want[index]!, 0));
        assert.ok(dot > .99999, `${label}: ${joint.getName()} keeps the adult's rotation`);
      }
      const published = YOUNG_JOINTS[variant.fit];
      if (published) {
        const world = new Map(skin.listJoints().map((joint) => [joint.getName(), joint.getWorldTranslation()]));
        for (const [name, want] of Object.entries(published)) {
          const got = world.get(name)!;
          assert.ok(Math.hypot(got[0] - want[0]!, got[1] - want[1]!, got[2] - want[2]!) < 1e-4, `${label}: ${name} at the young figure's joint`);
        }
      }
    }
    for (const list of built.variants.values()) for (const variant of list) {
      assert.ok(variant.squeezedFaces === 0 || variant.squeezedFaces < 20, `${variant.node}/${variant.fit}: ${variant.squeezedFaces} faces squeezed into their atlas cells`);
    }

    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [...CLOTHING_MATERIALS]);
    assert.equal(cost.textures, 2, "one atlas and one normal map");
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[CLOTHING_RELEASE]!), []);

    const rebuilt = await buildResidentClothing({ outDir: rebuildDir });
    assert.equal(rebuilt.tarSha256, built.tarSha256, "two builds are byte-identical");
  } finally {
    await Promise.all([rm(outDir, { recursive: true, force: true }), rm(rebuildDir, { recursive: true, force: true })]);
  }
});
