// Derive the hand sockets of a humanoid-sockets-v2 descriptor anatomically from a rig's rest pose
// (docs/humanoid-sockets.md#how-the-hand-sockets-are-derived, #113):
//   bun examples/weapons/derive-sockets.ts [--rig <rig.gltf>] [--out <sockets.json>] [--character <id>] [--weapon-hand r|l] [--check]
// Defaults: the canonical Male_Ranger rig and assets/descriptors/humanoid.ranger.male.sockets.json.
// `--check` compares instead of writing and exits 1 on a difference.
//
// Each hand's frame is measured in the hand joint's own glTF frame from the finger and thumb joints:
// the finger direction (hand -> middle_01), the knuckle line (pinky_01 -> index_01, toward the thumb side)
// and the palm normal (perpendicular to both, on the side of the thumb tip). The weapon's grip axis
// (+Y) runs along the knuckle line out of the thumb side of the fist, the edges (±X) along the fingers
// and the flats (±Z) face the palm and the back of the hand. The shield's handle centre sits at the same
// grip point, its face (+Z) points out of the back of the hand and its top (+Y) toward the thumb side,
// so its point hangs below the little finger: the heater is held as on enarmes, with the forearm across
// the board. The stowed sockets were authored from rest-pose world intents and are carried as-is.
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ARMOR_JOINTS } from "../../src/armor-recipes.js";
import { createHumanoidSocketDescriptor, type HumanoidSocket, type HumanoidSocketDescriptor } from "../../src/humanoid-sockets.js";

type Vec3 = [number, number, number];
type Mat4 = number[]; // column-major
type Side = "r" | "l";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const RANGER_RIG = "assets/canonical/quaternius.modular-character-outfits-fantasy-standard.male-ranger-gltf/Male_Ranger.gltf";
export const RANGER_SOCKETS = "assets/descriptors/humanoid.ranger.male.sockets.json";

/** Where the grip centre sits in the hand: a fraction of the way from the hand joint to the knuckle centroid, and how deep below the knuckle plane on the palm side. */
export const GRIP = { alongPalm: 0.8, depth: 0.03 } as const;

