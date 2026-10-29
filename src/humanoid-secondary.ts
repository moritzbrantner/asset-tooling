import { MathUtils, NodeIO, type Document, type Node, type Skin } from "@gltf-transform/core";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { sha256Bytes } from "./hash.js";
import type { AssetRef } from "./operations.js";

/**
 * Accessory bones for secondary motion (#391, mmorpg#498): short joint chains for hair, beards, long skirts, aprons,
 * capes and hanging straps that a consumer springs on top of the clips, without a cloth engine.
 *
 * Every chain hangs from a `parent` joint and takes over part of that joint's skin weight on the listed garment or
 * hair nodes. At rest a chain joint moves rigidly with its parent, so a chain left in its bind pose deforms the mesh
 * exactly as before: the clips need no new tracks, and a consumer that ignores the chains sees no change. The share
 * a vertex hands over grows from 0 at the chain's top to all of it `rampLength` lower, so the waist, the scalp and the
 * jaw never move. Other joints keep their weights, so a robe's hem still follows the striding thighs.
 *
 * Joints are axis-aligned with the character's rest frame (identity world rotation at rest); each one sits on the
 * garment surface at its height, and the chain runs straight down. Hair and facial hair entries are static items:
 * they get their own skin whose root joint (`hair_root`, `beard_root`) is the item's scene origin, so it rides the
 * socket exactly as the item did.
 */

/** How strongly a vertex belongs to a chain, before the height ramp. */
export type SecondarySelect =
  /** Angle round the vertical axis: max(0, cos(Δangle))^power. Four chains 90° apart with power 2 sum to 1. */
  | { type: "sector"; power: number }
  /** Horizontal distance from the chain's top joint: 1 within `radius`, falling to 0 at 1.5 × `radius`. */
  | { type: "radius"; radius: number }
  | { type: "all" };

export interface SecondaryChainSpec {
  id: string;
  kind: "skirt" | "apron" | "cape" | "strap" | "hair" | "beard";
  /** The joint whose share moves to the chain (for items, the root joint the build adds). */
  parent: string;
  /** Joint name prefix; joints are `<prefix>_01` …. */
  prefix: string;
  /** Mesh nodes whose weights move to the chain. */
  nodes: string[];
  /** Nodes whose vertices place the joints and the hem (default: `nodes`). */
  anchor?: string[];
  /** Height (y, metres) of the first joint. */
  top: number;
  /** Most joints; fewer on a short garment, so joints stay at least `minSegment` (default 0.12 m) apart. */
  count: number;
  minSegment?: number;
  /** Direction round the vertical axis (degrees): 0 front (+Z), 90 left (+X), 180 back, 270 right. */
  direction: number;
  /** The vertical axis [x, z] the direction is measured round. */
  axis: [number, number];
  select: SecondarySelect;
  /** Height below `top` over which the share ramps from 0 to 1. */
  rampLength: number;
  /** A suggested bound on each joint's swing from rest. */
  swingLimitDegrees: number;
}

export interface SecondaryChain {
  id: string;
  kind: SecondaryChainSpec["kind"];
  parent: string;
  joints: string[];
  swingLimitDegrees: number;
  nodes: string[];
}

const MIN_SEGMENT = 0.12;
const BAND = 0.025;
const MAX_INFLUENCES = 4;

type Vec3 = [number, number, number];
type Mat4 = number[];

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row]! * b[column * 4 + k]!;
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

