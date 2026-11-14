// Build the Shooter arena kit (docs/shooter-arena.md, #593) from the scripted recipe adapters/blender/shooter_arena.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-shooter-arena.ts [--textures full|half] --out <directory>
// Modular clean-futuristic arena modules (floors, walls, doorways and doors, cover, platforms, ramps, walkway and
// supports, jump pads, mechanical props and exterior ship-hull surfaces) on one atlas in the robot and weapon kits'
// palette. Each module, variant and level is one external.blender.script@1 run, imported through scene.import.gltf@2.
// The descriptor (arena-kit-descriptor-v1) carries each module's placement box, collision proxies (the Block, Ramp and
// JumpPad pieces Shooter composes its arenas from), the broken variants' proxies under the same placement, LODs and
// the review compositions. Shooter places everything and owns gameplay collision and destruction.
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { NodeIO, type Document } from "@gltf-transform/core";
import { KHRTextureBasisu } from "@gltf-transform/extensions";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec } from "../src/blender-script-spec.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { sha256Bytes } from "../src/hash.js";
import { KIT_LOD_REFERENCE_FOV_Y, buildKitPart, documentBounds, exportKitBundle, ktx2Assets, round, runKitCli, scaledLodDistances, triangles, type KitPart, type Vec3 } from "../src/kit-bundle.js";
import type { AssetRef } from "../src/operations.js";
import { withLightingAttributes } from "./baked-rock-kit.ts";

/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const ARENA_RELEASE = "shooter-arena";
export const ARENA_TAR_NAME = "shooter-arena.kit.tar";
export const ARENA_MATERIAL = "arena-metal";
export const ARENA_DESCRIPTOR_SCHEMA = "arena-kit-descriptor-v1";
export const ARENA_DESCRIPTOR_ATTACHMENT = "arena-descriptor";
/** Full-detail triangle ceilings: modular pieces about 1,000 and props about 2,000 (docs/kit-standard.md). */
export const ARENA_TRIANGLE_BUDGET = { module: 1000, prop: 2000 } as const;
export const ARENA_LOD_DISTANCES = [60] as const;
const VALIDATOR_WARNINGS = ["MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"];

/**
 * The grid every module keeps. Metres in the glTF frame (+Y up, a module's front +Z); Shooter's arena pieces are the
 * same axes in integer centimetres (x 100). Every proxy edge is a whole centimetre, so a module placed on whole
 * centimetres at a yaw of a multiple of 90 degrees gives integer Shooter pieces.
 */
export const ARENA_GRID = {
  cell: 1, module: 2, heightStep: 1, wallThickness: 0.6, wallHeights: [4, 5], coverHeights: [0.8, 1.2, 2],
  rampSlope: { rise: 1, run: 4, degrees: round(Math.atan(0.25) * 180 / Math.PI) }, hullModule: 4, hullShoulderDegrees: 45,
} as const;

export type Tag = "walkable" | "blocked" | "trigger";
export type Rises = "+X" | "-X" | "+Z" | "-Z";
export type Proxy = { name: string; tag: Tag; shape: "box" | "ramp"; center: Vec3; size: Vec3; rises?: Rises };
export type Category = "surface" | "wall" | "door" | "cover" | "platform" | "ramp" | "jump-pad" | "prop" | "hull";
export type Module = {
  key: string; category: Category; kind: "module" | "prop"; box: { min: Vec3; max: Vec3 }; origin: "base-center" | "top-center";
  proxies: Proxy[]; broken?: Proxy[]; note: string; extras?: Record<string, unknown>;
};

const box = (name: string, tag: Tag, min: Vec3, max: Vec3): Proxy =>
  ({ name, tag, shape: "box", center: [0, 1, 2].map((k) => round((min[k]! + max[k]!) / 2)) as Vec3, size: [0, 1, 2].map((k) => round(max[k]! - min[k]!)) as Vec3 });
const wedge = (name: string, min: Vec3, max: Vec3, rises: Rises): Proxy => ({ ...box(name, "walkable", min, max), shape: "ramp", rises });
const whole = (key: string, category: Category, min: Vec3, max: Vec3, tag: Tag, note: string, extra: Partial<Module> = {}): Module =>
  ({ key, category, kind: "module", box: { min, max }, origin: "base-center", proxies: [box(category === "hull" ? "hull" : key.split(".")[1]!, tag, min, max)], note, ...extra });
