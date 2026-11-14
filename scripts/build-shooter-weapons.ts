// Build the Shooter weapon kit (docs/shooter-weapons.md, #594) from the scripted recipe adapters/blender/shooter_weapons.py,
// the companion of the robot part kit (scripts/build-combat-robot.ts, #595) on the same socket-grid convention:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-shooter-weapons.ts [--textures full|half] --out <directory>
// Each weapon's and mod's level is one external.blender.script@1 run, imported through scene.import.gltf@2, all on one
// atlas. The descriptor (socket-grid-kit-descriptor-v2) carries the anchors, emissive channels, states and the review
// loadouts on the robot kit's parts. No game places the kit yet.
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
import { KIT_LOD_REFERENCE_FOV_Y, buildKitPart, documentBounds, exportKitBundle, ktx2Assets, round, runKitCli, scaledLodDistances, triangles, type KitPart } from "../src/kit-bundle.js";
import type { AssetRef } from "../src/operations.js";
import {
  IDENTITY, IDENTITY_TRANSFORM, SOCKET_FACES, compose, faceFrame, mountTransform, partCuboid, partSockets, partToGltf, quaternion,
  type Face, type Orientation, type Transform, type Vec3,
} from "../src/socket-grid.ts";
import { withLightingAttributes } from "./baked-rock-kit.ts";
import { PLACEHOLDER_PARTS, ROBOT_COMPOSITIONS, ROBOT_PARTS, ROBOT_RELEASE, socketGridConvention, type RobotAnchor, type RobotJoint } from "./build-combat-robot.ts";

/** One rolling release (Atlas Decision 7.1.5), never numbered: separate from the robot kit, which is at its 2 MB budget. */
export const WEAPONS_RELEASE = "shooter-weapons";
export const WEAPONS_TAR_NAME = "shooter-weapons.kit.tar";
export const WEAPONS_MATERIAL = "weapon-metal";
export const WEAPONS_DESCRIPTOR_SCHEMA = "socket-grid-kit-descriptor-v2";
export const WEAPONS_DESCRIPTOR_ATTACHMENT = "socket-grid-descriptor";
/** Full-detail triangle ceiling per weapon, as for the robot parts. */
export const WEAPONS_TRIANGLE_BUDGET = 2000;
export const WEAPONS_LOD_DISTANCES = [60, 180] as const;
const VALIDATOR_WARNINGS = ["MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"];
const LEVELS = [0, 1, 2] as const;

export type WeaponPart = { key: string; kind: "weapon"; cells: [number, number, number]; tint: Vec3 };

/**
 * The weapons, exactly as Shooter's catalog declares them (crates/shooter-sim/src/robot.rs `parts::weapon`: a light
 * weapon is 1 x 1 x 2 cells, the rail gun and the rocket launcher 1 x 2 x 2, no sockets), with Shooter's energy colour
 * (crates/shooter-client/src/effects.rs `tint`, linear), which their glow uses.
 */
export const WEAPON_PARTS: readonly WeaponPart[] = [
  { key: "weapon.energy-rifle", kind: "weapon", cells: [1, 1, 2], tint: [0.25, 0.8, 1.0] },
  { key: "weapon.shotgun", kind: "weapon", cells: [1, 1, 2], tint: [1.0, 0.85, 0.3] },
  { key: "weapon.laser", kind: "weapon", cells: [1, 1, 2], tint: [1.0, 0.15, 0.1] },
  { key: "weapon.flamethrower", kind: "weapon", cells: [1, 1, 2], tint: [1.0, 0.4, 0.05] },
  { key: "weapon.grapple-hook", kind: "weapon", cells: [1, 1, 2], tint: [0.45, 1.0, 0.55] },
  { key: "weapon.energy-blade", kind: "weapon", cells: [1, 1, 2], tint: [1.0, 0.25, 0.6] },
  { key: "weapon.rail-gun", kind: "weapon", cells: [1, 2, 2], tint: [0.75, 0.35, 1.0] },
  { key: "weapon.rocket-launcher", kind: "weapon", cells: [1, 2, 2], tint: [1.0, 0.55, 0.15] },
];

/** The mod anchor kinds: a side mod sits on the weapon's -x rail, the long barrel on its muzzle. */
export type ModMount = "mod-side" | "mod-muzzle";

