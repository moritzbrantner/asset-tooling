// Rest-pose proportions for a figure on the 65-joint rig (#561, the adult woman): new joint offsets and vertices at the
// point the sources are imported, so the rig, retargeted clips and fitted garments all follow. Joints keep their rotations.
import type { Accessor, Document, Node } from "@gltf-transform/core";

type Vec3 = [number, number, number];
type Mat3 = [number, number, number, number, number, number, number, number, number];
/** Bone name (a family name: `spine`, `upperarm`, `fingers`...) to its (width, length) multipliers. */
export type RestProportions = Record<string, readonly [number, number]>;
/** Where each joint was and is, in model space, with its unchanged world rotation. */
export type RestChange = Map<string, { before: Vec3; after: Vec3; rotation: Mat3 }>;

const FINGERS = ["index", "middle", "ring", "pinky", "thumb"];
const MAIN_CHILD: Record<string, string> = { root: "pelvis", pelvis: "spine_01", spine_03: "neck_01", hand_l: "middle_01_l", hand_r: "middle_01_r" };

/**
 * The length that brings the woman's Head joint to 1.463 m (now 1.549 m): 1.70 m tall with her head unchanged, against the
 * men's 1.84 m. `test/hydrated/humanoid-proportions.test.ts` measures it on the real rig.
 */
export const RANGER_FEMALE_BODY_LENGTH = 0.9415;
const L = RANGER_FEMALE_BODY_LENGTH;
export const RANGER_FEMALE_PROPORTIONS: RestProportions = {
  pelvis: [1, L], spine: [1, L], neck_01: [1, L], clavicle: [.88, .88], upperarm: [.9, L], lowerarm: [.9, L],
  hand: [.84, .84], fingers: [.84, .84], thigh: [1, L], calf: [1, L],
};

function family(name: string) {
  if (FINGERS.some((finger) => name.startsWith(finger))) return "fingers";
  if (name.startsWith("spine")) return "spine";
  return name.endsWith("_l") || name.endsWith("_r") ? name.slice(0, -2) : name;
}
const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const add = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const position = (node: Node): Vec3 => node.getWorldTranslation() as Vec3;
/** Upper-left 3×3 of a rigid column-major world matrix, row by row. */
function rotationOf(node: Node): Mat3 {
  const m = node.getWorldMatrix();
  return [m[0]!, m[4]!, m[8]!, m[1]!, m[5]!, m[9]!, m[2]!, m[6]!, m[10]!];
}
const timesTransposed = (r: Mat3, v: readonly number[]): Vec3 => [r[0] * v[0]! + r[3] * v[1]! + r[6] * v[2]!, r[1] * v[0]! + r[4] * v[1]! + r[7] * v[2]!, r[2] * v[0]! + r[5] * v[1]! + r[8] * v[2]!];

/** Scale `v` by `width` across the bone and `length` along its unit direction `d`. */
function stretch(v: readonly number[], d: readonly number[], [width, length]: readonly [number, number]): Vec3 {
  const along = dot(v, d) * (length - width);
  return [v[0]! * width + d[0]! * along, v[1]! * width + d[1]! * along, v[2]! * width + d[2]! * along];
}

