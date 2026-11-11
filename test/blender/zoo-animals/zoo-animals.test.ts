// The zoo-animals release (#128, #589; docs/zoo-animals.md): Zoo's pinned zebra and giraffe stay as authored, and
// the expressive zebra, giraffe, tiger, elephant and capybara built by adapters/blender/zoo_animals.py join them as the `expressive` variant, with in-place
// idle, walk, feed and rest clips whose legs swing about the animal's side axis. The build replays to the same tar.
// It skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2 and the two canonical Zoo sources are hydrated.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO, type Document } from "@gltf-transform/core";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { readAssetBundleGltf, verifyAssetBundle, type GltfResourcesBundleManifest } from "../../../src/asset-bundle.js";
import { assertQuadrupedRigid } from "../../../src/quadruped-rigid.js";
import {
  ZOO_ANIMALS, ZOO_ANIMALS_DESCRIPTOR_FILE, ZOO_ANIMALS_RECIPE, ZOO_EXPRESSIVE_ANIMALS, ZOO_EXPRESSIVE_VARIANT, buildZooAnimals, createZooAnimalAssetSpec,
} from "../../../scripts/build-zoo-animals.ts";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const storage: { entries: { sourceId: string; path: string }[] } = JSON.parse(await readFile(path.join(root, "catalog/storage.json"), "utf8"));
const pointers = [];
for (const { sourceId } of ZOO_ANIMALS) {
  const entry = storage.entries.find((item) => item.sourceId === sourceId)!;
  if ((await readFile(path.join(root, entry.path))).subarray(0, 64).toString().startsWith("version https://git-lfs.github.com/spec/v1")) pointers.push(entry.path);
}
const skip = !process.env.ASSET_TOOLING_BLENDER ? "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)"
  : pointers.length ? "requires the hydrated canonical Zoo animals (git lfs pull)" : false;

const CLIPS = ["feed", "idle", "rest", "walk"];
const JOINTS = ["animal_root", "body", "ear_left", "ear_right", "eye_left", "eye_right", "head", "leg_0", "leg_0_lower", "leg_1", "leg_1_lower",
  "leg_2", "leg_2_lower", "leg_3", "leg_3_lower", "neck", "tail"];

test("the expressive spec runs the packaged recipe for one species, with no other input", () => {
  const spec = createZooAnimalAssetSpec({ species: "zebra", scriptSha256: "a".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, species: "zebra" } });
  assert.deepEqual(Object.keys(spec.inputs), ["script"]);
  assert.equal(spec.assetId, "zoo.animal.zebra.expressive");
  assert.deepEqual(ZOO_EXPRESSIVE_ANIMALS.map((entry) => entry.key), ["zoo.animal.zebra", "zoo.animal.giraffe", "zoo.animal.tiger", "zoo.animal.elephant", "zoo.animal.capybara"]);
});

/** Per animal: its full-size height and length (m), its triangle budget, one colour of its coat (linear COLOR_0) and any
 * joints of its own beyond the shared ones. */
const EXPECTED: Record<string, { height: [number, number]; length: [number, number]; triangles: number; coat: string; coatName: string; joints?: string[] }> = {
  "zoo.animal.zebra": { height: [1.4, 1.9], length: [1.4, 2], triangles: 4500, coat: "0.01,0.01", coatName: "the black stripes" },
  "zoo.animal.giraffe": { height: [3.2, 3.9], length: [1.9, 2.6], triangles: 6000, coat: "0.64,0.23", coatName: "the tan patches" },
  "zoo.animal.tiger": { height: [1.0, 1.5], length: [1.7, 2.5], triangles: 5500, coat: "0.91,0.23", coatName: "the orange coat" },
  "zoo.animal.elephant": { height: [1.9, 2.7], length: [2.6, 3.5], triangles: 5000, coat: "0.32,0.35", coatName: "the grey skin", joints: ["trunk", "trunk_tip"] },
  "zoo.animal.capybara": { height: [0.6, 1.0], length: [1.2, 1.8], triangles: 3000, coat: "0.39,0.17", coatName: "the brown coat" },
};

/** The rotation axis of a quaternion in the leg's channel, or null when it barely turns. */
function axisOf([x, y, z]: number[]): number[] | null {
  const length = Math.hypot(x!, y!, z!);
  return length < 1e-4 ? null : [x! / length, y! / length, z! / length];
}