const T = 0.3;

/** Every module: its placement box (the recipe's BOXES), origin, collision proxies and broken-variant proxies. */
export const ARENA_MODULES: readonly Module[] = [
  whole("arena.floor", "surface", [-1, -0.1, -1], [1, 0, 1], "walkable", "A 2 x 2 m floor plate laid on the arena floor: its top is y = 0.", { origin: "top-center" }),
  whole("arena.ceiling", "surface", [-1, 0, -1], [1, 0.2, 1], "blocked", "A 2 x 2 m ceiling panel, 20 cm thick, with light strips underneath; its origin is the centre of its underside."),
  whole("arena.wall", "wall", [-1, 0, -T], [1, 4, T], "blocked", "A 2 m wall module, 4 m high, 60 cm thick, finished the same on both faces."),
  whole("arena.wall-half", "wall", [-0.5, 0, -T], [0.5, 4, T], "blocked", "A 1 m wall filler, 4 m high."),
  whole("arena.wall-tall", "wall", [-1, 0, -T], [1, 5, T], "blocked", "A 2 m wall module, 5 m high (perimeters and wall lines)."),
  whole("arena.wall-corner", "wall", [-T, 0, -T], [T, 4, T], "blocked", "A 60 cm corner, end or junction post for 4 m walls: fills the square where walls meet."),
  whole("arena.wall-corner-tall", "wall", [-T, 0, -T], [T, 5, T], "blocked", "The corner post for 5 m walls."),
  {
    key: "arena.doorway", category: "wall", kind: "module", box: { min: [-2, 0, -T], max: [2, 4, T] }, origin: "base-center",
    proxies: [box("left-jamb", "blocked", [-2, 0, -T], [-1, 4, T]), box("right-jamb", "blocked", [1, 0, -T], [2, 4, T]), box("lintel", "blocked", [-1, 3, -T], [1, 4, T])],
    note: "A 4 m wall module, 4 m high, with a 2 x 3 m opening: nothing reaches into the opening.",
    extras: { doorway: { center: [0, 1.5, 0], width: 2, height: 3, depth: 0.6, min: [-1, 0, -T], max: [1, 3, T] }, mount: { key: "arena.door", translation: [0, 0, 0] } },
  },
  {
    key: "arena.door", category: "door", kind: "module", box: { min: [-1.05, 0, -0.07], max: [1.05, 3.05, 0.07] }, origin: "base-center",
    proxies: [box("leaf-left", "blocked", [-1, 0, -0.07], [0, 3, 0.07]), box("leaf-right", "blocked", [0, 0, -0.07], [1, 3, 0.07])],
    broken: [
      box("leaf-left.outer", "blocked", [-1, 0, -0.07], [-0.56, 3, 0.07]), box("leaf-left.lower", "blocked", [-0.56, 0, -0.07], [0, 0.8, 0.07]), box("leaf-left.upper", "blocked", [-0.56, 2.4, -0.07], [0, 3, 0.07]),
      box("leaf-right.outer", "blocked", [0.56, 0, -0.07], [1, 3, 0.07]), box("leaf-right.lower", "blocked", [0, 0, -0.07], [0.56, 0.8, 0.07]), box("leaf-right.upper", "blocked", [0, 2.4, -0.07], [0.56, 3, 0.07]),
    ],
    note: "Two sliding leaves (nodes leaf-left and leaf-right) for the doorway's opening, mounted at the doorway's origin. Each laps 5 cm into its jamb and the lintel; the proxies cover the opening only. Broken: a blast hole across the meeting seam.",
    extras: { open: { "leaf-left": [-0.95, 0, 0], "leaf-right": [0.95, 0, 0] } },
  },
  {
    ...whole("arena.cover-low", "cover", [-1, 0, -T], [1, 1.2, T], "blocked", "Low cover, 1.2 m: a 2 m barrier with a chamfered top. Broken: a 60 cm stub stands at its -x end; the rest is torn down to 56 cm."),
    broken: [box("stub", "blocked", [-1, 0, -T], [-0.4, 1.2, T]), box("base", "blocked", [-0.4, 0, -T], [1, 0.56, T])],
  },
  {
    ...whole("arena.barrier", "cover", [-1, 0, -T], [1, 2, T], "blocked", "High cover, 2 m: a robot cannot see over it. Broken: a 50 cm stub stands at its +x end; the rest is torn down to 1 m."),
    broken: [box("stub", "blocked", [0.5, 0, -T], [1, 2, T]), box("base", "blocked", [-1, 0, -T], [0.5, 1, T])],
  },
  {
    ...whole("arena.crate", "cover", [-0.4, 0, -0.4], [0.4, 0.8, 0.4], "walkable", "An 80 cm crate; crates stack. Broken: lid gone, sides torn to 46 cm."),
    broken: [box("base", "blocked", [-0.4, 0, -0.4], [0.4, 0.46, 0.4])],
  },
  whole("arena.platform", "platform", [-1, 0, -1], [1, 2, 1], "walkable", "A 2 x 2 x 2 m platform block: blocks side by side make a platform, stacked a tower."),
  whole("arena.platform-half", "platform", [-1, 0, -1], [1, 1, 1], "walkable", "A 1 m platform block, for odd heights (3, 5, 7 m)."),
  {
    key: "arena.ramp", category: "ramp", kind: "module", box: { min: [-1, 0, -4], max: [1, 2, 4] }, origin: "base-center",
    proxies: [wedge("ramp", [-1, 0, -4], [1, 2, 4], "-Z")], note: "A 2 m wide ramp, 8 m long, rising 2 m toward -Z (1:4, 14 degrees): onto a 2 m platform.",
  },
  {
    key: "arena.ramp-tall", category: "ramp", kind: "module", box: { min: [-1, 0, -6], max: [1, 3, 6] }, origin: "base-center",
    proxies: [wedge("ramp", [-1, 0, -6], [1, 3, 6], "-Z")], note: "A 2 m wide ramp, 12 m long, rising 3 m toward -Z (1:4): onto the 3 m walkway.",
  },
  whole("arena.walkway", "platform", [-1, 0, -2], [1, 0.4, 2], "walkable", "A 2 m section of a 4 m wide, 40 cm walkway deck (along x), with lit fascias."),
  whole("arena.support", "platform", [-0.5, 0, -0.5], [0.5, 2.6, 0.5], "blocked", "A 1 m walkway support, 2.6 m: the deck sits on it at 2.6 m (top 3 m)."),
  whole("arena.pillar", "platform", [-0.6, 0, -0.6], [0.6, 4, 0.6], "blocked", "A 1.2 m pillar, 4 m high."),
  {
    key: "arena.jump-pad", category: "jump-pad", kind: "module", box: { min: [-0.8, -0.05, -0.8], max: [0.8, 0.02, 0.8] }, origin: "top-center",
    proxies: [box("pad", "trigger", [-0.8, -0.1, -0.8], [0.8, 0.1, 0.8])],
    note: "A 1.6 m jump pad flush with the floor (its top 2 cm up): no collider, only its footprint. Its origin is Shooter's JumpPad center; Shooter owns the launch.",
  },
  { ...whole("arena.container", "prop", [-4, 0, -1.5], [4, 2, 1.5], "walkable", "An 8 x 3 m cargo container, 2 m high."), kind: "prop" },
  { ...whole("arena.generator", "prop", [-1, 0, -0.6], [1, 1.6, 0.6], "blocked", "A power unit on a skid, 1.6 m."), kind: "prop" },
  { ...whole("arena.pipes", "prop", [-1, 0, -0.25], [1, 1.2, 0.25], "blocked", "A 2 m run of two pipes on brackets; its back (-z) goes against a wall face."), kind: "prop" },
  whole("arena.hull-deck", "hull", [-2, 0, -2], [2, 0.5, 2], "walkable", "A 4 x 4 m hull deck plate, 50 cm thick: the walking surface on top of a hull section."),
  {
    key: "arena.hull-shoulder", category: "hull", kind: "module", box: { min: [-2, 0, -1], max: [2, 2, 1] }, origin: "base-center",
    proxies: [wedge("hull", [-2, 0, -1], [2, 2, 1], "-Z")], note: "The 45 degree chamfer, 4 m long, from a hull deck's edge (its high side, -z, 2 m up) down to the side plating.",
  },
  whole("arena.hull-side", "hull", [-2, 0, -0.25], [2, 2, 0.25], "blocked", "A 4 x 2 m hull side plate, 50 cm thick; plates stack in 2 m courses and close a section's ends."),
  whole("arena.hull-rib", "hull", [-2, 0, -T], [2, 0.8, T], "blocked", "A 4 m structural frame band across a deck, 80 cm: low cover."),
  {
    key: "arena.hull-mast", category: "hull", kind: "module", box: { min: [-0.5, 0, -0.5], max: [0.5, 3, 0.5] }, origin: "base-center",
    proxies: [box("foot", "blocked", [-0.5, 0, -0.5], [0.5, 0.3, 0.5]), box("mast", "blocked", [-0.3, 0.3, -0.3], [0.3, 3, 0.3])],
    note: "A 3 m sensor mast with a grapple ring near its top.", extras: { anchors: [{ name: "grapple", kind: "grapple-point", position: [0, 2.66, 0] }] },
  },
];

