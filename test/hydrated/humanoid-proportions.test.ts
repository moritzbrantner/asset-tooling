// The adult woman's proportions (#561), measured on the real Female_Ranger rig: her Head joint lands where 1.70 m needs it,
// joints keep their rotations, her feet stay on the ground and the sockets measured from the rest pose follow.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { Accessor, Document, type Node } from "@gltf-transform/core";
import { RANGER_FEMALE_PROPORTIONS, followHead, reproportionDocument, reproportionSockets } from "../../src/humanoid-proportions.js";

const repository = path.resolve(import.meta.dir, "../..");

async function rig() {
  const gltf = JSON.parse(await readFile(path.join(repository, "assets/canonical/quaternius.modular-character-outfits-fantasy-standard.female-ranger-gltf/Female_Ranger.gltf"), "utf8"));
  const document = new Document();
  const nodes: Node[] = gltf.nodes.map((source: { name: string; translation?: number[]; rotation?: number[]; scale?: number[] }) => {
    const node = document.createNode(source.name);
    if (source.translation) node.setTranslation(source.translation as [number, number, number]);
    if (source.rotation) node.setRotation(source.rotation as [number, number, number, number]);
    return node;
  });
  gltf.nodes.forEach((source: { children?: number[] }, index: number) => source.children?.forEach((child) => nodes[index]!.addChild(nodes[child]!)));
  const skin = document.createSkin();
  for (const index of gltf.skins[0].joints as number[]) skin.addJoint(nodes[index]!);
  skin.setInverseBindMatrices(document.createAccessor().setType(Accessor.Type.MAT4).setArray(new Float32Array(16 * skin.listJoints().length)));
  return { document, skin };
}

test("the woman's Head joint reaches 1.70 m's height, with her rotations and ground contact kept", async () => {
  const { document, skin } = await rig();
  const rotations = new Map(skin.listJoints().map((joint) => [joint.getName(), [...joint.getWorldRotation()]]));
  const change = reproportionDocument(document, RANGER_FEMALE_PROPORTIONS);
  assert.ok(Math.abs(change.get("Head")!.before[1] - 1.549) < .01, "the rig is the one the constant was solved on");
  assert.ok(Math.abs(change.get("Head")!.after[1] - 1.463) < .006, `Head at ${change.get("Head")!.after[1]}`);
  assert.ok(Math.abs(change.get("ball_l")!.after[1] - change.get("ball_l")!.before[1]) < 1e-6, "feet stay on the ground");
  const shoulder = (state: "before" | "after") => Math.abs(change.get("upperarm_l")![state][0]);
  assert.ok(shoulder("after") < shoulder("before") * .95, "narrower shoulders");
  for (const joint of skin.listJoints()) {
    const expected = rotations.get(joint.getName())!;
    const agreement = Math.abs(joint.getWorldRotation().reduce((sum, value, index) => sum + value * expected[index]!, 0));
    assert.ok(agreement > .99999, joint.getName());
  }
  // Each inverse bind matrix undoes its joint's new rest translation.
  skin.listJoints().forEach((joint, index) => {
    const m = skin.getInverseBindMatrices()!.getElement(index, []);
    const [x, y, z] = joint.getWorldTranslation();
    assert.ok(Math.abs(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) < 1e-3, joint.getName());
  });
});

test("rest-pose sockets and head-mounted pieces follow the change", async () => {
  const { document } = await rig();
  const change = reproportionDocument(document, RANGER_FEMALE_PROPORTIONS);
  const original = JSON.parse(await readFile(path.join(repository, "assets/descriptors/humanoid.ranger.female.sockets.json"), "utf8"));
  const { sockets } = reproportionSockets(original, change, RANGER_FEMALE_PROPORTIONS);
  const find = (list: typeof sockets, id: string) => list.find((socket: { id: string }) => socket.id === id)!;
  const drop = change.get("Head")!.before[1] - change.get("Head")!.after[1];
  assert.ok(Math.abs((find(sockets, "head.hair").translation[1]! - find(original.sockets, "head.hair").translation[1]!) - drop) < .002, "the hair socket follows the head down");
  assert.ok(Math.abs(find(sockets, "hand_r.weapon").translation[1]! - find(original.sockets, "hand_r.weapon").translation[1]! * .84) < 1e-9, "hand sockets follow the palm");
  assert.deepEqual(find(sockets, "back.stowed").translation, find(original.sockets, "back.stowed").translation, "joint-frame sockets stay");

  const hair = new Document();
  const piece = hair.createNode("hair").setTranslation([0, 1.5, 0]);
  hair.createScene().addChild(piece);
  followHead(hair, change);
  assert.ok(Math.abs(piece.getTranslation()[1] - (1.5 - drop)) < 1e-6);
});
