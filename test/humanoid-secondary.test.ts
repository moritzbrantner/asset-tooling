// Accessory chains (#391): joints added under the parent, weights moved from the parent's share only, and a chain at
// rest deforms the mesh exactly as before.
import test from "node:test";
import assert from "node:assert/strict";
import { Document, type Node, type Skin } from "@gltf-transform/core";
import { RANGER_BEARD_CHAINS, RANGER_HAIR_CHAINS, RANGER_OUTFIT_CHAINS, addSecondaryChains, invert, multiply, type SecondaryChainSpec } from "../src/humanoid-secondary.js";

const SKIRT: SecondaryChainSpec = {
  id: "skirt.front", kind: "skirt", parent: "pelvis", prefix: "skirt_f", nodes: ["skirt"], top: 0.9, count: 3, direction: 0, axis: [0, 0],
  select: { type: "sector", power: 2 }, rampLength: 0.1, swingLimitDegrees: 20,
};

/** A pelvis (turned and offset, so its inverse bind is not a plain translation) and a thigh, with a skirt ring. */
function skirtDocument() {
  const document = new Document();
  const buffer = document.createBuffer();
  const pelvis = document.createNode("pelvis").setTranslation([0, 0.95, 0.02]).setRotation([0, 0.2588, 0, 0.9659]);
  const thigh = document.createNode("thigh_l").setTranslation([0.1, -0.05, 0]);
  pelvis.addChild(thigh);
  const armature = document.createNode("Armature").addChild(pelvis);
  const positions: number[] = [], joints: number[] = [], weights: number[] = [];
  for (let row = 0; row <= 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const angle = (column / 8) * Math.PI * 2;
      const y = 1.0 - row * 0.1;
      positions.push(Math.sin(angle) * 0.2, y, Math.cos(angle) * 0.2);
      const share = Math.min(1, row / 8);
      joints.push(0, 1, 0, 0);
      weights.push(1 - share * 0.5, share * 0.5, 0, 0);
    }
  }
  const world = (node: Node) => node.getWorldMatrix();
  const ibms = [pelvis, thigh].flatMap((joint) => invert([...world(joint)]));
  const skin = document.createSkin("skin").addJoint(pelvis).addJoint(thigh)
    .setInverseBindMatrices(document.createAccessor().setType("MAT4").setArray(new Float32Array(ibms)).setBuffer(buffer));
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buffer))
    .setAttribute("JOINTS_0", document.createAccessor().setType("VEC4").setArray(new Uint8Array(joints)).setBuffer(buffer))
    .setAttribute("WEIGHTS_0", document.createAccessor().setType("VEC4").setArray(new Float32Array(weights)).setBuffer(buffer));
  const mesh = document.createNode("skirt").setMesh(document.createMesh("skirt").addPrimitive(primitive)).setSkin(skin);
  document.createScene().addChild(armature).addChild(mesh);
  return { document, skin, mesh };
}

function skinningMatrix(skin: Skin, joint: number) {
  return multiply([...skin.listJoints()[joint]!.getWorldMatrix()], skin.getInverseBindMatrices()!.getElement(joint, []));
}

test("secondary chains: joints hang from the parent and keep its skinning matrix at rest", () => {
  const { document, skin, mesh } = skirtDocument();
  const chains = addSecondaryChains(document, [SKIRT]);
  assert.deepEqual(chains.map((chain) => chain.joints), [["skirt_f_01", "skirt_f_02", "skirt_f_03"]]);
  const names = skin.listJoints().map((joint) => joint.getName());
  assert.deepEqual(names, ["pelvis", "thigh_l", "skirt_f_01", "skirt_f_02", "skirt_f_03"]);
  assert.equal(skin.listJoints()[2]!.getParentNode()?.getName(), "pelvis");
  assert.equal(skin.listJoints()[3]!.getParentNode()?.getName(), "skirt_f_01");
  const pelvis = skinningMatrix(skin, 0);
  for (const joint of [2, 3, 4]) {
    skinningMatrix(skin, joint).forEach((value, index) => assert.ok(Math.abs(value - pelvis[index]!) < 1e-5, `joint ${names[joint]} element ${index}`));
  }
  // Weights: at most four, summing to 1; the thigh share never changes; the waist keeps all of the pelvis.
  const primitive = mesh.getMesh()!.listPrimitives()[0]!;
  const position = primitive.getAttribute("POSITION")!, joints = primitive.getAttribute("JOINTS_0")!, weights = primitive.getAttribute("WEIGHTS_0")!;
  let moved = 0;
  for (let vertex = 0; vertex < position.getCount(); vertex += 1) {
    const p = position.getElement(vertex, []), j = joints.getElement(vertex, []), w = weights.getElement(vertex, []);
    assert.ok(Math.abs(w.reduce((sum, value) => sum + value, 0) - 1) < 1e-5);
    const share = Object.fromEntries(j.map((index, k) => [names[index]!, w[k]!]).filter(([, value]) => (value as number) > 0));
    const row = Math.round((1 - p[1]!) / 0.1);
    assert.ok(Math.abs((share.thigh_l ?? 0) - Math.min(1, row / 8) * 0.5) < 1e-5);
    if (p[1]! >= 0.9) assert.equal(Object.keys(share).some((name) => name.startsWith("skirt")), false);
    if (Object.keys(share).some((name) => name.startsWith("skirt"))) moved += 1;
  }
  assert.ok(moved > 0);
});

test("secondary chains: an unskinned item gets a skin rooted at its origin", () => {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = new Float32Array([0, 1.8, 0, 0, 1.6, -0.12, 0, 1.5, -0.13]);
  const primitive = document.createPrimitive().setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(positions).setBuffer(buffer));
  const node = document.createNode("hair").setMesh(document.createMesh().addPrimitive(primitive));
  document.createScene().addChild(node);
  const chains = addSecondaryChains(document, [{ id: "hair.back", kind: "hair", parent: "hair_root", prefix: "hair_back", nodes: ["hair"], top: 1.7, count: 2,
    minSegment: 0.05, direction: 180, axis: [0, 0], select: { type: "sector", power: 2 }, rampLength: 0.05, swingLimitDegrees: 15 }]);
  assert.equal(chains[0]!.parent, "hair_root");
  const skin = node.getSkin()!;
  assert.deepEqual(skin.listJoints().map((joint) => joint.getName()), ["hair_root", "hair_back_01", "hair_back_02"]);
  const w = primitive.getAttribute("WEIGHTS_0")!, j = primitive.getAttribute("JOINTS_0")!;
  assert.deepEqual([j.getElement(0, [])[0], w.getElement(0, [])[0]], [0, 1]);
  assert.notEqual(j.getElement(2, [])[0], 0);
});

test("secondary chains: the Ranger tables name joints the issue asks for", () => {
  const prefixes = new Set([...Object.values(RANGER_OUTFIT_CHAINS).flat(), ...Object.values(RANGER_HAIR_CHAINS).flat(), ...RANGER_BEARD_CHAINS].map((spec) => spec.prefix));
  for (const prefix of ["skirt_f", "skirt_b", "skirt_l", "skirt_r", "apron", "cape", "scarf", "hair_back", "hair_tail", "beard"]) assert.ok(prefixes.has(prefix), prefix);
  assert.deepEqual(RANGER_OUTFIT_CHAINS.innkeeper!.map((spec) => spec.direction), [0]);
});
