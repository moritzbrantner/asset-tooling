/**
 * The combat-animation checks of docs/combat-animation-standard.md (#737), run on a built clip: the held weapon stays
 * out of the wielder's body, a foot marked planted stays put, and the strike is much faster than its wind-up.
 *
 * A clip is sampled at its own rate from its glTF channels (linear, as the clips ship) on the figure's joints. The body
 * is four capsules on its joints (`BODY_CAPSULES`); the weapon is one or more capsules along its grip frame's +Y, on its
 * hand socket (`COMBAT_ITEM_CAPSULES`), less the stretch within `GRIP_TOLERANCE` of either hand, where the item is held.
 */
import type { Animation, Document, Node } from "@gltf-transform/core";

type Vec3 = [number, number, number];
type Mat4 = number[];

/** One stretch of an item along its grip frame's +Y (metres from the grip), and its radius. */
export type ItemCapsule = { from: number; to: number; radius: number };
/**
 * The items a clip may hold, as capsules measured from the published `humanoid-equipment` meshes (2026-11-17): the
 * blade, haft or shaft along +Y, and a heavy head as its own wider capsule.
 */
export const COMBAT_ITEM_CAPSULES: Readonly<Record<string, readonly ItemCapsule[]>> = {
  "equipment.sword.arming": [{ from: -.11, to: .84, radius: .03 }],
  "equipment.mace.flanged": [{ from: -.11, to: .4, radius: .02 }, { from: .4, to: .56, radius: .055 }],
  "equipment.dagger.blackened": [{ from: -.08, to: .41, radius: .02 }],
  "equipment.staff.quarter": [{ from: -.8, to: 1, radius: .022 }],
  "equipment.spear.leaf": [{ from: -.83, to: 1.46, radius: .026 }],
  "equipment.warhammer.maul": [{ from: -.3, to: .6, radius: .025 }, { from: .6, to: .75, radius: .09 }],
  "equipment.bow.long": [{ from: -1, to: 1, radius: .05 }],
};
/**
 * The wielder's body: the torso from the pelvis to the neck, the head from its joint up along the neck, and each thigh
 * from the hip to the knee, with radii measured on the Ranger mesh in its idle (the median distance of its surface).
 */
export const BODY_CAPSULES: readonly { part: string; from: string; to: string; radius: number; extend?: number }[] = [
  { part: "torso", from: "pelvis", to: "neck_01", radius: .12 },
  { part: "head", from: "Head", to: "Head", radius: .1, extend: .17 },
  { part: "thigh_l", from: "thigh_l", to: "calf_l", radius: .075 },
  { part: "thigh_r", from: "thigh_r", to: "calf_r", radius: .075 },
];
/** How far from a hand's joint the held item may touch the body: the hand holds it there. */
export const GRIP_TOLERANCE = .1;
/** How deep the weapon may sink into a body capsule (the capsules are approximate). */
export const CLEARANCE_TOLERANCE = .02;
/**
 * mmorpg#804: how many steps inside each frame the clearance check samples with `substeps`. A consumer interpolates
 * between the keys, so a hand that turns most of a revolution from one key to the next can whip its weapon through the
 * body between two clean keys (`Sword_Cleave` did, at 0.41 s). The default (1) checks the keys alone.
 */
export const CLEARANCE_SUBSTEPS = 4;
/** How far a foot's ball may drift while the clip marks it planted. */
export const PLANTED_DRIFT_LIMIT = .02;
/** How many times the wind-up's mean strike-point speed the strike's peak must reach. */
export const STRIKE_SPEED_RATIO = 3;

/** What a check reads from a clip's `humanoid-clips` entry: its strike object and duration. */
export type CombatClipEntry = {
  name: string; durationSeconds: number;
  strike?: {
    weapon?: { item?: string; socket?: string; strikePoint?: number[]; joint?: string };
    contactSeconds?: number; windupEnd?: number; recoveryStart?: number; footPlants?: Record<string, number[][]>;
  };
};
/** `frame` counts the clip's frames and falls between two when the check samples `substeps`. */
export type ClearanceReport = {
  worstMeters: number; frame: number; seconds: number; part: string; alongItemMeters: number; ok: boolean;
  /** The deepest point in the first frame: the pose the clip starts from (an idle hold may touch the body). */
  startMeters: number;
};
export type FootReport = { worstMeters: number; foot: string; span: number[]; ok: boolean };
export type TimingReport = {
  windupEnd: number; contactSeconds: number; windupMeanSpeed: number; strikePeakSpeed: number; ratio: number;
  /** True when the clip records no `windupEnd`: the wind-up then ends at the strike point's slowest frame in the last two thirds before the contact. */
  inferredWindupEnd: boolean; ok: boolean;
};
export type CombatClipReport = { clip: string; clearance?: ClearanceReport; feet?: FootReport; timing?: TimingReport };

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: Vec3) => Math.sqrt(dot(a, a));
const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits + 0;

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) for (let row = 0; row < 4; row += 1) {
    let sum = 0;
    for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row]! * b[column * 4 + k]!;
    out[column * 4 + row] = sum;
  }
  return out;
}