/** The stowed Ranger sockets (rest-pose world intents converted into the joint frames, unchanged since bundle v2). */
export const RANGER_STOWED_SOCKETS: readonly HumanoidSocket[] = [
  { id: "back.stowed", joint: "spine_03", translation: [0, -0.061607, -0.226519], rotation: [0, 0.993595, 0.113001, 0], attachFrame: "grip", accepts: ["shield"] },
  { id: "hip_l.stowed", joint: "pelvis", translation: [0.175, 0.142748, 0.127956], rotation: [-0.667907, 0.090365, -0.701309, 0.232164], attachFrame: "grip", accepts: ["one-hand-weapon"] },
];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(...a));

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return out;
}
function nodeMatrix(node: Record<string, any>): Mat4 {
  if (node.matrix) return [...node.matrix];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = node.scale ?? [1, 1, 1], [tx, ty, tz] = node.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/** Rest-pose world matrices of every named node of a glTF document (node TRS through all ancestors). */
export function restWorlds(gltf: { nodes: Record<string, any>[] }): Map<string, Mat4> {
  const parent = new Map<number, number>();
  gltf.nodes.forEach((node, index) => (node.children ?? []).forEach((child: number) => parent.set(child, index)));
  const cache = new Map<number, Mat4>();
  const world = (index: number): Mat4 => {
    const cached = cache.get(index);
    if (cached) return cached;
    const up = parent.get(index), local = nodeMatrix(gltf.nodes[index]!);
    const result = up === undefined ? local : multiply(world(up), local);
    cache.set(index, result);
    return result;
  };
  const worlds = new Map<string, Mat4>();
  gltf.nodes.forEach((node, index) => { if (node.name) worlds.set(node.name, world(index)); });
  return worlds;
}

/** A rest-pose point of joint `name`, expressed in the frame of joint `frame` (assumed rigid: rotation and translation). */
function localPoint(worlds: Map<string, Mat4>, frame: string, name: string): Vec3 {
  const f = worlds.get(frame), p = worlds.get(name);
  if (!f || !p) throw new Error(`rig has no joint '${f ? name : frame}'`);
  const d: Vec3 = [p[12]! - f[12]!, p[13]! - f[13]!, p[14]! - f[14]!];
  const column = (c: number): Vec3 => unit([f[c * 4]!, f[c * 4 + 1]!, f[c * 4 + 2]!]);
  return [dot(column(0), d), dot(column(1), d), dot(column(2), d)];
}

export type HandFrame = { joint: string; fingers: Vec3; knuckles: Vec3; palm: Vec3; grip: Vec3 };

/** The anatomical frame of `hand_<side>` in its own joint frame, from UE-style finger joint names. */
export function handFrame(worlds: Map<string, Mat4>, side: Side): HandFrame {
  const joint = `hand_${side}`, at = (name: string) => localPoint(worlds, joint, `${name}_${side}`);
  const index = at("index_01"), middle = at("middle_01"), ring = at("ring_01"), pinky = at("pinky_01"), thumbTip = at("thumb_03");
  const fingers = unit(middle), knuckles = unit(sub(index, pinky));
  const centroid = scale(add(add(index, middle), add(ring, pinky)), 1 / 4);
  let palm = unit(cross(fingers, knuckles));
  if (dot(sub(thumbTip, centroid), palm) < 0) palm = scale(palm, -1);
  if (dot(sub(thumbTip, pinky), knuckles) <= 0) throw new Error(`${joint}: the thumb is not on the index side of the knuckle line`);
  const grip = add(scale(centroid, GRIP.alongPalm), scale(palm, GRIP.depth));
  return { joint, fingers, knuckles, palm, grip };
}

/** Unit quaternion (x, y, z, w) of the rotation whose columns are the orthonormal axes x, y, z. */
export function quaternionFromAxes(x: Vec3, y: Vec3, z: Vec3): [number, number, number, number] {
  const [m00, m10, m20] = x, [m01, m11, m21] = y, [m02, m12, m22] = z, trace = m00 + m11 + m22;
  let q: [number, number, number, number];
  if (trace > 0) { const s = Math.sqrt(trace + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]; }
  if (q[3] < 0) q = q.map((v) => -v) as typeof q; // canonical sign: w >= 0
  return q;
}

const round = (value: number, digits: number) => Number(value.toFixed(digits)) + 0;

function socket(id: string, frame: HandFrame, y: Vec3, z: Vec3, accepts: string[]): HumanoidSocket {
  const x = cross(y, z);
  return {
    id, joint: frame.joint,
    translation: frame.grip.map((v) => round(v, 4)) as Vec3,
    rotation: quaternionFromAxes(x, y, z).map((v) => round(v, 6)) as HumanoidSocket["rotation"],
    attachFrame: "grip", accepts,
  };
}

/**
 * A stowed socket authored as a rest-pose world intent: the item frame's origin at `position`, its +Y along
 * `y` and its +Z along `z` (made orthogonal to `y`), all in the rig's rest world, converted into `joint`'s frame.
 */
export function stowedSocket(worlds: Map<string, Mat4>, id: string, joint: string, position: Vec3, y: Vec3, z: Vec3, accepts: string[]): HumanoidSocket {
  const f = worlds.get(joint);
  if (!f) throw new Error(`rig has no joint '${joint}'`);
  const column = (c: number): Vec3 => unit([f[c * 4]!, f[c * 4 + 1]!, f[c * 4 + 2]!]);
  const toLocal = (v: Vec3): Vec3 => [dot(column(0), v), dot(column(1), v), dot(column(2), v)];
  const wy = unit(y), wz = unit(sub(z, scale(wy, dot(z, wy)))), wx = cross(wy, wz);
  const offset = toLocal(sub(position, [f[12]!, f[13]!, f[14]!]));
  return {
    id, joint, translation: offset.map((v) => round(v, 4)) as Vec3,
    rotation: quaternionFromAxes(toLocal(wx), toLocal(wy), toLocal(wz)).map((v) => round(v, 6)) as HumanoidSocket["rotation"], attachFrame: "grip", accepts,
  };
}

/**
 * The archery sockets (#113 bow slice): the bow in the off hand with its limbs along the knuckle line and the
 * arrow leaving along the fingers; the arrow's nock in the weapon hand, the shaft along the knuckle line toward
 * the index finger; the quiver on the back with its mouth over the weapon-side shoulder; and the bow slung
 * diagonally across the back, outside the quiver, its string toward the body.
 */
export function deriveArcherySockets(gltf: { nodes: Record<string, any>[] }): HumanoidSocket[] {
  const worlds = restWorlds(gltf), bowHand = handFrame(worlds, "l"), arrowHand = handFrame(worlds, "r");
  return [
    // The finger direction is not quite perpendicular to the knuckle line; keep its component across the grip.
    socket("hand_l.bow", bowHand, bowHand.knuckles, unit(sub(bowHand.fingers, scale(bowHand.knuckles, dot(bowHand.fingers, bowHand.knuckles)))), ["bow"]),
    socket("hand_r.arrow", arrowHand, arrowHand.palm, arrowHand.knuckles, ["arrow"]),
    stowedSocket(worlds, "back.quiver", "spine_03", [-0.07, 1.3, -0.22], [-0.35, 1, 0], [0, 0, -1], ["quiver"]),
    stowedSocket(worlds, "back.bow.stowed", "spine_03", [0.02, 1.22, -0.3], [0.75, 1, 0], [0, 0, -1], ["bow"]),
  ];
}

/**
 * The hair socket (#116): the "Origin at 0" hairstyles are modelled in the character's rest model space, so the
 * socket is the inverse of the `Head` joint's rest-world transform. At rest the hair lands exactly where it was
 * modelled, and it then follows the head.
 */
export function deriveHairSockets(gltf: { nodes: Record<string, any>[] }): HumanoidSocket[] {
  return [stowedSocket(restWorlds(gltf), "head.hair", "Head", [0, 0, 0], [0, 1, 0], [0, 0, 1], ["hair"])];
}

/**
 * The armour sockets (#117): rigid armour pieces are fitted in the character's rest model space, so each joint they
 * ride gets a `<joint>.armor` socket (lowercase joint) that is the inverse of its rest-world transform, like `head.hair`.
 */
export function deriveArmorSockets(gltf: { nodes: Record<string, any>[] }): HumanoidSocket[] {
  const worlds = restWorlds(gltf);
  return ARMOR_JOINTS.map((joint) => stowedSocket(worlds, `${joint.toLowerCase()}.armor`, joint, [0, 0, 0], [0, 1, 0], [0, 0, 1], ["armor"]));
}

/** The weapon socket (grip along the knuckle line, flats facing the back of the hand) and the shield socket (face out of the back of the hand, top toward the thumb). */
export function deriveHandSockets(gltf: { nodes: Record<string, any>[] }, { weaponHand = "r" }: { weaponHand?: Side } = {}): HumanoidSocket[] {
  const worlds = restWorlds(gltf), shieldHand: Side = weaponHand === "r" ? "l" : "r";
  const weapon = handFrame(worlds, weaponHand), shield = handFrame(worlds, shieldHand);
  const back = (frame: HandFrame) => scale(frame.palm, -1);
  return [
    socket(`hand_${weaponHand}.weapon`, weapon, weapon.knuckles, back(weapon), ["one-hand-weapon"]),
    // #379: the Arcanist's tome is held like the shield.
    socket(`hand_${shieldHand}.shield`, shield, shield.knuckles, back(shield), ["shield", "book"]),
  ];
}

/**
 * Both handednesses (#264): the right-handed weapon and shield sockets, then their left-handed counterparts, each
 * pair declaring the other as its `mirror` so one loadout serves a left-handed character.
 */
export function deriveMirroredHandSockets(gltf: { nodes: Record<string, any>[] }): HumanoidSocket[] {
  const [weaponR, shieldL] = deriveHandSockets(gltf), [weaponL, shieldR] = deriveHandSockets(gltf, { weaponHand: "l" });
  return [
    { ...weaponR!, mirror: weaponL!.id }, { ...shieldL!, mirror: shieldR!.id },
    { ...weaponL!, mirror: weaponR!.id }, { ...shieldR!, mirror: shieldL!.id },
  ];
}

/**
 * How a staff stands in the hand (#372): the shaft runs from the palm up past the wrist, turned `tiltDegrees` from
 * the forearm line toward the thumb side and leaning `outward` (of the palm normal) away from the body. In the
 * Ranger's hanging-arm idle this stands the staff nearly upright beside the leg, its foot near the ground.
 */
export const STAFF_GRIP = { tiltDegrees: 34, outward: 0.15 } as const;

/** The held staff sockets: shaft (+Y) as in STAFF_GRIP, +Z toward the back of the hand; a mirrored pair. */
export function deriveStaffSockets(gltf: { nodes: Record<string, any>[] }): HumanoidSocket[] {
  const worlds = restWorlds(gltf), tilt = STAFF_GRIP.tiltDegrees * Math.PI / 180;
  const [right, left] = (["r", "l"] as const).map((side) => {
    const frame = handFrame(worlds, side);
    const y = unit(add(add(scale(frame.fingers, -Math.cos(tilt)), scale(frame.knuckles, Math.sin(tilt))), scale(frame.palm, -STAFF_GRIP.outward)));
    const back = scale(frame.palm, -1);
    return socket(`hand_${side}.staff`, frame, y, unit(sub(back, scale(y, dot(back, y)))), ["staff"]);
  });
  return [{ ...right!, mirror: left!.id }, { ...left!, mirror: right!.id }];
}

/**
 * The held crossbow sockets (#389): the hand closes round the stock's wrist, so the stock (+Z, the bolt's flight)
 * runs along the knuckle line out of the thumb side of the fist, and the top of the stock (+Y) faces the wrist, so the
 * trigger lever lies under the fingers. In the Ranger's hanging-arm idle the crossbow is carried level at the hip,
 * pointing forward with its prod across; a mirrored pair.
 */
export function deriveCrossbowSockets(gltf: { nodes: Record<string, any>[] }): HumanoidSocket[] {
  const worlds = restWorlds(gltf);
  const [right, left] = (["r", "l"] as const).map((side) => {
    const frame = handFrame(worlds, side);
    const wrist = scale(sub(frame.fingers, scale(frame.knuckles, dot(frame.fingers, frame.knuckles))), -1);
    return socket(`hand_${side}.crossbow`, frame, unit(wrist), frame.knuckles, ["crossbow"]);
  });
  return [{ ...right!, mirror: left!.id }, { ...left!, mirror: right!.id }];
}

/** The committed layout: one socket per three lines. */
export function formatSocketDescriptor(descriptor: HumanoidSocketDescriptor): string {
  const list = (values: readonly unknown[]) => `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;
  const sockets = descriptor.sockets.map((s) =>
    `    {"id": ${JSON.stringify(s.id)}, "joint": ${JSON.stringify(s.joint)},\n` +
    `     "translation": ${list(s.translation)}, "rotation": ${list(s.rotation)},${s.scale ? ` "scale": ${list(s.scale)},` : ""}\n` +
    `     "attachFrame": ${JSON.stringify(s.attachFrame)}, "accepts": ${list(s.accepts)}${s.mirror ? `, "mirror": ${JSON.stringify(s.mirror)}` : ""}}`);
  return `{\n  "schema": ${JSON.stringify(descriptor.schema)},\n  "character": ${JSON.stringify(descriptor.character)},\n  "unit": "meter",\n` +
    `  "axes": "right-handed-y-up",\n  "sockets": [\n${sockets.join(",\n")}\n  ]\n}\n`;
}

/** The Ranger descriptor: the mirrored hand sockets, the stowed sockets, the archery, hair, armour, staff and crossbow sockets. */
export function deriveRangerSockets(gltf: { nodes: Record<string, any>[]; skins?: { joints: number[] }[] }, character = "humanoid.ranger.male"): string {
  const joints = gltf.skins?.[0]?.joints.map((index) => gltf.nodes[index]!.name as string);
  return formatSocketDescriptor(createHumanoidSocketDescriptor({
    character, sockets: [...deriveMirroredHandSockets(gltf), ...RANGER_STOWED_SOCKETS, ...deriveArcherySockets(gltf), ...deriveHairSockets(gltf),
      ...deriveArmorSockets(gltf), ...deriveStaffSockets(gltf), ...deriveCrossbowSockets(gltf)], ...(joints ? { joints } : {}),
  }));
}

if (import.meta.main) {
  const args = process.argv.slice(2), option = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const rig = path.resolve(ROOT, option("--rig") ?? RANGER_RIG), out = path.resolve(ROOT, option("--out") ?? RANGER_SOCKETS);
  const weaponHand = option("--weapon-hand") ?? "r";
  if (weaponHand !== "r" && weaponHand !== "l") throw new Error("--weapon-hand must be r or l");
  const gltf = JSON.parse(await readFile(rig, "utf8"));
  const text = weaponHand === "r" ? deriveRangerSockets(gltf, option("--character") ?? "humanoid.ranger.male")
    : formatSocketDescriptor(createHumanoidSocketDescriptor({ character: "humanoid.ranger.male", sockets: deriveHandSockets(gltf, { weaponHand }) }));
  if (args.includes("--check")) {
    const current = await readFile(out, "utf8").catch(() => "");
    if (current !== text) { console.error(`${path.relative(ROOT, out)} differs from the derived sockets`); process.exit(1); }
    console.log(`${path.relative(ROOT, out)} matches the derived sockets`);
  } else {
    await writeFile(out, text);
    console.log(`wrote ${path.relative(ROOT, out)}`);
  }
}