/**
 * The weapon mods, by Shooter's catalog (robot.rs `BETA.mods`): which anchor each sits on, and (for reference) the
 * weapons Shooter lets it fit today. Shooter decides fits; a weapon carries an anchor for every mod that fits it. Code 4,
 * the heat sink, is retired and not built.
 */
export const WEAPON_MODS: readonly { key: string; mount: ModMount; fits: readonly string[]; envelope: { min: Vec3; max: Vec3 } }[] = [
  { key: "mod.rapid-cycler", mount: "mod-side", fits: ["weapon.energy-rifle", "weapon.rail-gun", "weapon.shotgun"], envelope: sideEnvelope() },
  { key: "mod.overcharger", mount: "mod-side", fits: ["weapon.energy-rifle", "weapon.rail-gun", "weapon.shotgun"], envelope: sideEnvelope() },
  { key: "mod.long-barrel", mount: "mod-muzzle", fits: ["weapon.energy-rifle", "weapon.rail-gun", "weapon.laser"], envelope: { min: [-0.03, 0, -0.03], max: [0.03, 0.09, 0.03] } },
  { key: "mod.efficiency-coil", mount: "mod-side", fits: ["weapon.energy-rifle", "weapon.rail-gun", "weapon.rocket-launcher", "weapon.shotgun"], envelope: sideEnvelope() },
];

/** The room a side mod has in its own glTF frame: 7 cm across, 12 cm along the barrel, 5 cm out of the rail. */
function sideEnvelope(): { min: Vec3; max: Vec3 } {
  return { min: [-0.035, 0, -0.06], max: [0.035, 0.05, 0.06] };
}

export type Channel = { name: string; node: string; kind: "emissive"; colour: Vec3; meaning: string };
export type State = { name: string; animation: string; loop: boolean; seconds: number; use: string; nodes: string[] };

const FORWARD: Vec3 = [0, 1, 0]; // a weapon's +z: out of its socket
const UP: Vec3 = [0, 0, -1]; // a weapon's +y
const anchor = (name: string, kind: string, position: Vec3, node?: string, normal: Vec3 = FORWARD, up: Vec3 = UP): RobotAnchor =>
  ({ name, kind, ...(node ? { node } : {}), position, normal, up });
const sideMod = (position: Vec3): RobotAnchor => anchor("mod-side", "mod-mount", position, "base", [-1, 0, 0], FORWARD);

/**
 * Each weapon's anchors (glTF part frame, metres; `normal` is the fire or mount direction, `up` the weapon's up), its
 * joints and its moving nodes. The muzzle frames are for effects only: Shooter owns where shots start and what they hit.
 */
export const WEAPON_RIGS: Readonly<Record<string, { anchors: RobotAnchor[]; joints: RobotJoint[] }>> = {
  "weapon.energy-rifle": { joints: [], anchors: [anchor("muzzle", "muzzle", [0, 0.31, 0], "barrel"), anchor("mod-muzzle", "mod-mount", [0, 0.31, 0], "barrel"), sideMod([-0.05, 0.105, 0])] },
  "weapon.shotgun": { joints: [], anchors: [anchor("muzzle", "muzzle", [0, 0.362, 0], "barrel"), sideMod([-0.05, 0.115, 0])] },
  "weapon.laser": { joints: [], anchors: [anchor("muzzle", "emitter", [0, 0.295, 0], "base"), anchor("mod-muzzle", "mod-mount", [0, 0.295, 0], "base")] },
  "weapon.flamethrower": { joints: [], anchors: [anchor("muzzle", "emitter", [-0.012, 0.366, 0], "nozzle")] },
  "weapon.grapple-hook": {
    joints: [],
    // The cable leaves the launch tube's mouth and ends at the hook's rear; Shooter moves the hook node to its target.
    anchors: [anchor("muzzle", "launcher", [0, 0.283, 0], "base"), anchor("cable", "cable-anchor", [0, 0.24, 0], "hook"), anchor("hook-tip", "hook", [0, 0.4, 0], "hook")],
  },
  "weapon.energy-blade": {
    // The quick-melee swing turns the hilt about its wrist: negative towards the weapon's +y, positive towards -y.
    joints: [{ name: "wrist", kind: "blade-swing", node: "wrist", origin: [0, 0.045, 0], axis: [1, 0, 0], range: [-0.9, 0.9] }],
    // The blade's base and tip, for a swing trail: `normal` along the blade, `up` the cutting edge (the part's +x).
    anchors: [anchor("blade-base", "blade-edge", [0, 0.195, 0], "blade", FORWARD, [1, 0, 0]), anchor("blade-tip", "blade-edge", [0, 0.4, 0], "blade", FORWARD, [1, 0, 0])],
  },
  "weapon.rail-gun": { joints: [], anchors: [anchor("muzzle", "muzzle", [0, 0.31, -0.1], "rails"), anchor("mod-muzzle", "mod-mount", [0, 0.31, -0.1], "rails"), sideMod([-0.05, 0.075, -0.1])] },
  "weapon.rocket-launcher": {
    joints: [],
    anchors: [anchor("muzzle-a", "muzzle", [0.008, 0.353, 0], "base"), anchor("muzzle-b", "muzzle", [0.008, 0.353, -0.2], "base"), sideMod([-0.05, 0.17, -0.1])],
  },
};