function compose(t: readonly number[], q: readonly number[]): Mat4 {
  const [x, y, z, w] = q as [number, number, number, number];
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    t[0]!, t[1]!, t[2]!, 1,
  ];
}

const transform = (m: Mat4, p: Vec3): Vec3 => [
  m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
  m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
  m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
];

function segmentDistance(p: Vec3, a: Vec3, b: Vec3) {
  const ab = sub(b, a), squared = dot(ab, ab);
  const t = squared < 1e-12 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / squared));
  return length(sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]));
}

/** A channel's value at `seconds` from the clip's start: linear between its keys, rotations normalised. */
function sampleAt(input: Float32Array | number[], output: { getElement: (index: number, target: number[]) => number[] }, start: number, seconds: number, rotation: boolean) {
  const t = start + seconds, last = input.length - 1;
  let index = 0;
  while (index < last && input[index + 1]! <= t) index += 1;
  const a = output.getElement(index, []);
  if (index >= last || t <= input[index]!) return a;
  const b = output.getElement(index + 1, []);
  const u = (t - input[index]!) / (input[index + 1]! - input[index]!);
  const sign = rotation && a.reduce((sum, value, k) => sum + value * b[k]!, 0) < 0 ? -1 : 1;
  const mixed = a.map((value, k) => value + (sign * b[k]! - value) * u);
  if (!rotation) return mixed;
  const norm = Math.hypot(...mixed);
  return mixed.map((value) => value / norm);
}

const channelsOf = (animation: Animation) => animation.listChannels()
  .filter((channel) => channel.getTargetPath() === "translation" || channel.getTargetPath() === "rotation")
  .map((channel) => ({
    node: channel.getTargetNode()!, path: channel.getTargetPath() === "translation" ? "t" as const : "r" as const,
    input: channel.getSampler()!.getInput()!.getArray()! as Float32Array, output: channel.getSampler()!.getOutput()!,
  }));

/**
 * Every joint's world matrix per frame of `animation` (frame k at k / rate seconds), by joint name. A joint the clip
 * leaves alone holds `base`'s first pose (the idle an upper-body clip is layered over), else its rest pose.
 */
export function samplePoses(document: Document, animation: Animation, rate = 30, base?: Animation): { seconds: number[]; worlds: Map<string, Mat4>[] } {
  const nodes = document.getRoot().listNodes();
  const parent = new Map<Node, Node>();
  for (const node of nodes) for (const child of node.listChildren()) parent.set(child, node);
  const channels = channelsOf(animation);
  const start = Math.min(...channels.map((channel) => channel.input[0]!));
  const end = Math.max(...channels.map((channel) => channel.input[channel.input.length - 1]!));
  const count = Math.round((end - start) * rate);
  const held = new Map<Node, { t: number[]; r: number[] }>();
  for (const node of nodes) held.set(node, { t: [...node.getTranslation()], r: [...node.getRotation()] });
  if (base) {
    const baseChannels = channelsOf(base);
    const baseStart = Math.min(...baseChannels.map((channel) => channel.input[0]!));
    for (const channel of baseChannels) held.get(channel.node)![channel.path] = sampleAt(channel.input, channel.output, baseStart, 0, channel.path === "r");
  }
  const seconds: number[] = [], worlds: Map<string, Mat4>[] = [];
  for (let frame = 0; frame <= count; frame += 1) {
    const time = frame / rate;
    const local = new Map<Node, { t: number[]; r: number[] }>();
    for (const node of nodes) local.set(node, { ...held.get(node)! });
    for (const channel of channels) local.get(channel.node)![channel.path] = sampleAt(channel.input, channel.output, start, time, channel.path === "r");
    const world = new Map<Node, Mat4>();
    const resolve = (node: Node): Mat4 => {
      const known = world.get(node);
      if (known) return known;
      const { t, r } = local.get(node)!;
      const above = parent.get(node);
      const matrix = above ? multiply(resolve(above), compose(t, r)) : compose(t, r);
      world.set(node, matrix);
      return matrix;
    };
    const named = new Map<string, Mat4>();
    for (const node of nodes) named.set(node.getName(), resolve(node));
    seconds.push(round(time));
    worlds.push(named);
  }
  return { seconds, worlds };
}