/** Apply `table` to the document's skin: joint offsets, vertices and inverse bind matrices. The document must hold one rig. */
export function reproportionDocument(document: Document, table: RestProportions): RestChange {
  const skins = document.getRoot().listSkins();
  const joints = skins[0]?.listJoints() ?? [];
  if (!joints.length) throw new Error("reproportionDocument needs a skinned document");
  const byName = new Map(joints.map((joint) => [joint.getName(), joint]));
  const parentOf = (joint: Node) => { const parent = joint.getParentNode(); return parent && joints.includes(parent) ? parent : undefined; };
  const depth = (joint: Node): number => { const parent = parentOf(joint); return parent ? depth(parent) + 1 : 0; };
  const ordered = [...joints].sort((a, b) => depth(a) - depth(b));
  const before = new Map(joints.map((joint) => [joint, position(joint)]));
  const rotation = new Map(joints.map((joint) => [joint, rotationOf(joint)]));

  const direction = (joint: Node): Vec3 => {
    const child = byName.get(MAIN_CHILD[joint.getName()] ?? "") ?? joint.listChildren().find((candidate) => joints.includes(candidate));
    if (child) {
      const d = sub(before.get(child)!, before.get(joint)!);
      const size = Math.sqrt(dot(d, d));
      return [d[0] / size, d[1] / size, d[2] / size];
    }
    const parent = parentOf(joint);
    return parent ? direction(parent) : [0, 1, 0];
  };
  const pair = new Map(joints.map((joint) => [joint, table[family(joint.getName())] ?? [1, 1] as const]));
  const dir = new Map(joints.map((joint) => [joint, direction(joint)]));

  const after = new Map<Node, Vec3>();
  for (const joint of ordered) {
    const parent = parentOf(joint);
    after.set(joint, parent ? add(after.get(parent)!, stretch(sub(before.get(joint)!, before.get(parent)!), dir.get(parent)!, pair.get(parent)!)) : before.get(joint)!);
  }
  // Keep the feet on the ground: everything below the root drops by what the legs lost.
  const ball = byName.get("ball_l");
  if (ball) {
    const drop = before.get(ball)![1] - after.get(ball)![1];
    for (const joint of joints) if (parentOf(joint)) after.set(joint, add(after.get(joint)!, [0, drop, 0]));
  }

  const done = new Set<Accessor>();
  for (const node of document.getRoot().listNodes()) {
    const skin = node.getSkin(), mesh = node.getMesh();
    if (!skin || !mesh) continue;
    const list = skin.listJoints();
    for (const primitive of mesh.listPrimitives()) {
      const positions = primitive.getAttribute("POSITION")!, jointIndex = primitive.getAttribute("JOINTS_0")!, weightOf = primitive.getAttribute("WEIGHTS_0")!;
      if (done.has(positions)) continue;
      done.add(positions);
      const v: number[] = [], j: number[] = [], w: number[] = [];
      for (let index = 0; index < positions.getCount(); index += 1) {
        positions.getElement(index, v);
        jointIndex.getElement(index, j);
        weightOf.getElement(index, w);
        const total = w[0]! + w[1]! + w[2]! + w[3]!;
        if (total <= 0) throw new Error(`${node.getName()}: vertex ${index} has no skin weight`);
        const out: Vec3 = [0, 0, 0];
        j.forEach((slot, k) => {
          if (!w[k]) return;
          const joint = list[slot]!;
          const moved = add(after.get(joint)!, stretch(sub(v, before.get(joint)!), dir.get(joint)!, pair.get(joint)!));
          for (const axis of [0, 1, 2]) out[axis] += moved[axis]! * w[k]! / total;
        });
        positions.setElement(index, out);
      }
    }
  }

  for (const joint of ordered) {
    const parent = parentOf(joint);
    if (parent) joint.setTranslation(timesTransposed(rotation.get(parent)!, sub(after.get(joint)!, after.get(parent)!)));
  }
  for (const skin of skins) {
    const matrices = skin.getInverseBindMatrices();
    if (!matrices) continue;
    skin.listJoints().forEach((joint, index) => {
      const r = rotation.get(joint)!;
      const t = timesTransposed(r, after.get(joint)!);
      matrices.setElement(index, [r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, -t[0], -t[1], -t[2], 1]);
    });
  }
  return new Map(joints.map((joint) => [joint.getName(), { before: before.get(joint)!, after: after.get(joint)!, rotation: rotation.get(joint)! }]));
}

/** Static pieces authored in model space on the head (the pack hairstyles) move with the `Head` joint. */
export function followHead(document: Document, change: RestChange) {
  const head = change.get("Head");
  if (!head) throw new Error("the rest change has no Head joint");
  const delta = sub(head.after, head.before);
  for (const scene of document.getRoot().listScenes()) for (const node of scene.listChildren()) node.setTranslation(add(node.getTranslation(), delta));
}

type Socket = { id: string; joint: string; translation: number[] };
/**
 * The sockets for a changed rest pose. Hair and armour sockets are the inverse of the joint's rest-world transform, so they
 * move with the joint. Hand sockets follow the smaller palm. Everything else is joint-relative and stays.
 */
export function reproportionSockets<T extends { sockets: Socket[] }>(descriptor: T, change: RestChange, table: RestProportions): T {
  return { ...descriptor, sockets: descriptor.sockets.map((socket) => {
    if (socket.id.endsWith(".armor") || socket.id === "head.hair") {
      const joint = change.get(socket.joint);
      if (!joint) throw new Error(`socket ${socket.id}: no joint ${socket.joint}`);
      return { ...socket, translation: sub(socket.translation, timesTransposed(joint.rotation, sub(joint.after, joint.before))) };
    }
    const hand = /^hand_[lr]$/.test(socket.joint) ? table.hand?.[1] : undefined;
    return hand ? { ...socket, translation: socket.translation.map((value) => value * hand) } : socket;
  }) };
}