/** The long barrel's own muzzle, which replaces the weapon's while it is mounted. */
export const MOD_ANCHORS: Readonly<Record<string, RobotAnchor[]>> = {
  "mod.long-barrel": [anchor("muzzle", "muzzle", [0, 0.09, 0])],
};

/** Each weapon's emissive channels: a node whose scale is the channel's level (1 lit as modelled, 0 hidden). */
export function weaponChannels(part: WeaponPart): Channel[] {
  const charge: Record<string, string> = {
    "weapon.energy-rifle": "the energy cell on the +x side", "weapon.shotgun": "four shell lights on the +x side", "weapon.laser": "the strip along the body's +y side",
    "weapon.flamethrower": "the fuel gauge on the tank", "weapon.grapple-hook": "the ready light on the housing", "weapon.energy-blade": "the guard lights",
    "weapon.rail-gun": "the charge filling the channel between the rails", "weapon.rocket-launcher": "the ready lights on the cradle",
  };
  const fire: Record<string, string> = {
    "weapon.energy-rifle": "the muzzle ring", "weapon.shotgun": "the two muzzle rings", "weapon.laser": "the lens", "weapon.flamethrower": "the nozzle's pilot ring",
    "weapon.grapple-hook": "the band on the hook", "weapon.rail-gun": "the muzzle ring", "weapon.rocket-launcher": "the launch light between the tubes",
  };
  return [
    { name: "charge", node: "glow-charge", kind: "emissive", colour: part.tint, meaning: `${charge[part.key]}: energy, charge or readiness; its scale along its length is the level` },
    ...(fire[part.key] ? [{ name: "fire", node: "glow-fire", kind: "emissive" as const, colour: part.tint, meaning: `${fire[part.key]}: flashes (scale above 1) when the weapon fires` }] : []),
  ];
}

/** The states the recipe bakes (shooter_weapons.py STATES), one glTF animation each, at 30 frames a second. */
export const WEAPON_STATES: Readonly<Record<string, Omit<State, "animation" | "nodes">[]>> = {
  "weapon.energy-rifle": [{ name: "fire", loop: false, seconds: 0.2, use: "fire" }],
  "weapon.shotgun": [{ name: "fire", loop: false, seconds: 0.6, use: "fire" }],
  "weapon.laser": [{ name: "beam", loop: true, seconds: 0.5, use: "continuous-fire" }],
  "weapon.flamethrower": [{ name: "fire", loop: true, seconds: 0.4, use: "continuous-fire" }],
  "weapon.grapple-hook": [
    { name: "launch", loop: false, seconds: 0.2, use: "launch" },
    { name: "retract", loop: false, seconds: 0.4, use: "retract" },
  ],
  "weapon.energy-blade": [
    { name: "extend", loop: false, seconds: 0.2, use: "extend" },
    { name: "retract", loop: false, seconds: 0.2, use: "retract" },
    { name: "swing", loop: false, seconds: 14 / 30, use: "swing" },
  ],
  "weapon.rail-gun": [
    { name: "charge", loop: false, seconds: 1, use: "charge" },
    { name: "fire", loop: false, seconds: 0.3, use: "fire" },
  ],
  "weapon.rocket-launcher": [
    { name: "fire-a", loop: false, seconds: 8 / 30, use: "fire" },
    { name: "fire-b", loop: false, seconds: 8 / 30, use: "fire" },
    { name: "reload", loop: false, seconds: 25 / 30, use: "reload" },
  ],
};