const position = (matrix: Mat4): Vec3 => [matrix[12]!, matrix[13]!, matrix[14]!];

/**
 * Check one clip (`entry` from `humanoid-clips`) of `document` against the standard. `sockets` are the figure's
 * `humanoid-sockets` entries. A check the clip gives no data for is left out of the report: clearance needs an item of
 * `COMBAT_ITEM_CAPSULES`, the planted feet `strike.footPlants`, the timing `strike.contactSeconds`. The joints a clip
 * does not key (an upper-body clip's legs) stand in `base`'s first pose, the idle the game layers it over. With
 * `substeps` (`CLEARANCE_SUBSTEPS`) the clearance is also checked between the keys.
 */
export function checkCombatClip(document: Document, entry: CombatClipEntry, sockets: readonly { id: string; joint: string; translation: number[]; rotation: number[] }[],
  { rate = 30, base = "Idle_Loop", substeps = 1 }: { rate?: number; base?: string; substeps?: number } = {}): CombatClipReport {
  const animations = document.getRoot().listAnimations();
  const animation = animations.find((candidate) => candidate.getName() === entry.name);
  if (!animation) throw new Error(`${entry.name}: no such clip`);
  const { seconds, worlds } = samplePoses(document, animation, rate, animations.find((candidate) => candidate.getName() === base));
  const report: CombatClipReport = { clip: entry.name };
  const strike = entry.strike ?? {};
  const item = strike.weapon?.item ? COMBAT_ITEM_CAPSULES[strike.weapon.item] : undefined;
  const socket = sockets.find((candidate) => candidate.id === strike.weapon?.socket);
  const grip = socket ? compose(socket.translation, socket.rotation) : undefined;
  const gripAt = (frame: number) => multiply(worlds[frame]!.get(socket!.joint)!, grip!);

  if (item && socket) {
    let worst: Omit<ClearanceReport, "startMeters"> | undefined, start = -Infinity;
    const fine = substeps === 1 ? { seconds, worlds } : samplePoses(document, animation, rate * substeps, animations.find((candidate) => candidate.getName() === base));
    for (let sample = 0; sample < fine.worlds.length; sample += 1) {
      const joints = fine.worlds[sample]!, at = multiply(joints.get(socket.joint)!, grip!);
      const frame = round(sample / substeps, 2);
      const hands = [position(joints.get("hand_l")!), position(joints.get("hand_r")!)];
      const body = BODY_CAPSULES.map(({ part, from, to, radius, extend }) => {
        const a = position(joints.get(from)!);
        if (!extend) return { part, a, b: position(joints.get(to)!), radius };
        const neck = sub(a, position(joints.get("neck_01")!)), scale = extend / length(neck);
        return { part, a, b: [a[0] + neck[0] * scale, a[1] + neck[1] * scale, a[2] + neck[2] * scale] as Vec3, radius };
      });
      for (const { from, to, radius } of item) {
        const steps = Math.max(2, Math.ceil((to - from) / .02));
        for (let step = 0; step <= steps; step += 1) {
          const along = from + (to - from) * step / steps;
          const point = transform(at, [0, along, 0]);
          if (hands.some((hand) => length(sub(point, hand)) < GRIP_TOLERANCE)) continue;
          for (const capsule of body) {
            const depth = capsule.radius + radius - segmentDistance(point, capsule.a, capsule.b);
            if (sample === 0) start = Math.max(start, depth);
            if (!worst || depth > worst.worstMeters) {
              worst = { worstMeters: depth, frame, seconds: fine.seconds[sample]!, part: capsule.part, alongItemMeters: round(along, 2), ok: false };
            }
          }
        }
      }
    }
    if (worst) report.clearance = { ...worst, worstMeters: round(worst.worstMeters), ok: worst.worstMeters <= CLEARANCE_TOLERANCE, startMeters: round(start) };
  }

  if (strike.footPlants) {
    let worst: FootReport = { worstMeters: 0, foot: "", span: [], ok: true };
    for (const [foot, spans] of Object.entries(strike.footPlants)) {
      for (const span of spans) {
        const [a, b] = span.map((time) => Math.round(time * rate)) as [number, number];
        const start = position(worlds[a]!.get(`ball_${foot}`)!);
        for (let frame = a; frame <= Math.min(b, worlds.length - 1); frame += 1) {
          const drift = length(sub(position(worlds[frame]!.get(`ball_${foot}`)!), start));
          if (drift > worst.worstMeters) worst = { worstMeters: drift, foot, span, ok: false };
        }
      }
    }
    report.feet = { ...worst, worstMeters: round(worst.worstMeters), ok: worst.worstMeters <= PLANTED_DRIFT_LIMIT };
  }

  if (strike.contactSeconds !== undefined) {
    // The strike point: the item's on its socket, a fist's or foot's joint.
    const point = (frame: number) => item && socket && strike.weapon?.strikePoint
      ? transform(gripAt(frame), strike.weapon.strikePoint as Vec3)
      : position(worlds[frame]!.get(strike.weapon?.joint ?? "hand_r")!);
    const speeds = worlds.slice(1).map((_, frame) => length(sub(point(frame + 1), point(frame))) * rate);
    const contact = Math.min(Math.round(strike.contactSeconds * rate), speeds.length);
    let windup = strike.windupEnd === undefined ? undefined : Math.round(strike.windupEnd * rate);
    const inferred = windup === undefined;
    if (windup === undefined) {
      // The anticipation's still point: the slowest frame in the last two thirds before the contact.
      windup = Math.floor(contact / 3);
      for (let frame = windup + 1; frame < contact; frame += 1) if (speeds[frame]! < speeds[windup]!) windup = frame;
    }
    const before = speeds.slice(0, Math.max(1, windup));
    const mean = before.reduce((sum, speed) => sum + speed, 0) / before.length;
    const peak = Math.max(...speeds.slice(windup, Math.max(windup + 1, contact)));
    const ratio = peak / Math.max(mean, 1e-6);
    report.timing = {
      windupEnd: round(windup / rate), contactSeconds: round(contact / rate), windupMeanSpeed: round(mean, 2), strikePeakSpeed: round(peak, 2),
      ratio: round(ratio, 2), inferredWindupEnd: inferred, ok: ratio >= STRIKE_SPEED_RATIO,
    };
  }
  return report;
}

