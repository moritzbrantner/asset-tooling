// Male character variety (#380): the option tables against the Blender recipes, the descriptor sections, and the
// transfer that appends the age and build morph targets after a mesh's face targets.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Document, NodeIO } from "@gltf-transform/core";
import { transferMorphTargets } from "../src/face-variants.js";
import {
  VARIETY_AGE_TARGETS, VARIETY_BEARDS, VARIETY_BUILD_TARGETS, VARIETY_HAIRSTYLES, VARIETY_HEIGHTS, VARIETY_MORPH_TARGETS, VARIETY_SKIN_TONES,
  headSkinMaterials, varietyAppearance,
} from "../src/male-variety.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const recipe = (name: string) => readFile(path.join(ROOT, "adapters/blender", name), "utf8");

test("the age, build, height, tone, hairstyle and beard tables match the Blender recipes", async () => {
  const variety = await recipe("male_variety.py");
  assert.ok(variety.includes(`AGE_KEYS = [${VARIETY_AGE_TARGETS.map((key) => `"${key}"`).join(", ")}]`));
  assert.ok(variety.includes(`BUILD_KEYS = [${VARIETY_BUILD_TARGETS.map((key) => `"${key}"`).join(", ")}]`));
  assert.ok(variety.includes(`HEIGHTS = (${VARIETY_HEIGHTS.min}, ${VARIETY_HEIGHTS.max})`.replace(/0\./g, ".")));
  for (const tone of VARIETY_SKIN_TONES) {
    const [r, g, b] = tone.baseColorFactor.map((value) => String(value).replace(/^0\./, "."));
    assert.ok(variety.includes(`"${tone.id}": (${r}, ${g}, ${b})`), tone.id);
  }
  const hair = await recipe("hair_beards.py");
  for (const style of VARIETY_HAIRSTYLES) assert.ok(hair.includes(`"${style}": hair_`), style);
  for (const beard of Object.keys(VARIETY_BEARDS)) assert.ok(hair.includes(`"${beard}": {`), beard);
});

test("the descriptor sections: ages with their painted skins, builds, heights, tones and every head skin", () => {
  const materials = headSkinMaterials();
  // Two base skins, four ages and three stubble choices, less the two plain base skins the characters already wear.
  assert.equal(materials.length, 22);
  assert.ok(materials.some((texture) => texture.material === "skin.light.aged.stubble.dark"));
  assert.ok(!materials.some((texture) => texture.material === "skin.dark.base"));
  const sections = varietyAppearance({ variants: ["default"], unsupported: ["lod1"], entries: ["armor.knight"], head: "SuperHero_Male", eyebrows: "Eyebrows" });
  assert.deepEqual(sections.ages.options.map((option) => option.id), ["age.base", "age.young", "age.middle", "age.old", "age.weathered"]);
  assert.deepEqual(sections.ages.options.map((option) => option.skin), ["base", "base", "middle", "aged", "weathered"]);
  assert.deepEqual(sections.builds.options.map((option) => Object.keys(option.morphs)), [["build.lean"], [], ["build.heavy"]]);
  assert.deepEqual([sections.heights.min, sections.heights.max], [0.91, 1.09]);
  assert.equal(sections.skinTones.skin, "skin.light");
  for (const texture of sections.headSkins.textures) {
    assert.ok(sections.ages.options.some((age) => age.skin === texture.age), texture.material);
  }
});

/** One triangle mesh node `Eyebrows` with the given morph targets (position deltas per vertex and target). */
async function triangle(order: number[], names: readonly string[], delta: (vertex: number, key: number) => number[]) {
  const document = new Document();
  const buffer = document.createBuffer();
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(new Float32Array(order.flatMap((vertex) => corners[vertex]!))).setBuffer(buffer))
    .setIndices(document.createAccessor().setType("SCALAR").setArray(new Uint16Array([0, 1, 2])).setBuffer(buffer));
  const mesh = document.createMesh("brows").addPrimitive(primitive);
  names.forEach((name, key) => primitive.addTarget(document.createPrimitiveTarget(name).setAttribute("POSITION",
    document.createAccessor().setType("VEC3").setArray(new Float32Array(order.flatMap((vertex) => delta(vertex, key)))).setBuffer(buffer))));
  if (names.length) mesh.setExtras({ targetNames: [...names] }).setWeights(names.map(() => 0));
  document.createScene().addChild(document.createNode("Eyebrows").setMesh(mesh));
  return new NodeIO().writeBinary(document);
}

test("the variety targets are appended after the face targets the shipped mesh already has", async () => {
  const face = ["face.broad"];
  const shipped = await triangle([0, 1, 2], face, () => [0, 0, 0.5]);
  const authored = await triangle([1, 2, 0], [...face, ...VARIETY_MORPH_TARGETS], (vertex, key) => (vertex === 2 ? [0, 0, key / 100] : [0, 0, 0]));
  const { glb, transfer } = await transferMorphTargets(shipped, authored, VARIETY_MORPH_TARGETS);
  const mesh = (await new NodeIO().readBinary(glb)).getRoot().listMeshes()[0]!;
  assert.deepEqual((mesh.getExtras() as any).targetNames, [...face, ...VARIETY_MORPH_TARGETS]);
  const targets = mesh.listPrimitives()[0]!.listTargets();
  assert.deepEqual([...targets[0]!.getAttribute("POSITION")!.getArray()!], [0, 0, 0.5, 0, 0, 0.5, 0, 0, 0.5], "the face target is untouched");
  // build.heavy is the authored target 6 (after face.broad); vertex 2 of the shipped order moved.
  assert.deepEqual([...targets[6]!.getAttribute("POSITION")!.getArray()!].map((value) => Math.round(value * 100)), [0, 0, 0, 0, 0, 0, 0, 0, 6]);
  assert.equal(transfer.Eyebrows!.movedVertices["build.heavy"], 1);
  await assert.rejects(transferMorphTargets(glb, authored, VARIETY_MORPH_TARGETS), /already has the morph target/);
  await assert.rejects(transferMorphTargets(shipped, shipped, VARIETY_MORPH_TARGETS), /no morph targets/);
});