export const bundleVariant = (level: number) => (level === 0 ? "default" : `lod${level}`);

type Buildable = { key: string; cells: [number, number, number] | null };
const BUILDABLE: readonly Buildable[] = [...WEAPON_PARTS.map(({ key, cells }) => ({ key, cells })), ...WEAPON_MODS.map(({ key }) => ({ key, cells: null }))];

export function createWeaponSpec({ part, level, scriptSha256, commonSha256, robotSha256, blenderVersion }: {
  part: Buildable; level: number; scriptSha256: string; commonSha256: string; robotSha256: string; blenderVersion: string;
}) {
  return blenderScriptSpec({
    assetId: part.key,
    inputs: { script: { path: "shooter_weapons.py", sha256: scriptSha256 }, common: { path: "kit_common.py", sha256: commonSha256 }, robot: { path: "combat_robot.py", sha256: robotSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, part: part.key, cells: part.cells, level }, output: "weapon.glb",
  });
}

// ---------------------------------------------------------------- loadouts

type Mount = { face: Face; u: number; v: number; orientation?: Orientation };
type Item = { id: string; key: string; variant?: string; parent?: string; mount?: Mount; translation?: Vec3; orientation?: Orientation; mod?: string };
const GROUND = { normal: [0, 1, 0] as Vec3, uAxis: [1, 0, 0] as Vec3, vAxis: [0, 0, -1] as Vec3 };

/** Shooter's humanoid frame (robot.rs `frame`) on `torso`: the core on its back, the sensor on top, an arm a side, two legs. */
function frame(torso: string, cells: readonly number[]): Item[] {
  return [
    { id: "torso", key: torso, translation: [0, 0.8, 0] },
    { id: "core", key: "robot.core", parent: "torso", mount: { face: "NegX", u: 2, v: 0 } },
    { id: "sensor", key: "robot.sensor", parent: "torso", mount: { face: "PosZ", u: 0, v: 0 } },
    { id: "arm-left", key: "robot.beam.20x20x80", parent: "torso", mount: { face: "PosY", u: cells[2]! - 1, v: 0 } },
    { id: "arm-right", key: "robot.beam.20x20x80", parent: "torso", mount: { face: "NegY", u: 0, v: cells[2]! - 1 } },
    { id: "leg-left", key: "robot.leg", parent: "torso", mount: { face: "NegZ", u: 0, v: 0 } },
    { id: "leg-right", key: "robot.leg", parent: "torso", mount: { face: "NegZ", u: 1, v: 0 } },
  ];
}
const inHand = (id: string, key: string, arm: string, mod?: string): Item => ({ id, key, parent: arm, mount: { face: "PosZ", u: 0, v: 0 }, ...(mod ? { mod } : {}) });
const alongArm = (id: string, key: string, arm: string, mod?: string): Item => ({ id, key, parent: arm, mount: { face: "PosX", u: 0, v: 2 }, ...(mod ? { mod } : {}) });
const onTorso = (id: string, key: string, face: Face, u: number, v: number, mod?: string): Item => ({ id, key, parent: "torso", mount: { face, u, v }, ...(mod ? { mod } : {}) });
const S = "robot.chassis.20x40x80", M = "robot.chassis.40x40x80";

/** Swap the robot kit's placeholder weapons in one of its review builds for this kit's, and add `extra` items. */
function robotBuild(name: string, extra: Item[] = [], mods: Record<string, string> = {}): Item[] {
  return [...ROBOT_COMPOSITIONS[name]!.items.map((item) => ({ ...item, ...(mods[item.id] ? { mod: mods[item.id] } : {}) })), ...extra];
}

/**
 * Review builds. The four humanoids are Shooter's named loadouts exactly (robot.rs `LOADOUTS`: standard, heavy,
 * skirmisher, marksman, with their mods); `turret` and `mini-tank` are the robot kit's review builds with this kit's
 * weapons on them, the turret adding a laser and a flamethrower beside its rail gun and the tank a rocket pod.
 */
export const WEAPON_COMPOSITIONS: Record<string, { note: string; items: Item[] }> = {
  standard: {
    note: "Shooter's STANDARD loadout: the small chassis, the energy rifle on the left arm's tip, the blade on the right arm's tip, the grapple on top and the shotgun on the chest.",
    items: [...frame(S, [1, 2, 4]), inHand("rifle", "weapon.energy-rifle", "arm-left"), inHand("blade", "weapon.energy-blade", "arm-right"),
      onTorso("grapple", "weapon.grapple-hook", "PosZ", 0, 1), onTorso("shotgun", "weapon.shotgun", "PosX", 1, 3)],
  },
  heavy: {
    note: "Shooter's HEAVY loadout: the medium chassis, the rail gun along the left arm, the blade on the right arm's tip, the rocket launcher on top, the grapple on the chest and a battery on the back.",
    items: [...frame(M, [2, 2, 4]), alongArm("rail-gun", "weapon.rail-gun", "arm-left"), inHand("blade", "weapon.energy-blade", "arm-right"),
      onTorso("rockets", "weapon.rocket-launcher", "PosZ", 1, 0), onTorso("grapple", "weapon.grapple-hook", "PosX", 0, 3), onTorso("battery", "robot.battery", "NegX", 3, 0)],
  },
  skirmisher: {
    note: "Shooter's SKIRMISHER loadout: STANDARD with the rapid cycler on the rifle and the efficiency coil on the shotgun.",
    items: [...frame(S, [1, 2, 4]), inHand("rifle", "weapon.energy-rifle", "arm-left", "mod.rapid-cycler"), inHand("blade", "weapon.energy-blade", "arm-right"),
      onTorso("grapple", "weapon.grapple-hook", "PosZ", 0, 1), onTorso("shotgun", "weapon.shotgun", "PosX", 1, 3, "mod.efficiency-coil")],
  },
  marksman: {
    note: "Shooter's MARKSMAN loadout: the medium chassis, the long-barrel rifle along the left arm, the blade on the right arm's tip, the overcharged rail gun on top and the grapple on the chest.",
    items: [...frame(M, [2, 2, 4]), alongArm("rifle", "weapon.energy-rifle", "arm-left", "mod.long-barrel"), inHand("blade", "weapon.energy-blade", "arm-right"),
      onTorso("rail-gun", "weapon.rail-gun", "PosZ", 1, 0, "mod.overcharger"), onTorso("grapple", "weapon.grapple-hook", "PosX", 0, 3)],
  },
  turret: {
    note: "The robot kit's turret with this kit's rail gun on its housing's muzzle end, a laser and a flamethrower beside it.",
    items: robotBuild("turret", [
      { id: "laser", key: "weapon.laser", parent: "housing", mount: { face: "PosZ", u: 1, v: 0 } },
      { id: "flamethrower", key: "weapon.flamethrower", parent: "housing", mount: { face: "PosZ", u: 1, v: 1 } },
    ]),
  },
  "mini-tank": {
    note: "The robot kit's mini-tank with this kit's rail gun on its turret hinge (with a long barrel) and a rocket pod on its deck; the tracks stay placeholders until #634.",
    items: robotBuild("mini-tank", [{ id: "rockets", key: "weapon.rocket-launcher", parent: "hull", mount: { face: "NegX", u: 3, v: 1 } }], { "rail-gun": "mod.long-barrel" }),
  },
};

const ROBOT_KEYS = new Set(ROBOT_PARTS.map((part) => part.key));
const allTypes = () => new Map<string, { key: string; cells: readonly number[]; sockets: keyof typeof SOCKET_FACES }>([
  ...ROBOT_PARTS, ...PLACEHOLDER_PARTS.filter((part) => !part.key.startsWith("weapon.")), ...WEAPON_PARTS.map((part) => ({ ...part, sockets: "NONE" as const })),
].map((part) => [part.key, part]));

/** The anchor frame (as a socket) a mod sits on, from a weapon's anchor: u = up x normal, v = up. */
export function anchorSocket(a: RobotAnchor) {
  const n = a.normal, v = a.up!;
  const u: Vec3 = [v[1] * n[2] - v[2] * n[1], v[2] * n[0] - v[0] * n[2], v[0] * n[1] - v[1] * n[0]].map((c) => c || 0) as Vec3;
  return { position: a.position, normal: n, uAxis: u, vAxis: v };
}

/** Each item's part type, socket, kit and placement (translation, quaternion) in the build's glTF frame, plus its mod's. */
export function resolveLoadout(items: readonly Item[]) {
  const types = allTypes();
  const placed = new Map<string, { transform: Transform; cells: readonly number[]; faces: readonly Face[] }>();
  return items.map((item) => {
    const type = types.get(item.key);
    if (!type) throw new Error(`composition item ${item.id}: unknown part ${item.key}`);
    let transform: Transform = item.orientation
      ? mountTransform({ ...GROUND, position: item.translation ?? [0, 0, 0] }, item.orientation)
      : { ...IDENTITY_TRANSFORM, translation: item.translation ?? [0, 0, 0] };
    let socket: number | undefined;
    if (item.parent) {
      const parent = placed.get(item.parent);
      if (!parent || !item.mount) throw new Error(`composition item ${item.id}: parent ${item.parent} must come first, with a mount`);
      const found = partSockets(parent.cells, parent.faces).find((s) => s.face === item.mount!.face && s.u === item.mount!.u && s.v === item.mount!.v);
      if (!found) throw new Error(`composition item ${item.id}: ${item.parent} has no socket ${item.mount.face} (${item.mount.u}, ${item.mount.v})`);
      socket = found.id;
      transform = compose(parent.transform, mountTransform(found, item.mount.orientation));
    }
    placed.set(item.id, { transform, cells: type.cells, faces: SOCKET_FACES[type.sockets] });
    let mod: { key: string; anchor: string; translation: Vec3; rotation: number[]; transform: Transform } | undefined;
    if (item.mod) {
      const spec = WEAPON_MODS.find((candidate) => candidate.key === item.mod);
      const at = WEAPON_RIGS[item.key]?.anchors.find((candidate) => candidate.name === spec?.mount);
      if (!spec || !at) throw new Error(`composition item ${item.id}: ${item.key} has no anchor for ${item.mod}`);
      const t = compose(transform, mountTransform(anchorSocket(at)));
      mod = { key: spec.key, anchor: at.name, translation: t.translation.map(round) as Vec3, rotation: quaternion(t.rotation), transform: t };
    }
    const own = WEAPON_PARTS.some((part) => part.key === item.key);
    return {
      id: item.id, key: item.key,
      ...(own ? { variant: "default" } : ROBOT_KEYS.has(item.key) ? { kit: ROBOT_RELEASE, variant: item.variant ?? "default" } : { placeholder: true as const, cells: [...type.cells] }),
      ...(item.parent ? { parent: item.parent, socket, face: item.mount!.face, u: item.mount!.u, v: item.mount!.v, orientation: item.mount!.orientation ?? IDENTITY } : {}),
      ...(!item.parent && item.orientation ? { orientation: item.orientation } : {}),
      translation: transform.translation.map(round) as Vec3, rotation: quaternion(transform.rotation),
      ...(mod ? { mod: { key: mod.key, anchor: mod.anchor, translation: mod.translation, rotation: mod.rotation } } : {}),
      transform, modTransform: mod?.transform,
    };
  });
}

// ---------------------------------------------------------------- build

type Built = KitPart & { part: Buildable; level: number };

/** Drop animation channels that never leave the node's rest value (the exporter samples every bone of every clip). */
function pruneStaticChannels(document: Document) {
  for (const animation of document.getRoot().listAnimations()) {
    for (const channel of animation.listChannels()) {
      const node = channel.getTargetNode(), path = channel.getTargetPath(), output = channel.getSampler()?.getOutput();
      if (!node || !output || !path) continue;
      const rest = path === "translation" ? node.getTranslation() : path === "rotation" ? node.getRotation() : path === "scale" ? node.getScale() : null;
      if (!rest) continue;
      let moves = false;
      for (let i = 0; i < output.getCount() && !moves; i += 1) {
        const value = output.getElement(i, []);
        moves = value.some((c, k) => Math.abs(c - rest[k]!) > 1e-6);
      }
      if (!moves) channel.dispose();
    }
    for (const sampler of animation.listSamplers()) {
      if (animation.listChannels().some((channel) => channel.getSampler() === sampler)) continue;
      const accessors = [sampler.getInput(), sampler.getOutput()];
      sampler.dispose();
      for (const accessor of accessors) if (accessor && accessor.listParents().every((parent) => parent.propertyType === "Root")) accessor.dispose();
    }
  }
}

export async function buildShooterWeapons({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("shooter_weapons.py");
  const common = await readBlenderRecipeSource("kit_common.py");
  const robot = await readBlenderRecipeSource("combat_robot.py");
  const built: Built[] = [];
  for (const part of BUILDABLE) for (const level of LEVELS) {
    log(`generate ${part.key} ${bundleVariant(level)}`);
    built.push({ part, level, ...await buildKitPart(root, {
      workspace: path.join(root, "parts", `${part.key}.${bundleVariant(level)}`), allowedValidatorWarnings: VALIDATOR_WARNINGS,
      files: { "shooter_weapons.py": source.bytes, "kit_common.py": common.bytes, "combat_robot.py": robot.bytes },
      spec: createWeaponSpec({ part, level, scriptSha256: source.sha256, commonSha256: common.sha256, robotSha256: robot.sha256, blenderVersion: source.blenderVersion }),
    }) });
  }

  log("prune static channels, add tangents and COLOR_0");
  const io = new NodeIO().registerExtensions([KHRTextureBasisu]);
  const finished: AssetRef[] = [];
  const atlas = new Map<string, string>();
  for (const part of built) {
    for (const texture of part.document.getRoot().listTextures()) {
      const sha = sha256Bytes(texture.getImage()!);
      const name = texture.getName();
      if ((atlas.get(name) ?? sha) !== sha) throw new Error(`${part.part.key} ${part.level}: texture '${name}' differs from the shared atlas`);
      atlas.set(name, sha);
    }
    pruneStaticChannels(part.document);
    await withLightingAttributes(part.document);
    finished.push((await storeAssetObject(root, { bytes: await io.writeBinary(part.document), kind: "scene", mediaType: "model/gltf-binary" })).asset);
  }

  log("measure the descriptor");
  const tan = Math.tan((KIT_LOD_REFERENCE_FOV_Y / 2) * Math.PI / 180);
  const lodsOf = (levels: Built[]) => {
    const bounds = documentBounds(levels[0]!.document);
    const radius = round(Math.hypot(...[0, 1, 2].map((k) => bounds.max[k]! - bounds.min[k]!)) / 2);
    const distances = scaledLodDistances(WEAPONS_LOD_DISTANCES, bounds);
    return {
      boundingSphere: { center: [0, 1, 2].map((k) => round((bounds.min[k]! + bounds.max[k]!) / 2)), radius },
      levels: levels.map((level, index) => {
        const distance = distances[index];
        return { variant: bundleVariant(level.level), triangles: triangles(level.document), minScreenSize: distance ? round(Number((radius / (distance * tan)).toFixed(4))) : 0, referenceMaxDistance: distance ?? null };
      }),
    };
  };
  const levelsOf = (key: string) => built.filter((b) => b.part.key === key);
  const hitProxy = (bounds: { min: Vec3; max: Vec3 }) => [{ name: "body", tag: "hit-proxy" as const, center: [0, 1, 2].map((k) => round((bounds.min[k]! + bounds.max[k]!) / 2)), size: [0, 1, 2].map((k) => round(bounds.max[k]! - bounds.min[k]!)) }];
  const mountFrame = { position: [0, 0, 0], normal: partToGltf(faceFrame("NegZ").normal), uAxis: [1, 0, 0], vAxis: [0, 0, -1] };
  const parts = WEAPON_PARTS.map((part) => {
    const full = levelsOf(part.key)[0]!;
    const bounds = documentBounds(full.document);
    const animations = new Map(full.document.getRoot().listAnimations().map((animation) => [animation.getName(), [...new Set(animation.listChannels().map((channel) => channel.getTargetNode()!.getName()))].sort()]));
    return {
      key: part.key, kind: part.kind, cells: part.cells, socketFaces: [], cuboid: partCuboid(part.cells), bounds, triangles: triangles(full.document),
      mount: mountFrame, socketCount: 0, sockets: [],
      joints: WEAPON_RIGS[part.key]!.joints, anchors: WEAPON_RIGS[part.key]!.anchors,
      hitProxies: hitProxy(bounds), lods: lodsOf(levelsOf(part.key)), variants: {},
      channels: weaponChannels(part),
      states: WEAPON_STATES[part.key]!.map((state) => {
        if (!animations.has(state.name)) throw new Error(`${part.key}: no animation ${state.name} (${[...animations.keys()].join(", ")})`);
        return { ...state, seconds: round(state.seconds), animation: state.name, nodes: animations.get(state.name)! };
      }),
    };
  });
  const mods = WEAPON_MODS.map((mod) => {
    const full = levelsOf(mod.key)[0]!;
    const bounds = documentBounds(full.document);
    return {
      key: mod.key, kind: "mod", mountsOn: mod.mount, fits: mod.fits, bounds, triangles: triangles(full.document), mount: mountFrame,
      anchors: MOD_ANCHORS[mod.key] ?? [], lods: lodsOf(levelsOf(mod.key)),
    };
  });
  const descriptor = {
    schema: WEAPONS_DESCRIPTOR_SCHEMA, kit: WEAPONS_RELEASE, ...socketGridConvention(),
    lodSelection: {
      metric: "projected-bounding-sphere-height-fraction", referenceFovYDegrees: KIT_LOD_REFERENCE_FOV_Y,
      rule: "Use the first level whose minScreenSize is at most the asset's projected bounding-sphere diameter divided by the viewport height (radius / (distance * tan(fovY / 2)), scaled by the instance scale). referenceMaxDistance is the distance in metres at which that level ends for an unscaled instance at referenceFovYDegrees.",
    },
    authority: "Shooter owns weapon and mod IDs and footprints, which mods fit which weapons, firing, energy, damage, hits, ranges, pickups, audio and effects, attachment legality and assembly. Muzzle and anchor frames are for effects only; hitProxies are non-authoritative visual bounds.",
    weaponAxes: "A weapon points out of its socket: its barrel, emitter, hook or blade runs along the part's +z (glTF +Y), with its muzzle at the far end; its up is the part's +y (glTF -Z). Anchors give each frame explicitly.",
    channelRule: "An emissive channel is a node in the weapon's skin whose glow geometry sits proud of a dark housing. Its scale is the channel's level: 1 lit as modelled, 0 hidden in its housing, above 1 a flash. A charge channel scales along its length (the part's +z, the node's local +Y) like a bar filling. Clips animate the channels; a renderer may also set their scale from game state between clips.",
    modMounting: "A mod sits on a weapon's anchor (mountsOn) as a part sits on a socket: its origin on the anchor's position, its glTF +Y along the anchor's normal and its -Z along the anchor's up, so u = up x normal. A mod that carries a muzzle anchor replaces the weapon's muzzle while mounted.",
    parts, mods,
    sources: "Original geometry and procedurally painted textures from the recipe (adapters/blender/shooter_weapons.py on the robot kit's Part builder); no third-party assets.",
    compositions: Object.entries(WEAPON_COMPOSITIONS).map(([name, { note, items }]) => ({
      name, note, items: resolveLoadout(items).map(({ transform: _t, modTransform: _m, ...item }) => item),
    })),
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: WEAPONS_DESCRIPTOR_ATTACHMENT, mediaType: "application/json" })).asset;

  log("encode the atlas as KTX2 (ktx create)");
  const delivered = await ktx2Assets(root, WEAPONS_RELEASE, finished);
  const selections = built.map((part, index) => ({ key: part.part.key, variant: bundleVariant(part.level), ...(index === 0 ? { attachments: [{ name: WEAPONS_DESCRIPTOR_ATTACHMENT }] } : {}) }));
  const packed = await exportKitBundle(root, {
    tarName: WEAPONS_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(built.map((part) => [`${part.part.key}#${bundleVariant(part.level)}`, part.document])) as Record<string, Document>,
    lineage: {
      recipe: {
        script: "adapters/blender/shooter_weapons.py", sha256: source.sha256, common: { script: "adapters/blender/kit_common.py", sha256: common.sha256 },
        robot: { script: "adapters/blender/combat_robot.py", sha256: robot.sha256 }, blenderVersion: source.blenderVersion,
      },
      release: WEAPONS_RELEASE, descriptor: descriptorAsset,
    },
  };
}

if (import.meta.main) await runKitCli("scripts/build-shooter-weapons.ts", WEAPONS_RELEASE, buildShooterWeapons, { descriptorFile: true });