/** What a check needs from a strike clip's weapon: the item, its socket and the point that strikes, by role family. */
const ROLE_WEAPONS: Readonly<Record<string, NonNullable<NonNullable<CombatClipEntry["strike"]>["weapon"]>>> = {
  sword: { item: "equipment.sword.arming", socket: "hand_r.weapon", strikePoint: [0, .84, 0] },
  // The staff strikes lead with the staff's foot (adapters/blender/cast_clips.py).
  staff: { item: "equipment.staff.quarter", socket: "hand_r.staff", strikePoint: [0, -.8, 0] },
  mace: { item: "equipment.mace.flanged", socket: "hand_r.weapon", strikePoint: [0, .5, 0] },
};

/**
 * A `humanoid-clips` entry as the checks read it. A clip with a `strike` object is checked as it is. A strike that records
 * none (the library sword strikes, and since mmorpg#804 the cast recipe's `staff.strike.*` and `mace.strike.*`) is
 * checked with its role family's item on its socket (`ROLE_WEAPONS`) and its measured contact; `footPlants` adds the
 * spans its recipe plants the feet. Undefined for a clip that is no checkable strike.
 */
export function combatCheckEntry(clip: CombatClipEntry & { role?: string; contact?: { seconds: number } },
  footPlants?: Record<string, number[][]>): CombatClipEntry | undefined {
  if (clip.strike) return clip;
  const family = /^(sword|staff|mace)\./.exec(clip.role ?? "")?.[1];
  if (!family || !clip.contact || (family !== "sword" && !/\.strike\./.test(clip.role!))) return undefined;
  return { ...clip, strike: { weapon: ROLE_WEAPONS[family], contactSeconds: clip.contact.seconds, ...(footPlants ? { footPlants } : {}) } };
}