export function invert(m: Mat4): Mat4 {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) throw new Error("secondary chains: singular matrix");
  const d = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d, (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d, (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d, (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d, (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ];
}

const translation = ([x, y, z]: Vec3): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const IDENTITY: Mat4 = translation([0, 0, 0]);

function setLocal(node: Node, matrix: Mat4) {
  const t: Vec3 = [0, 0, 0], r: [number, number, number, number] = [0, 0, 0, 1], s: Vec3 = [1, 1, 1];
  MathUtils.decompose(matrix as never, t, r, s);
  node.setTranslation(t).setRotation(r).setScale(s);
}

function positionsOf(document: Document, names: readonly string[]) {
  const points: Vec3[] = [];
  for (const node of document.getRoot().listNodes()) {
    if (!names.includes(node.getName()) || !node.getMesh()) continue;
    for (const primitive of node.getMesh()!.listPrimitives()) {
      const position = primitive.getAttribute("POSITION")!;
      const p: number[] = [];
      for (let index = 0; index < position.getCount(); index += 1) points.push(position.getElement(index, p).slice(0, 3) as Vec3);
    }
  }
  return points;
}

function angleOf(spec: SecondaryChainSpec, p: Vec3) {
  return Math.atan2(p[0] - spec.axis[0], p[2] - spec.axis[1]);
}

/** Affinity of a point to the chain, before the height ramp. */
function affinity(spec: SecondaryChainSpec, p: Vec3) {
  const { select } = spec;
  if (select.type === "all") return 1;
  if (select.type === "radius") {
    const distance = Math.hypot(p[0] - spec.axis[0], p[2] - spec.axis[1]);
    return Math.max(0, Math.min(1, (1.5 * select.radius - distance) / (0.5 * select.radius)));
  }
  const delta = angleOf(spec, p) - (spec.direction * Math.PI) / 180;
  return Math.max(0, Math.cos(delta)) ** select.power;
}

/** The chain's joint positions (bind space) and the hem height, from its anchor nodes. */
export function placeChain(document: Document, spec: SecondaryChainSpec) {
  const all = positionsOf(document, spec.anchor ?? spec.nodes);
  if (!all.length) throw new Error(`secondary chain ${spec.id}: no anchor vertices in ${(spec.anchor ?? spec.nodes).join(", ")}`);
  const direction = (spec.direction * Math.PI) / 180;
  const offset = spec.select.type === "radius" ? 0 : 0.1;
  const guess: Vec3 = [spec.axis[0] + Math.sin(direction) * offset, spec.top, spec.axis[1] + Math.cos(direction) * offset];
  const inside = all.filter((p) => affinity(spec, p) > 0.5);
  if (!inside.length) throw new Error(`secondary chain ${spec.id}: no anchor vertices face its direction`);
  const hem = Math.min(...inside.map((p) => p[1]));
  if (hem >= spec.top) throw new Error(`secondary chain ${spec.id}: the anchor does not reach below ${spec.top}`);
  const count = Math.max(1, Math.min(spec.count, Math.floor((spec.top - hem) / (spec.minSegment ?? MIN_SEGMENT))));
  const heights = Array.from({ length: count + 1 }, (_, k) => spec.top - (k * (spec.top - hem)) / count);
  const points = heights.map((height): Vec3 => {
    const band = inside.filter((p) => Math.abs(p[1] - height) <= BAND);
    if (!band.length) return [guess[0], height, guess[2]];
    return [band.reduce((sum, p) => sum + p[0], 0) / band.length, height, band.reduce((sum, p) => sum + p[2], 0) / band.length];
  });
  const joints = Array.from({ length: count }, (_, k) => `${spec.prefix}_${String(k + 1).padStart(2, "0")}`);
  return { joints, points, hem };
}

/** Influence of each chain joint on a point: (joint index, weight) pairs summing to the chain's share. */
function chainInfluence(points: Vec3[], y: number, share: number): [number, number][] {
  const count = points.length - 1;
  for (let k = 0; k < count; k += 1) {
    const upper = points[k]![1], lower = points[k + 1]![1];
    if (y >= lower || k === count - 1) {
      if (k === count - 1) return [[k, share]];
      const t = Math.min(1, Math.max(0, (upper - y) / (upper - lower)));
      return [[k, share * (1 - t)], [k + 1, share * t]];
    }
  }
  return [[count - 1, share]];
}

interface Placed { spec: SecondaryChainSpec; joints: Node[]; points: Vec3[]; names: string[] }

function ibmOf(skin: Skin, joint: Node): Mat4 {
  const index = skin.listJoints().indexOf(joint);
  const accessor = skin.getInverseBindMatrices();
  if (index < 0) throw new Error(`secondary chains: ${joint.getName()} is not a joint of the skin`);
  return accessor ? accessor.getElement(index, []) : IDENTITY;
}

/**
 * Adds the chains to `document` and moves the weights; returns the chains that took any weight. Items (nodes without
 * a skin) get a skin rooted at a new `parent` joint at the scene origin first, with every vertex on it.
 */
export function addSecondaryChains(document: Document, specs: readonly SecondaryChainSpec[]): SecondaryChain[] {
  const root = document.getRoot();
  const buffer = root.listBuffers()[0] ?? document.createBuffer();
  const byName = (name: string) => root.listNodes().find((node) => node.getName() === name);
  // Items: skin the listed nodes to a root joint at the origin.
  for (const spec of specs) {
    for (const name of spec.nodes) {
      const node = byName(name);
      if (!node?.getMesh()) throw new Error(`secondary chain ${spec.id}: no mesh node ${name}`);
      if (node.getSkin()) continue;
      let parent = byName(spec.parent);
      if (!parent) {
        parent = document.createNode(spec.parent);
        (root.getDefaultScene() ?? root.listScenes()[0]!).addChild(parent);
      }
      const ibm = document.createAccessor().setType("MAT4").setArray(new Float32Array(IDENTITY)).setBuffer(buffer);
      node.setSkin(document.createSkin(`${spec.parent}-skin`).addJoint(parent).setSkeleton(parent).setInverseBindMatrices(ibm));
      for (const primitive of node.getMesh()!.listPrimitives()) {
        const count = primitive.getAttribute("POSITION")!.getCount();
        const weights = new Float32Array(count * 4);
        for (let index = 0; index < count; index += 1) weights[index * 4] = 1;
        primitive.setAttribute("JOINTS_0", document.createAccessor().setType("VEC4").setArray(new Uint16Array(count * 4)).setBuffer(buffer));
        primitive.setAttribute("WEIGHTS_0", document.createAccessor().setType("VEC4").setArray(weights).setBuffer(buffer));
      }
    }
  }
  // Joint nodes: the first under the parent joint, each next one under the previous.
  const placed: Placed[] = specs.map((spec) => {
    const parent = byName(spec.parent)!;
    const { joints: names, points } = placeChain(document, spec);
    const reference = byName(spec.nodes[0]!)!.getSkin()!;
    const parentBind = ibmOf(reference, parent);
    const joints = names.map((name, k) => {
      if (byName(name)) throw new Error(`secondary chain ${spec.id}: joint ${name} already exists`);
      const joint = document.createNode(name);
      if (k === 0) {
        setLocal(joint, multiply(parentBind, translation(points[0]!)));
        parent.addChild(joint);
      } else {
        const [a, b] = [points[k - 1]!, points[k]!];
        joint.setTranslation([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
      }
      return joint;
    });
    for (let k = 1; k < joints.length; k += 1) joints[k - 1]!.addChild(joints[k]!);
    return { spec, joints, points, names };
  });
  const used = new Set<string>();
  // Skins: append the chain joints; each joint's inverse bind keeps its skinning matrix equal to its parent's at rest.
  const skins = new Set<Skin>();
  for (const { spec } of placed) for (const name of spec.nodes) skins.add(byName(name)!.getSkin()!);
  const skinIndex = new Map<Skin, Map<Node, number>>();
  for (const skin of skins) {
    const matrices: number[] = [];
    const accessor = skin.getInverseBindMatrices();
    skin.listJoints().forEach((joint, index) => matrices.push(...(accessor ? accessor.getElement(index, []) : IDENTITY)));
    for (const { spec, joints, points } of placed) {
      if (!spec.nodes.some((name) => byName(name)!.getSkin() === skin)) continue;
      const parentBind = ibmOf(skin, byName(spec.parent)!);
      const reference = ibmOf(byName(spec.nodes[0]!)!.getSkin()!, byName(spec.parent)!);
      joints.forEach((joint, k) => {
        // Cumulative rest transform of the chain joint relative to the parent: reference × T(point).
        const local = multiply(reference, translation(points[k]!));
        matrices.push(...multiply(invert(local), parentBind));
        skin.addJoint(joint);
      });
    }
    skin.setInverseBindMatrices(document.createAccessor().setType("MAT4").setArray(new Float32Array(matrices)).setBuffer(buffer));
    skinIndex.set(skin, new Map(skin.listJoints().map((joint, index) => [joint, index])));
  }
  // Weights: per vertex, the parent's share moves to the chains of that parent, by affinity and height.
  const nodes = new Set<string>(placed.flatMap(({ spec }) => spec.nodes));
  for (const name of nodes) {
    const node = byName(name)!;
    const skin = node.getSkin()!;
    const indices = skinIndex.get(skin)!;
    const listed = skin.listJoints();
    const chains = placed.filter(({ spec }) => spec.nodes.includes(name));
    for (const primitive of node.getMesh()!.listPrimitives()) {
      const positions = primitive.getAttribute("POSITION")!, jointsIn = primitive.getAttribute("JOINTS_0")!, weightsIn = primitive.getAttribute("WEIGHTS_0")!;
      const count = positions.getCount();
      const jointsOut = new Uint16Array(count * 4), weightsOut = new Float32Array(count * 4);
      const p: number[] = [], j: number[] = [], w: number[] = [];
      for (let vertex = 0; vertex < count; vertex += 1) {
        positions.getElement(vertex, p); jointsIn.getElement(vertex, j); weightsIn.getElement(vertex, w);
        const mix = new Map<Node, number>();
        for (let k = 0; k < 4; k += 1) if (w[k]! > 0) mix.set(listed[j[k]!]!, (mix.get(listed[j[k]!]!) ?? 0) + w[k]!);
        const point = p.slice(0, 3) as Vec3;
        for (const parentName of new Set(chains.map(({ spec }) => spec.parent))) {
          const parent = byName(parentName)!;
          const share = mix.get(parent) ?? 0;
          if (share <= 0) continue;
          const group = chains.filter(({ spec }) => spec.parent === parentName);
          const raw = group.map(({ spec }) => affinity(spec, point) * Math.min(1, Math.max(0, (spec.top - point[1]) / spec.rampLength)));
          const reach = group.map(({ spec }) => affinity(spec, point));
          const total = Math.max(1, reach.reduce((sum, value) => sum + value, 0));
          let candidates: [Node, number][] = [];
          group.forEach(({ joints, points }, c) => {
            const moved = (share * raw[c]!) / total;
            if (moved <= 0) return;
            for (const [k, value] of chainInfluence(points, point[1], moved)) if (value > 0) candidates.push([joints[k]!, value]);
          });
          if (!candidates.length) continue;
          const movedTotal = candidates.reduce((sum, [, value]) => sum + value, 0);
          let residual = share - movedTotal;
          const others = [...mix.keys()].filter((joint) => joint !== parent).length;
          let slots = MAX_INFLUENCES - others - (residual > 1e-6 ? 1 : 0);
          if (slots < 1) {
            // No room: the chain takes the whole share (the same motion at rest).
            residual = 0;
            slots = MAX_INFLUENCES - others;
          }
          candidates.sort((a, b) => b[1] - a[1]);
          const kept = candidates.slice(0, Math.max(1, slots));
          const keptTotal = kept.reduce((sum, [, value]) => sum + value, 0);
          const scale = (share - residual) / keptTotal;
          mix.delete(parent);
          if (residual > 1e-6) mix.set(parent, residual);
          for (const [joint, value] of kept) {
            mix.set(joint, (mix.get(joint) ?? 0) + value * scale);
            used.add(joint.getName());
          }
        }
        const ranked = [...mix.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_INFLUENCES);
        const sum = ranked.reduce((total, [, value]) => total + value, 0);
        ranked.forEach(([joint, value], k) => {
          jointsOut[vertex * 4 + k] = indices.get(joint)!;
          weightsOut[vertex * 4 + k] = value / sum;
        });
      }
      primitive.setAttribute("JOINTS_0", document.createAccessor().setType("VEC4").setArray(jointsOut).setBuffer(buffer));
      primitive.setAttribute("WEIGHTS_0", document.createAccessor().setType("VEC4").setArray(weightsOut).setBuffer(buffer));
    }
  }
  for (const accessor of root.listAccessors()) if (!accessor.listParents().some((parent) => parent !== root)) accessor.dispose();
  return placed.filter(({ names }) => names.some((name) => used.has(name))).map(({ spec, names }) => ({
    id: spec.id, kind: spec.kind, parent: spec.parent, joints: names, swingLimitDegrees: spec.swingLimitDegrees, nodes: spec.nodes,
  }));
}

/** `asset` with the secondary chains added (stored as a new object); returns it and the chains for the descriptor. */
export async function applySecondaryChains(root: string, asset: AssetRef, specs: readonly SecondaryChainSpec[]) {
  const io = new NodeIO().setAllowNetwork(false);
  const document = await io.readBinary(new Uint8Array(await resolveAssetObject(root, asset)));
  const chains = addSecondaryChains(document, specs);
  const bytes = await io.writeBinary(document);
  const glb = (await storeAssetObject(root, { bytes, kind: asset.kind, mediaType: asset.mediaType,
    metadata: { operation: "humanoid-secondary-v1", source: asset.sha256, chains: sha256Bytes(Buffer.from(JSON.stringify(specs))) } })).asset;
  return { glb, chains };
}

/** Ranger accessory chains (#391). Axes are the hips, the chest and the head, measured on the male rest pose. */
const HIPS: [number, number] = [0, -0.04];
const CHEST: [number, number] = [0, -0.02];
const HEAD: [number, number] = [0, -0.02];
const SKIRT_TOP = 0.92;
const SKIRT_SIDES = [["f", 0, 3], ["b", 180, 3], ["l", 90, 2], ["r", 270, 2]] as const;

/** Front, back and side chains from `pelvis` over `nodes` (`sides: false` for front-and-back panels). */
function skirt(nodes: string[], { anchor, sides = true, front = true }: { anchor?: string[]; sides?: boolean; front?: boolean } = {}): SecondaryChainSpec[] {
  return SKIRT_SIDES.filter(([side]) => (sides || side === "f" || side === "b") && (front || side !== "f")).map(([side, direction, count]) => ({
    id: `skirt.${side === "f" ? "front" : side === "b" ? "back" : side === "l" ? "left" : "right"}`, kind: "skirt", parent: "pelvis", prefix: `skirt_${side}`,
    nodes, ...(anchor ? { anchor } : {}), top: SKIRT_TOP, count, direction, axis: HIPS, select: { type: "sector", power: 2 }, rampLength: 0.12, swingLimitDegrees: 20,
  }));
}

function cape(nodes: string[], count: number): SecondaryChainSpec {
  return { id: "cape", kind: "cape", parent: "spine_03", prefix: "cape", nodes, top: 1.4, count, direction: 180, axis: CHEST,
    select: { type: "sector", power: 2 }, rampLength: 0.1, swingLimitDegrees: 25 };
}

/** The chains of each male outfit kit; kits without loose garments have none. */
export const RANGER_OUTFIT_CHAINS: Record<string, SecondaryChainSpec[]> = {
  soldier: skirt(["soldier.gambeson-skirt"]),
  knight: skirt(["knight.tabard"], { sides: false }),
  farmer: skirt(["farmer.smock-skirt"]),
  innkeeper: [{ id: "apron", kind: "apron", parent: "pelvis", prefix: "apron", nodes: ["innkeeper.apron"], top: SKIRT_TOP, count: 2, direction: 0, axis: HIPS,
    select: { type: "sector", power: 2 }, rampLength: 0.1, swingLimitDegrees: 15 }],
  monk: skirt(["monk.habit-skirt"]),
  "class.warden": skirt(["class.warden.tabard"], { sides: false }),
  "class.ranger": [cape(["class.ranger.cloak"], 3)],
  "class.arcanist": [...skirt(["class.arcanist.robe-skirt"]), cape(["class.arcanist.mantle"], 2)],
  "class.necromancer": [...skirt(["class.necromancer.robe-skirt"]), cape(["class.necromancer.mantle"], 2)],
  "class.rogue": [cape(["class.rogue.cape"], 3)],
  "class.cleric": skirt(["class.cleric.robe-skirt", "class.cleric.tabard"], { anchor: ["class.cleric.robe-skirt"] }),
  "class.druid": [...skirt(["class.druid.robe-skirt"]), cape(["class.druid.mantle"], 2)],
  redbrand: [...skirt(["redbrand.coat-skirt"]), { id: "scarf", kind: "strap", parent: "spine_03", prefix: "scarf", nodes: ["redbrand.scarf-end"], top: 1.53, count: 1,
    direction: 0, axis: CHEST, select: { type: "all" }, rampLength: 0.03, swingLimitDegrees: 30 }],
};

/** Hair chains by hair entry: the long back curtain and the tied tail. The scalp stays on `hair_root`. */
export const RANGER_HAIR_CHAINS: Record<string, SecondaryChainSpec[]> = {
  "hair.long": [{ id: "hair.back", kind: "hair", parent: "hair_root", prefix: "hair_back", nodes: ["Hair_Long"], top: 1.7, count: 3, minSegment: 0.05, direction: 180, axis: HEAD,
    select: { type: "sector", power: 2 }, rampLength: 0.05, swingLimitDegrees: 15 }],
  "hair.tied": [{ id: "hair.tail", kind: "hair", parent: "hair_root", prefix: "hair_tail", nodes: ["hair.tied"], top: 1.655, count: 2, minSegment: 0.05, direction: 180, axis: [0, -0.125],
    select: { type: "radius", radius: 0.035 }, rampLength: 0.02, swingLimitDegrees: 25 }],
};

/** Facial hair: one chain below the chin for the long and full beards; the jaw stays on `beard_root`. */
export const RANGER_BEARD_CHAINS: SecondaryChainSpec[] = [{ id: "beard", kind: "beard", parent: "beard_root", prefix: "beard", nodes: ["beard.long", "beard.full"],
  anchor: ["beard.long"], top: 1.57, count: 2, minSegment: 0.08, direction: 0, axis: HEAD, select: { type: "all" }, rampLength: 0.04, swingLimitDegrees: 12 }];