function checkExpressive(document: Document, label: string) {
  const observations = assertQuadrupedRigid(document, label);
  const gltf = document.getRoot();
  const expected = EXPECTED[label.split("/")[0]!]!;
  assert.deepEqual(gltf.listNodes().map((node) => node.getName()).sort(), [...JOINTS, ...(expected.joints ?? [])].sort(), `${label}: the joints`);
  assert.deepEqual(gltf.listAnimations().map((clip) => clip.getName()).sort(), CLIPS, `${label}: idle, walk, feed and rest`);
  assert.deepEqual(gltf.listMaterials().map((material) => material.getName()), ["zoo-animal"], `${label}: one shared material`);
  assert.equal(gltf.listTextures().length, 0, `${label}: no textures`);
  const palette = new Set<string>();
  for (const mesh of gltf.listMeshes()) for (const primitive of mesh.listPrimitives()) {
    const colours = primitive.getAttribute("COLOR_0");
    assert.ok(colours, `${label}: ${mesh.getName()} carries its palette in COLOR_0`);
    const value: number[] = [];
    for (let index = 0; index < colours.getCount(); index += 1) palette.add(colours.getElement(index, value).map((c) => c.toFixed(2)).join());
    assert.equal(primitive.getMaterial()?.getAlphaMode(), "OPAQUE");
  }
  // coat colours, muzzle or nose, inner ear, hoof, eye white and pupil
  assert.ok(palette.size >= 6, `${label}: COLOR_0 holds ${palette.size} colours`);
  assert.ok([...palette].some((colour) => colour.startsWith(expected.coat)), `${label}: COLOR_0 has ${expected.coatName}`);
  assert.ok(observations.triangles < expected.triangles, `${label}: ${observations.triangles} triangles`);
  const within = (value: number, [low, high]: [number, number]) => value > low && value < high;
  assert.ok(within(observations.size.height, expected.height), `${label}: height ${observations.size.height} m`);
  assert.ok(within(observations.size.width, expected.length), `${label}: length ${observations.size.width} m along +X`);
  const at = (name: string) => gltf.listNodes().find((node) => node.getName() === name)!.getWorldTranslation()[0]!;
  assert.ok(at("head") > 0 && at("head") > at("tail"), `${label}: the head is towards +X, the tail behind`);

  // Cross-fade safety: every clip keys the same channels, so switching clips never leaves a joint in another pose.
  const channels = Object.values(observations.clips).map((clip) => clip.channels.join());
  assert.equal(new Set(channels).size, 1, `${label}: every clip keys the same channels`);
  for (const [name, clip] of Object.entries(observations.clips)) {
    assert.ok(clip.lowestPoint! >= -0.005, `${label}: ${name} sinks to ${clip.lowestPoint}`);
  }
  assert.equal(observations.clips.walk!.walkTravel, 0);
  assert.equal(observations.clips.feed!.travel, 0);
  assert.equal(observations.clips.rest!.travel, 0);
  assert.ok(observations.clips.rest!.lowestPoint! < 0.05, `${label}: rest lies on the ground`);

  // No lateral splay: in the walk every leg and knee turns only about the side axis (glTF Z, the animal faces +X).
  const walk = gltf.listAnimations().find((clip) => clip.getName() === "walk")!;
  const phases: number[] = [];
  for (const channel of walk.listChannels()) {
    const name = channel.getTargetNode()!.getName();
    if (!/^leg_\d(_lower)?$/.test(name) || channel.getTargetPath() !== "rotation") continue;
    const values = channel.getSampler()!.getOutput()!.getArray()!;
    let peak = 0, peakAt = 0;
    for (let index = 0; index < values.length; index += 4) {
      const axis = axisOf([values[index]!, values[index + 1]!, values[index + 2]!]);
      if (axis) assert.ok(Math.abs(axis[2]!) > 0.999, `${label}: ${name} turns about ${axis.map((v) => v.toFixed(3))}, not the side axis`);
      if (!name.endsWith("_lower") && values[index + 2]! > peak) { peak = values[index + 2]!; peakAt = index / 4; }
    }
    if (!name.endsWith("_lower")) phases.push(peakAt);
  }
  assert.equal(new Set(phases).size, 4, `${label}: the four legs step at four different times`);
}

test("zoo-animals builds the old members unchanged and the expressive animals, reproducibly", { skip, timeout: 600_000 }, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "zoo-animals-"));
  const replayDir = await mkdtemp(path.join(os.tmpdir(), "zoo-animals-replay-"));
  try {
    const built = await buildZooAnimals({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const manifest = (await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: "gltf-resources-v1" })).manifest as GltfResourcesBundleManifest;
    assert.deepEqual(manifest.assets.map((item) => `${item.key}/${item.variant}`).sort(),
      [`zoo.animal.capybara/${ZOO_EXPRESSIVE_VARIANT}`, `zoo.animal.elephant/${ZOO_EXPRESSIVE_VARIANT}`, "zoo.animal.giraffe/default", `zoo.animal.giraffe/${ZOO_EXPRESSIVE_VARIANT}`, `zoo.animal.tiger/${ZOO_EXPRESSIVE_VARIANT}`,
        "zoo.animal.zebra/default", `zoo.animal.zebra/${ZOO_EXPRESSIVE_VARIANT}`]);

    const descriptor = JSON.parse(await readFile(path.join(outDir, ZOO_ANIMALS_DESCRIPTOR_FILE), "utf8"));
    assert.deepEqual(descriptor.clips.activity, ["feed", "rest"]);
    const io = new NodeIO();
    for (const asset of descriptor.assets) {
      const item = await readAssetBundleGltf(built.bundleDir, manifest, asset.key, asset.variant);
      const document = await io.readJSON({ json: JSON.parse(item.gltf.toString()), resources: Object.fromEntries(item.resources) });
      if (asset.variant === "default") {
        // Zoo's own animals stay as authored: same pinned source, the same two clips.
        assert.match(asset.provenance.catalogSource, /^zoo\.(zebra|giraffe)-glb$/);
        assert.deepEqual(Object.keys(asset.clips).sort(), ["idle", "walk"]);
        continue;
      }
      assert.equal(asset.provenance.recipe.script, ZOO_ANIMALS_RECIPE);
      assert.match(asset.provenance.generator, /no third-party assets/);
      checkExpressive(document, `${asset.key}/${asset.variant}`);
    }

    const replay = await buildZooAnimals({ outDir: replayDir });
    assert.equal(replay.tarSha256, built.tarSha256, "a rebuild packs the same tar");
  } finally {
    await Promise.all([outDir, replayDir].map((dir) => rm(dir, { recursive: true, force: true })));
  }
});
