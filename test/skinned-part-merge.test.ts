import test from "node:test";
import assert from "node:assert/strict";
import { Document, NodeIO } from "@gltf-transform/core";
import { descriptorStrings, mergeSkinnedParts } from "../src/skinned-part-merge.js";

/** Two triangles' worth of skinned parts on one joint, each with one morph target. */
function character() {
  const document = new Document();
  const buffer = document.createBuffer();
  const joint = document.createNode("pelvis");
  const ibm = () => document.createAccessor().setType("MAT4").setArray(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).setBuffer(buffer);
  const scene = document.createScene().addChild(joint);
  const cloth = document.createMaterial("cloth"), skin = document.createMaterial("skin");
  const part = (name: string, material: typeof cloth, x: number, colour: boolean) => {
    const accessor = (type: "VEC2" | "VEC3" | "VEC4" | "SCALAR", values: number[], array: "f" | "u16" = "f") =>
      document.createAccessor().setType(type).setBuffer(buffer).setArray(array === "u16" ? new Uint16Array(values) : new Float32Array(values));
    const primitive = document.createPrimitive().setMaterial(material)
      .setAttribute("POSITION", accessor("VEC3", [x, 0, 0, x + 1, 0, 0, x, 1, 0]))
      .setAttribute("NORMAL", accessor("VEC3", [0, 0, 1, 0, 0, 1, 0, 0, 1]))
      .setAttribute("TEXCOORD_0", accessor("VEC2", [0, 0, 1, 0, 0, 1]))
      .setAttribute("JOINTS_0", accessor("VEC4", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "u16"))
      .setAttribute("WEIGHTS_0", accessor("VEC4", [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]))
      .setIndices(accessor("SCALAR", [0, 1, 2], "u16"))
      .addTarget(document.createPrimitiveTarget().setAttribute("POSITION", accessor("VEC3", [0, x, 0, 0, x, 0, 0, x, 0])));
    if (colour) primitive.setAttribute("COLOR_0", accessor("VEC4", [0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 1]));
    const mesh = document.createMesh(name).addPrimitive(primitive).setWeights([0]).setExtras({ targetNames: ["build.heavy"] });
    const node = document.createNode(name).setMesh(mesh).setSkin(document.createSkin().addJoint(joint).setInverseBindMatrices(ibm()));
    scene.addChild(node);
  };
  part("Belt", cloth, 0, false);
  part("Boots", cloth, 2, true);
  part("Hood", cloth, 4, true);
  part("Arms", skin, 6, true);
  return document;
}

test("parts sharing a material and binding join into one primitive; named parts stay", async () => {
  const document = character();
  const { merged } = await mergeSkinnedParts(document, { keep: new Set(["Hood"]) });
  assert.deepEqual(merged, [["Belt", "Boots"]]);
  const nodes = document.getRoot().listNodes().filter((node) => node.getMesh()).map((node) => node.getName());
  assert.deepEqual(nodes, ["Hood", "Arms", "merged.cloth"]);
  const mergedMesh = document.getRoot().listNodes().find((node) => node.getName() === "merged.cloth")!.getMesh()!;
  const [primitive] = mergedMesh.listPrimitives();
  assert.deepEqual(Array.from(primitive!.getAttribute("POSITION")!.getArray()!), [0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0]);
  assert.deepEqual(Array.from(primitive!.getIndices()!.getArray()!), [0, 1, 2, 3, 4, 5]);
  // The belt had no vertex colour: glTF's default, white, keeps it as it was.
  assert.deepEqual(Array.from(primitive!.getAttribute("COLOR_0")!.getArray()!).slice(0, 4), [1, 1, 1, 1]);
  assert.deepEqual(Array.from(primitive!.listTargets()[0]!.getAttribute("POSITION")!.getArray()!), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 2, 0, 0, 2, 0]);
  assert.deepEqual(mergedMesh.getExtras(), { targetNames: ["build.heavy"] });
  // The merged document still writes as valid glTF.
  await new NodeIO().writeBinary(document);
});

test("nothing merges across materials, kept names or differing morph target names", async () => {
  const document = character();
  document.getRoot().listMeshes().find((mesh) => mesh.getName() === "Boots")!.setExtras({ targetNames: ["build.thin"] });
  assert.deepEqual((await mergeSkinnedParts(document, { keep: new Set(["Hood"]) })).merged, []);
  assert.deepEqual(document.getRoot().listNodes().filter((node) => node.getMesh()).length, 4);
});

test("an appearance descriptor's strings are the names it addresses", () => {
  const strings = descriptorStrings({ parts: [{ id: "outfit.hood", nodes: ["Hood"] }], face: { nodes: ["Head"] }, n: 3 });
  assert.ok(strings.has("Hood") && strings.has("Head") && strings.has("outfit.hood"));
});