export const ARENA_KEYS = ARENA_MODULES.map((module) => module.key);
export const moduleOf = (key: string) => {
  const module = ARENA_MODULES.find((candidate) => candidate.key === key);
  if (!module) throw new Error(`unknown arena module ${key}`);
  return module;
};
export const variantsOf = (module: Module) => (module.broken ? ["default", "broken"] as const : ["default"] as const);
export const bundleVariant = (variant: string, level: number) => level === 0 ? variant : variant === "default" ? `lod${level}` : `${variant}-lod${level}`;

export function createArenaSpec({ key, variant, level, scriptSha256, commonSha256, robotSha256, blenderVersion }: {
  key: string; variant: string; level: number; scriptSha256: string; commonSha256: string; robotSha256: string; blenderVersion: string;
}) {
  return blenderScriptSpec({
    assetId: key,
    inputs: { script: { path: "shooter_arena.py", sha256: scriptSha256 }, common: { path: "kit_common.py", sha256: commonSha256 }, robot: { path: "combat_robot.py", sha256: robotSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, part: key, variant, level }, output: "arena.glb",
  });
}

// ---------------------------------------------------------------- placement and Shooter pieces

export type Yaw = 0 | 90 | 180 | 270;
export type Item = { key: string; variant?: "default" | "broken"; translation: Vec3; yawDegrees?: Yaw };

/** A module-frame point turned by `yaw` degrees about +Y (counter-clockwise seen from above), then moved. */
export function place(point: readonly number[], yaw: Yaw, translation: readonly number[]): Vec3 {
  const a = (yaw * Math.PI) / 180, c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
  return [round(point[0]! * c + point[2]! * s + translation[0]!), round(point[1]! + translation[1]!), round(-point[0]! * s + point[2]! * c + translation[2]!)];
}
const RISES: Record<Rises, Vec3> = { "+X": [1, 0, 0], "-X": [-1, 0, 0], "+Z": [0, 0, 1], "-Z": [0, 0, -1] };
export function turnRises(rises: Rises, yaw: Yaw): Rises {
  const v = place(RISES[rises], yaw, [0, 0, 0]);
  return (Object.entries(RISES).find(([, w]) => w.every((c, k) => c === v[k]))![0]) as Rises;
}

export type WorldProxy = Proxy & { item: number; min: Vec3; max: Vec3 };

/** Every collision proxy of a composition in world space (axis-aligned: yaws are multiples of 90 degrees). */
export function worldProxies(items: readonly Item[]): WorldProxy[] {
  return items.flatMap((item, index) => {
    const module = moduleOf(item.key);
    const proxies = item.variant === "broken" ? module.broken! : module.proxies;
    const yaw = item.yawDegrees ?? 0;
    return proxies.map((proxy) => {
      const a = place(proxy.center.map((c, k) => c - proxy.size[k]! / 2), yaw, item.translation);
      const b = place(proxy.center.map((c, k) => c + proxy.size[k]! / 2), yaw, item.translation);
      const min = [0, 1, 2].map((k) => Math.min(a[k]!, b[k]!)) as Vec3, max = [0, 1, 2].map((k) => Math.max(a[k]!, b[k]!)) as Vec3;
      return {
        ...proxy, item: index, min, max, center: [0, 1, 2].map((k) => round((min[k]! + max[k]!) / 2)) as Vec3, size: [0, 1, 2].map((k) => round(max[k]! - min[k]!)) as Vec3,
        ...(proxy.rises ? { rises: turnRises(proxy.rises, yaw) } : {}),
      };
    });
  });
}

const RAMP_RISE: Record<Rises, string> = { "+X": "PosX", "-X": "NegX", "+Z": "PosZ", "-Z": "NegZ" };
const cm = (v: number) => {
  const c = Math.round(v * 100);
  if (Math.abs(c - v * 100) > 1e-6) throw new Error(`${v} m is not a whole centimetre`);
  return c === 0 ? 0 : c;
};

/**
 * A composition as Shooter's arena pieces (crates/shooter-sim/src/arena.rs, integer centimetres): a walkable or blocked
 * box is a `Block { center, half }`, a ramp a `Ramp { center, half, rises }`, a trigger a `JumpPad` footprint (its
 * center the pad's top, half on x and z). Shooter decides which it builds.
 */
export function shooterPieces(items: readonly Item[]) {
  return worldProxies(items).map((p) => {
    const center = p.center.map(cm), half = p.size.map((s) => cm(s / 2));
    if (p.tag === "trigger") return { piece: "JumpPad" as const, center, half: [half[0]!, half[2]!] };
    if (p.shape === "ramp") return { piece: "Ramp" as const, center, half, rises: RAMP_RISE[p.rises!] };
    return { piece: "Block" as const, center, half, tag: p.tag };
  });
}

// ---------------------------------------------------------------- review compositions

const item = (key: string, translation: Vec3, yawDegrees: Yaw = 0, variant?: "broken"): Item => ({ key, translation, ...(yawDegrees ? { yawDegrees } : {}), ...(variant ? { variant } : {}) });

/** Floor plates over x0..x1, z0..z1 (whole 2 m modules). */
function floor(x0: number, x1: number, z0: number, z1: number, skip: (x: number, z: number) => boolean = () => false): Item[] {
  const out: Item[] = [];
  for (let x = x0 + 1; x < x1; x += 2) for (let z = z0 + 1; z < z1; z += 2) if (!skip(x, z)) out.push(item("arena.floor", [x, 0, z]));
  return out;
}

/** A straight wall from a to b along x (yaw 0) or z (yaw 90), its centre line at `at`, in 2 m modules and a 1 m filler. */
function wallRun(axis: "x" | "z", a: number, b: number, at: number, tall = false): Item[] {
  const out: Item[] = [];
  let p = a;
  while (b - p >= 2) {
    out.push(item(tall ? "arena.wall-tall" : "arena.wall", axis === "x" ? [p + 1, 0, at] : [at, 0, p + 1], axis === "x" ? 0 : 90));
    p += 2;
  }
  if (b - p >= 1) out.push(item("arena.wall-half", axis === "x" ? [p + 0.5, 0, at] : [at, 0, p + 0.5], axis === "x" ? 0 : 90));
  return out;
}

/**
 * The review builds: connected configurations of every module, each a different sightline and height arrangement, and
 * one exterior hull section. Translations are metres in the composition's frame, yaws about +Y.
 */
export const ARENA_COMPOSITIONS: Readonly<Record<string, { note: string; items: Item[] }>> = {
  yard: {
    note: "Ground level: a 20 x 16 m yard closed by 4 m and 5 m walls with corner posts and a doorway, a long lane broken by low cover, a barrier, crate stacks, a container, a generator and pipes, a pillar and a jump pad.",
    items: [
      ...floor(-10, 10, -8, 8, (x, z) => x === 5 && z === 3),
      item("arena.jump-pad", [5, 0, 3]),
      ...wallRun("x", -10, -2, -8.3, true), item("arena.doorway", [0, 0, -8.3]), ...wallRun("x", 2, 10, -8.3, true),
      item("arena.wall-corner-tall", [-10.3, 0, -8.3]), item("arena.wall-corner-tall", [10.3, 0, -8.3]),
      ...wallRun("z", -8, 8, -10.3), ...wallRun("z", -8, 7, 10.3), item("arena.wall-corner", [10.3, 0, 7.3]),
      item("arena.door", [0, 0, -8.3]),
      item("arena.cover-low", [-5, 0, 2]), item("arena.cover-low", [-3, 0, 2]), item("arena.barrier", [3, 0, -2], 90),
      item("arena.crate", [-7, 0, -4]), item("arena.crate", [-6.2, 0, -4]), item("arena.crate", [-7, 0.8, -4]),
      item("arena.container", [5, 0, -5.5]), item("arena.generator", [-8, 0, 5.5], 90), item("arena.pipes", [-1, 1.4, -7.75]), item("arena.pipes", [-5, 1.4, -7.75]),
      item("arena.pillar", [0, 0, 4]),
    ],
  },
  heights: {
    note: "Height: a 6 x 4 m platform with a ramp onto it, a 3 m walkway on supports with its 12 m ramp, a 7 m tower of platform blocks, and a 4 x 4 m shed of walls under a ceiling.",
    items: [
      ...floor(-14, 14, -10, 10, (x, z) => x === 11 && z === -3),
      ...[-5, -3, -1].flatMap((x) => [-7, -5].map((z) => item("arena.platform", [x, 0, z]))),
      item("arena.ramp", [-5, 0, 0]), item("arena.ramp", [-3, 0, 0]),
      ...[2, 4, 6, 8].map((x) => item("arena.walkway", [x, 2.6, 6])), item("arena.support", [3, 0, 6]), item("arena.support", [7, 0, 6]),
      item("arena.ramp-tall", [-5, 0, 5], 270), item("arena.ramp-tall", [-5, 0, 7], 270),
      item("arena.platform", [11, 0, -7]), item("arena.platform", [11, 2, -7]), item("arena.platform", [11, 4, -7]), item("arena.platform-half", [11, 6, -7]),
      item("arena.jump-pad", [11, 0, -3]),
      ...wallRun("x", 4, 8, -8.3), item("arena.doorway", [6, 0, -3.7], 180), item("arena.door", [6, 0, -3.7], 180),
      ...wallRun("z", -8, -4, 3.7), ...wallRun("z", -8, -4, 8.3),
      item("arena.wall-corner", [3.7, 0, -8.3]), item("arena.wall-corner", [8.3, 0, -8.3]), item("arena.wall-corner", [3.7, 0, -3.7]), item("arena.wall-corner", [8.3, 0, -3.7]),
      ...[5, 7].flatMap((x) => [-7, -5].map((z) => item("arena.ceiling", [x, 3.8, z]))),
      item("arena.crate", [12, 0, 7]), item("arena.cover-low", [10, 0, 6], 90),
    ],
  },
  cover: {
    note: "Destruction: each destructible piece intact beside its broken variant at the same placement in a twin lane, and a doorway with its door intact and broken.",
    items: [
      ...floor(-10, 10, -6, 6),
      item("arena.cover-low", [-6, 0, -2]), item("arena.cover-low", [-6, 0, 2], 0, "broken"),
      item("arena.barrier", [-2, 0, -2]), item("arena.barrier", [-2, 0, 2], 0, "broken"),
      item("arena.crate", [2, 0, -2]), item("arena.crate", [2, 0, 2], 0, "broken"), item("arena.crate", [2.8, 0, -2]), item("arena.crate", [2.8, 0, 2], 0, "broken"),
      item("arena.doorway", [6, 0, -2], 90), item("arena.door", [6, 0, -2], 90), item("arena.doorway", [6, 0, 2], 90), item("arena.door", [6, 0, 2], 90, "broken"),
      ...wallRun("x", -10, 10, -6.3), item("arena.wall-half", [6, 0, 4.5], 90), item("arena.wall-half", [6, 0, -4.5], 90),
    ],
  },
  hull: {
    note: "Shipyard: a 12 m exterior hull section, 8 m wide and 6 m high, of side plates, 45 degree shoulders and deck plates with frame ribs and a grapple mast, its ends closed by side plates, on a drydock floor.",
    items: [
      ...floor(-10, 10, -8, 8),
      ...[-4, 0, 4].flatMap((x) => [
        item("arena.hull-side", [x, 0, 3.75]), item("arena.hull-side", [x, 2, 3.75]), item("arena.hull-side", [x, 0, -3.75], 180), item("arena.hull-side", [x, 2, -3.75], 180),
        item("arena.hull-shoulder", [x, 4, 3]), item("arena.hull-shoulder", [x, 4, -3], 180), item("arena.hull-deck", [x, 5.5, 0]),
      ]),
      ...[-6.25, 6.25].flatMap((x) => [
        item("arena.hull-side", [x, 0, -2], x < 0 ? 270 : 90), item("arena.hull-side", [x, 0, 2], x < 0 ? 270 : 90),
        item("arena.hull-side", [x, 2, -2], x < 0 ? 270 : 90), item("arena.hull-side", [x, 2, 2], x < 0 ? 270 : 90),
        item("arena.hull-side", [x, 4, 0], x < 0 ? 270 : 90),
      ]),
      item("arena.hull-rib", [-2, 6, 0], 90), item("arena.hull-rib", [2, 6, 0], 90), item("arena.hull-mast", [4.5, 6, 0]),
      item("arena.crate", [-6, 0, 6]), item("arena.cover-low", [7, 0, 6]),
    ],
  },
};

// ---------------------------------------------------------------- build

type Built = KitPart & { key: string; variant: string; level: number };

export async function buildShooterArena({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("shooter_arena.py");
  const common = await readBlenderRecipeSource("kit_common.py");
  const robot = await readBlenderRecipeSource("combat_robot.py");
  const built: Built[] = [];
  for (const module of ARENA_MODULES) for (const variant of variantsOf(module)) for (const level of [0, 1]) {
    log(`generate ${module.key} ${bundleVariant(variant, level)}`);
    built.push({ key: module.key, variant, level, ...await buildKitPart(root, {
      workspace: path.join(root, "parts", `${module.key}.${bundleVariant(variant, level)}`), allowedValidatorWarnings: VALIDATOR_WARNINGS,
      files: { "shooter_arena.py": source.bytes, "kit_common.py": common.bytes, "combat_robot.py": robot.bytes },
      spec: createArenaSpec({ key: module.key, variant, level, scriptSha256: source.sha256, commonSha256: common.sha256, robotSha256: robot.sha256, blenderVersion: source.blenderVersion }),
    }) });
  }
  // A level only ships when it at least halves the full detail (docs/kit-standard.md).
  const full = (b: Built) => built.find((c) => c.key === b.key && c.variant === b.variant && c.level === 0)!;
  const shipped = built.filter((b) => b.level === 0 || triangles(b.document) * 2 <= triangles(full(b).document));

  log("add tangents and COLOR_0");
  const io = new NodeIO().registerExtensions([KHRTextureBasisu]);
  const finished: AssetRef[] = [];
  const atlas = new Map<string, string>();
  for (const part of shipped) {
    for (const texture of part.document.getRoot().listTextures()) {
      const sha = sha256Bytes(texture.getImage()!);
      if ((atlas.get(texture.getName()) ?? sha) !== sha) throw new Error(`${part.key}: texture '${texture.getName()}' differs from the shared atlas`);
      atlas.set(texture.getName(), sha);
    }
    await withLightingAttributes(part.document);
    finished.push((await storeAssetObject(root, { bytes: await io.writeBinary(part.document), kind: "scene", mediaType: "model/gltf-binary" })).asset);
  }

  log("measure the descriptor");
  const tan = Math.tan((KIT_LOD_REFERENCE_FOV_Y / 2) * Math.PI / 180);
  const lodsOf = (levels: Built[]) => {
    const bounds = documentBounds(levels[0]!.document);
    const radius = round(Math.hypot(...[0, 1, 2].map((k) => bounds.max[k]! - bounds.min[k]!)) / 2);
    const distances = scaledLodDistances(ARENA_LOD_DISTANCES, bounds);
    return {
      boundingSphere: { center: [0, 1, 2].map((k) => round((bounds.min[k]! + bounds.max[k]!) / 2)), radius },
      levels: levels.map((level, index) => {
        const distance = index < levels.length - 1 ? distances[index] : undefined;
        return { variant: bundleVariant(level.variant, level.level), triangles: triangles(level.document), minScreenSize: distance ? round(Number((radius / (distance * tan)).toFixed(4))) : 0, referenceMaxDistance: distance ?? null };
      }),
    };
  };
  const levelsOf = (key: string, variant: string) => shipped.filter((b) => b.key === key && b.variant === variant).sort((a, b) => a.level - b.level);
  const assets = ARENA_MODULES.map((module) => {
    const levels = levelsOf(module.key, "default");
    const document = levels[0]!.document;
    const nodes = document.getRoot().listNodes().filter((node) => node.getMesh()).map((node) => node.getName()).sort();
    return {
      key: module.key, category: module.category, kind: module.kind, origin: module.origin, note: module.note,
      box: module.box, size: [0, 1, 2].map((k) => round(module.box.max[k]! - module.box.min[k]!)),
      bounds: documentBounds(document), triangles: triangles(document), nodes,
      collisionProxies: module.proxies, lods: lodsOf(levels),
      variants: Object.fromEntries(variantsOf(module).map((variant) => {
        const own = levelsOf(module.key, variant);
        return [variant, { bundleVariant: variant, collisionProxies: variant === "broken" ? module.broken! : module.proxies, triangles: triangles(own[0]!.document), bounds: documentBounds(own[0]!.document), lods: lodsOf(own) }];
      })),
      ...(module.extras ?? {}),
    };
  });
  const descriptor = {
    schema: ARENA_DESCRIPTOR_SCHEMA, kit: ARENA_RELEASE, units: "metre", up: "+Y", facing: "+Z", handedness: "right",
    origin: "A module's origin is the centre of the base of its placement box (`box`), except `top-center` modules (floor, jump pad), whose origin is the centre of its top, on the arena floor.",
    grid: ARENA_GRID,
    placement: "Place a module by a translation (metres) and a yaw about +Y of 0, 90, 180 or 270 degrees, counter-clockwise seen from above (+90 turns +Z to +X). Modules are designed for translations on whole centimetres; on the 1 m grid they meet face to face. No vertex leaves a module's placement box.",
    collision: "collisionProxies are axis-aligned in the module's frame (metres): `box` with tag `walkable` (a top to stand on) or `blocked` (solid) is Shooter's Block { center, half }; `ramp` is Shooter's Ramp, a wedge filling the lower half of its box with its top rising toward `rises`; `trigger` is a jump pad's footprint (Shooter's JumpPad, no collider). In Shooter's integer centimetres: center x 100, half = size x 50; a yaw turns centres, swaps x and z half extents at 90 and 270 degrees and turns `rises`. A broken variant keeps its module's key, box, origin and placement; its proxies (variants.broken) lie inside the intact ones.",
    destruction: "Shooter owns when a destructible piece breaks, debris and the collision that follows; it swaps the intact variant (`default`) for `broken` at the same placement and may use variants.broken.collisionProxies.",
    authority: "Shooter owns arena layouts, map selection, placement, gameplay collision (it may use, replace or ignore these proxies), jump-pad launches, door opening, grapple targets and destruction. The proxies, door slides and the mast's grapple anchor are metadata only.",
    lodSelection: {
      metric: "projected-bounding-sphere-height-fraction", referenceFovYDegrees: KIT_LOD_REFERENCE_FOV_Y,
      rule: "Use the first level whose minScreenSize is at most the asset's projected bounding-sphere diameter divided by the viewport height (radius / (distance * tan(fovY / 2)), scaled by the instance scale). referenceMaxDistance is the distance in metres at which that level ends for an unscaled instance at referenceFovYDegrees. A module whose lod1 would not halve its triangles ships no lod1.",
    },
    material: { name: ARENA_MATERIAL, note: "One opaque material on one atlas (colour, normal, ORM, emissive) for every module, level and variant." },
    assets,
    compositions: Object.entries(ARENA_COMPOSITIONS).map(([name, { note, items }]) => ({ name, note, items })),
    sources: "Original geometry and procedurally painted textures from the recipe (adapters/blender/shooter_arena.py, with the robot kit's palette and painters from adapters/blender/combat_robot.py); no third-party assets.",
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: ARENA_DESCRIPTOR_ATTACHMENT, mediaType: "application/json" })).asset;

  log("encode the atlas as KTX2 (ktx create)");
  const delivered = await ktx2Assets(root, ARENA_RELEASE, finished);
  const selections = shipped.map((part, index) => ({ key: part.key, variant: bundleVariant(part.variant, part.level), ...(index === 0 ? { attachments: [{ name: ARENA_DESCRIPTOR_ATTACHMENT }] } : {}) }));
  const packed = await exportKitBundle(root, {
    tarName: ARENA_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(shipped.map((part) => [`${part.key}#${bundleVariant(part.variant, part.level)}`, part.document])) as Record<string, Document>,
    lineage: {
      recipe: {
        script: "adapters/blender/shooter_arena.py", sha256: source.sha256, common: { script: "adapters/blender/kit_common.py", sha256: common.sha256 },
        robot: { script: "adapters/blender/combat_robot.py", sha256: robot.sha256 }, blenderVersion: source.blenderVersion,
      },
      release: ARENA_RELEASE, descriptor: descriptorAsset,
    },
  };
}

if (import.meta.main) await runKitCli("scripts/build-shooter-arena.ts", ARENA_RELEASE, buildShooterArena, { descriptorFile: true });
