// Build the Shooter combat robot part kit (docs/combat-robot-kit.md, #595) from the scripted recipe
// adapters/blender/combat_robot.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-combat-robot.ts [--textures full|half] --out <directory>
// Each part's variant and level is one external.blender.script@1 run, imported through scene.import.gltf@2, all on one
// metal atlas. The descriptor (socket-grid-kit-descriptor-v1) carries the socket grid computed from the catalog below
// (src/socket-grid.ts), so sockets never depend on mesh detail. No game places the kit yet.
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
  FACES, IDENTITY, IDENTITY_TRANSFORM, QUARTER_TURN, SOCKET_CELL, SOCKET_FACES, compose, faceFrame, mountTransform, partCuboid, partSockets, partToGltf, quaternion,
  type Face, type Orientation, type Transform, type Vec3,
} from "../src/socket-grid.ts";
import { withLightingAttributes } from "./baked-rock-kit.ts";

/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const ROBOT_RELEASE = "shooter-combat-robot";
export const ROBOT_TAR_NAME = "shooter-combat-robot.kit.tar";
export const ROBOT_MATERIAL = "robot-metal";
export const ROBOT_DESCRIPTOR_SCHEMA = "socket-grid-kit-descriptor-v1";
export const ROBOT_DESCRIPTOR_ATTACHMENT = "socket-grid-descriptor";
/** Full-detail triangle ceiling per part: close third-person parts, between a modular piece and a hero object. */
export const ROBOT_TRIANGLE_BUDGET = 2000;
/** Where LOD0 and lod1 end for a piece up to 1 m across; scaledLodDistances grows them for larger pieces. */
export const ROBOT_LOD_DISTANCES = [60, 180] as const;
const VALIDATOR_WARNINGS = ["MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"];

type SocketFaces = keyof typeof SOCKET_FACES;
export type RobotPartType = { key: string; kind: string; cells: [number, number, number]; sockets: SocketFaces; variants: readonly string[] };

/**
 * The parts this kit builds, exactly as Shooter's catalog declares them (crates/shooter-sim/src/robot.rs `parts`:
 * key, cells x * y * z, socket faces). robot.battery arrived with shooter#79.
 */
export const ROBOT_PARTS: readonly RobotPartType[] = [
  { key: "robot.chassis.20x40x80", kind: "chassis", cells: [1, 2, 4], sockets: "ALL", variants: ["default"] },
  { key: "robot.chassis.40x40x80", kind: "chassis", cells: [2, 2, 4], sockets: "ALL", variants: ["default"] },
  { key: "robot.chassis.40x60x80", kind: "chassis", cells: [2, 3, 4], sockets: "ALL", variants: ["default"] },
  { key: "robot.beam.20x20x40", kind: "beam", cells: [1, 1, 2], sockets: "ALL", variants: ["default"] },
  { key: "robot.beam.20x20x80", kind: "beam", cells: [1, 1, 4], sockets: "ALL", variants: ["default"] },
  { key: "robot.core", kind: "core", cells: [1, 1, 1], sockets: "NONE", variants: ["default"] },
  { key: "robot.sensor", kind: "sensor", cells: [1, 1, 1], sockets: "NONE", variants: ["default"] },
  { key: "robot.battery", kind: "battery", cells: [1, 2, 1], sockets: "NONE", variants: ["default"] },
  { key: "robot.armor.plate", kind: "armor", cells: [2, 2, 1], sockets: "NONE", variants: ["default", "damaged"] },
  { key: "robot.joint.hinge", kind: "joint", cells: [1, 1, 1], sockets: "TOP", variants: ["default"] },
  { key: "robot.joint.rotor", kind: "joint", cells: [1, 1, 1], sockets: "TOP", variants: ["default"] },
  { key: "robot.leg", kind: "locomotion", cells: [1, 1, 4], sockets: "NONE", variants: ["default"] },
];

export type RobotJoint = { name: string; kind: string; node: string; parent?: string; origin: Vec3; axis: Vec3; movingSockets?: number[]; range?: [number, number] };
export type RobotAnchor = { name: string; kind: string; node?: string; position: Vec3; normal: Vec3; up?: Vec3 };

/**
 * The motor axes of the articulated parts, in the part's glTF frame (metres; the origin is the mount anchor). `node`
 * is the glTF joint node the axis turns (at rest unrotated, at `origin`); its children in the skin move with it.
 * Zero is the pose as modelled and a positive angle turns right-handed about `axis`. A hinge or rotor's moving side
 * carries its one socket (`movingSockets`, Shooter's Faces::TOP). `range` is the angle the visual clears without
 * self-intersection, not a gameplay limit: Shooter owns limits, torque and motion (shooter#73).
 */
export const ROBOT_JOINTS: Readonly<Record<string, { joints: RobotJoint[]; anchors: RobotAnchor[] }>> = {
  "robot.joint.hinge": {
    joints: [{ name: "hinge", kind: "hinge", node: "hinge", origin: [0, 0.1, 0], axis: [1, 0, 0], movingSockets: [0], range: [-Math.PI / 2, Math.PI / 2] }],
    anchors: [],
  },
  "robot.joint.rotor": {
    joints: [{ name: "rotor", kind: "rotor", node: "rotor", origin: [0, 0.1, 0], axis: [0, 1, 0], movingSockets: [0] }],
    anchors: [],
  },
  "robot.leg": {
    // Hip, knee and ankle all turn about the leg's x; its +y (glTF -Z) is the toe's direction, and a positive knee
    // angle folds the shin back with the knee forward.
    joints: [
      { name: "hip", kind: "leg-hip", node: "hip", origin: [0, 0.08, 0], axis: [1, 0, 0], range: [-1.2, 1.2] },
      { name: "knee", kind: "leg-knee", node: "knee", parent: "hip", origin: [0, 0.43, 0], axis: [1, 0, 0], range: [0, 2] },
      { name: "ankle", kind: "leg-ankle", node: "ankle", parent: "knee", origin: [0, 0.73, 0], axis: [1, 0, 0], range: [-1, 1] },
    ],
    // The sole's centre: its normal points out of the sole (along the leg, away from the hip), `up` is the toe.
    anchors: [{ name: "sole", kind: "foot-contact", node: "ankle", position: [0, 0.8, -0.01], normal: [0, 1, 0], up: [0, 0, -1] }],
  },
};

/** The leg's reference walk clips (glTF animations on every level, rotation channels only, looping in place). */
export const LEG_CLIPS = {
  "walk-biped": { seconds: 1, stride: 0.36, duty: 0.6, phases: { left: 0, right: 0.5 } },
  "walk-quadruped": { seconds: 0.8, stride: 0.28, duty: 0.7, phases: { "rear-left": 0, "front-left": 0.25, "rear-right": 0.5, "front-right": 0.75 } },
} as const;

/** Catalog parts other kits build (#594 weapons, #634 wheels and tracks): the review compositions draw them as labelled placeholder boxes. */
export const PLACEHOLDER_PARTS: readonly Omit<RobotPartType, "variants">[] = [
  { key: "robot.wheel", kind: "locomotion", cells: [2, 2, 1], sockets: "NONE" },
  { key: "robot.track", kind: "locomotion", cells: [1, 4, 2], sockets: "NONE" },
  { key: "weapon.energy-blade", kind: "weapon", cells: [1, 1, 2], sockets: "NONE" },
  { key: "weapon.grapple-hook", kind: "weapon", cells: [1, 1, 2], sockets: "NONE" },
  { key: "weapon.rail-gun", kind: "weapon", cells: [1, 2, 2], sockets: "NONE" },
  { key: "weapon.rocket-launcher", kind: "weapon", cells: [1, 2, 2], sockets: "NONE" },
];

const LEVELS = [0, 1, 2] as const;
/** The bundle variant of a part's variant at a level: `default`, `lod1`, `damaged`, `damaged-lod1`, ... */
export const bundleVariant = (variant: string, level: number) => level === 0 ? variant : variant === "default" ? `lod${level}` : `${variant}-lod${level}`;

export function createRobotSpec({ part, level, variant, scriptSha256, commonSha256, blenderVersion }: {
  part: RobotPartType; level: number; variant: string; scriptSha256: string; commonSha256: string; blenderVersion: string;
}) {
  return blenderScriptSpec({
    assetId: part.key,
    inputs: { script: { path: "combat_robot.py", sha256: scriptSha256 }, common: { path: "kit_common.py", sha256: commonSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, part: part.key, cells: part.cells, level, variant }, output: "robot.glb",
  });
}

// ---------------------------------------------------------------- compositions

type Mount = { face: Face; u: number; v: number; orientation?: Orientation };
/** A root item stands on the ground as on a socket at `translation` facing +Y (u = +X, v = -Z), turned by `orientation`. */
type Item = { id: string; key: string; variant?: string; parent?: string; mount?: Mount; translation?: Vec3; orientation?: Orientation };
const GROUND = { normal: [0, 1, 0] as Vec3, uAxis: [1, 0, 0] as Vec3, vAxis: [0, 0, -1] as Vec3 };

const turn = (quarters: number): Orientation => ({ ...IDENTITY, yaw: quarters * QUARTER_TURN });

/**
 * Review builds, each a single-parent tree on the socket grid. `humanoid` is Shooter's HEAVY build exactly (robot.rs:
 * the medium chassis, core and battery on its back, sensor on top, a long beam per arm, two legs, the rail gun along
 * the left arm, the blade in the right hand, the rocket launcher on top, the grapple on the chest) plus one armor plate
 * on its chest. `robo-dog` lays the medium chassis along +X on four legs with a nodding sensor head on a hinge.
 * `mini-tank` lays the large chassis on two placeholder tracks with a rotor, riser, hinge and gun. `turret` is a
 * stationary build: a large chassis as the pedestal with a rotor, a short riser beam, a hinge and the medium chassis as
 * a horizontal gun housing. Every build faces +X; legs walk towards +X.
 */
export const ROBOT_COMPOSITIONS: Record<string, { note: string; items: Item[] }> = {
  humanoid: {
    note: "Shooter's HEAVY build (crates/shooter-sim/src/robot.rs) plus an armor plate on the chest, standing on its placeholder legs; it faces +X.",
    items: [
      { id: "torso", key: "robot.chassis.40x40x80", translation: [0, 0.8, 0] },
      { id: "core", key: "robot.core", parent: "torso", mount: { face: "NegX", u: 2, v: 0 } },
      { id: "sensor", key: "robot.sensor", parent: "torso", mount: { face: "PosZ", u: 0, v: 0 } },
      { id: "arm-left", key: "robot.beam.20x20x80", parent: "torso", mount: { face: "PosY", u: 3, v: 0 } },
      { id: "arm-right", key: "robot.beam.20x20x80", parent: "torso", mount: { face: "NegY", u: 0, v: 3 } },
      { id: "leg-left", key: "robot.leg", parent: "torso", mount: { face: "NegZ", u: 0, v: 0 } },
      { id: "leg-right", key: "robot.leg", parent: "torso", mount: { face: "NegZ", u: 1, v: 0 } },
      { id: "rail-gun", key: "weapon.rail-gun", parent: "arm-left", mount: { face: "PosX", u: 0, v: 2 } },
      { id: "blade", key: "weapon.energy-blade", parent: "arm-right", mount: { face: "PosZ", u: 0, v: 0 } },
      { id: "rockets", key: "weapon.rocket-launcher", parent: "torso", mount: { face: "PosZ", u: 1, v: 0 } },
      { id: "grapple", key: "weapon.grapple-hook", parent: "torso", mount: { face: "PosX", u: 0, v: 3 } },
      { id: "battery", key: "robot.battery", parent: "torso", mount: { face: "NegX", u: 3, v: 0 } },
      { id: "chest-plate", key: "robot.armor.plate", parent: "torso", mount: { face: "PosX", u: 0, v: 1 } },
    ],
  },
  "robo-dog": {
    note: "A quadruped: the medium chassis lying along +X as the body, four legs underneath at its corners, a sensor head nodding on a hinge at the front, the core and a battery on its back and armor plates on its flanks (one damaged).",
    items: [
      { id: "body", key: "robot.chassis.40x40x80", translation: [-0.4, 1.1, 0.2], orientation: { yaw: 0, pitch: QUARTER_TURN, roll: 0 } },
      { id: "leg-rear-left", key: "robot.leg", parent: "body", mount: { face: "PosX", u: 0, v: 0 } },
      { id: "leg-rear-right", key: "robot.leg", parent: "body", mount: { face: "PosX", u: 1, v: 0 } },
      { id: "leg-front-left", key: "robot.leg", parent: "body", mount: { face: "PosX", u: 0, v: 3 } },
      { id: "leg-front-right", key: "robot.leg", parent: "body", mount: { face: "PosX", u: 1, v: 3 } },
      { id: "neck", key: "robot.joint.hinge", parent: "body", mount: { face: "NegX", u: 3, v: 0, orientation: turn(1) } },
      { id: "head", key: "robot.sensor", parent: "neck", mount: { face: "PosZ", u: 0, v: 0, orientation: turn(-1) } },
      { id: "core", key: "robot.core", parent: "body", mount: { face: "NegX", u: 0, v: 1 } },
      { id: "battery", key: "robot.battery", parent: "body", mount: { face: "NegX", u: 1, v: 0, orientation: turn(1) } },
      { id: "flank-left", key: "robot.armor.plate", parent: "body", mount: { face: "PosY", u: 1, v: 0 } },
      { id: "flank-right", key: "robot.armor.plate", variant: "damaged", parent: "body", mount: { face: "NegY", u: 0, v: 1 } },
    ],
  },
  "mini-tank": {
    note: "A low tracked tank: the large chassis lying along +X on two tracks (placeholders until #634), a rotor on its deck with a riser, a hinge and the rail gun (placeholder until #594) as a pitching, turning turret, the core at the back, a sensor and a battery on the deck and an armor plate on the nose.",
    items: [
      { id: "hull", key: "robot.chassis.40x60x80", translation: [-0.4, 0.7, 0.3], orientation: { yaw: 0, pitch: QUARTER_TURN, roll: 0 } },
      { id: "track-left", key: "robot.track", parent: "hull", mount: { face: "PosX", u: 0, v: 0 } },
      { id: "track-right", key: "robot.track", parent: "hull", mount: { face: "PosX", u: 2, v: 0 } },
      { id: "rotor", key: "robot.joint.rotor", parent: "hull", mount: { face: "NegX", u: 1, v: 1 } },
      { id: "riser", key: "robot.beam.20x20x40", parent: "rotor", mount: { face: "PosZ", u: 0, v: 0 } },
      { id: "elevation", key: "robot.joint.hinge", parent: "riser", mount: { face: "PosX", u: 0, v: 1 } },
      { id: "rail-gun", key: "weapon.rail-gun", parent: "elevation", mount: { face: "PosZ", u: 0, v: 0 } },
      { id: "core", key: "robot.core", parent: "hull", mount: { face: "NegZ", u: 1, v: 1 } },
      { id: "sensor", key: "robot.sensor", parent: "hull", mount: { face: "NegX", u: 3, v: 0 } },
      { id: "battery", key: "robot.battery", parent: "hull", mount: { face: "NegX", u: 0, v: 0 } },
      { id: "nose-plate", key: "robot.armor.plate", parent: "hull", mount: { face: "PosZ", u: 0, v: 0 } },
    ],
  },
  turret: {
    note: "A stationary turret: the large chassis as the pedestal, a rotor, a riser beam, a hinge and the medium chassis as the gun housing pointing +X, with armor, the core, a battery and a sensor.",
    items: [
      { id: "pedestal", key: "robot.chassis.40x60x80", translation: [-0.1, 0, 0.2] },
      { id: "rotor", key: "robot.joint.rotor", parent: "pedestal", mount: { face: "PosZ", u: 0, v: 1 } },
      { id: "riser", key: "robot.beam.20x20x40", parent: "rotor", mount: { face: "PosZ", u: 0, v: 0 } },
      { id: "elevation", key: "robot.joint.hinge", parent: "riser", mount: { face: "PosX", u: 0, v: 1 } },
      { id: "housing", key: "robot.chassis.40x40x80", parent: "elevation", mount: { face: "PosZ", u: 0, v: 0 } },
      { id: "sensor", key: "robot.sensor", parent: "housing", mount: { face: "PosY", u: 3, v: 0 } },
      { id: "rail-gun", key: "weapon.rail-gun", parent: "housing", mount: { face: "PosZ", u: 0, v: 0 } },
      { id: "core", key: "robot.core", parent: "pedestal", mount: { face: "NegX", u: 3, v: 1 } },
      { id: "battery", key: "robot.battery", parent: "pedestal", mount: { face: "NegX", u: 1, v: 0 } },
      { id: "front-plate", key: "robot.armor.plate", parent: "pedestal", mount: { face: "PosX", u: 0, v: 0 } },
      { id: "side-plate", key: "robot.armor.plate", variant: "damaged", parent: "pedestal", mount: { face: "PosY", u: 0, v: 0, orientation: turn(0) } },
      { id: "housing-plate", key: "robot.armor.plate", parent: "housing", mount: { face: "PosX", u: 0, v: 1 } },
    ],
  },
};

const allTypes = () => new Map<string, Omit<RobotPartType, "variants">>([...ROBOT_PARTS, ...PLACEHOLDER_PARTS].map((part) => [part.key, part]));

/** Each composition item's part type, socket and placement (translation, quaternion) in the composition's glTF frame. */
export function resolveComposition(items: readonly Item[]) {
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
    return {
      id: item.id, key: item.key, ...(ROBOT_PARTS.some((part) => part.key === item.key) ? { variant: item.variant ?? "default" } : { placeholder: true, cells: type.cells }),
      ...(item.parent ? { parent: item.parent, socket, face: item.mount!.face, u: item.mount!.u, v: item.mount!.v, orientation: item.mount!.orientation ?? IDENTITY } : {}),
      ...(!item.parent && item.orientation ? { orientation: item.orientation } : {}),
      translation: transform.translation.map(round) as Vec3, rotation: quaternion(transform.rotation),
      transform,
    };
  });
}

// ---------------------------------------------------------------- descriptor

/** The convention every socket-grid kit shares (robot #595, weapons #594, wheels and tracks #634). */
export function socketGridConvention() {
  return {
    units: "metre", up: "+Y", handedness: "right", cell: SOCKET_CELL,
    frame: {
      partAxes: { x: "+X", y: "-Z", z: "+Y" },
      origin: "mount-anchor",
      mountFace: "NegZ",
      rule: "A part is a cuboid of cells (x, y, z of its own frame, z its height; its base is x * y). Its own x, y and z are glTF +X, -Z and +Y. The origin is the mount anchor: the centre of the base's first cell (0, 0) on the mount face (the part's -z face), so the cuboid runs from (-0.1, 0, 0.1) to (0.2 x - 0.1, 0.2 z, 0.1 - 0.2 y) in glTF metres and no geometry leaves it.",
    },
    faces: FACES.map((face) => { const f = faceFrame(face); return { face, normal: partToGltf(f.normal), uAxis: partToGltf(f.u), vAxis: partToGltf(f.v) }; }),
    socketNumbering: "Faces in the order PosX, NegX, PosY, NegY, PosZ, NegZ (only those the part type declares); on a face, row by row from the cuboid's minimum corner: id = (sockets of earlier faces) + v * columns + u. This is Shooter's PartType::socket.",
    mounting: "A child sits on one parent socket: its mount anchor on the socket's position, its +X along the socket's uAxis, its -Z along vAxis and its +Y along the outward normal, then turned by the mount's orientation (binary angles, 65536 a turn: yaw about the normal, then pitch, then roll, intrinsic Z-Y-X in the socket's (u, v, normal) frame). Turning about the mount anchor turns the footprint as Shooter's quarter turns do. Its base reserves cells (u + i, v + j) of the face at no turn.",
  };
}

type Built = KitPart & { part: RobotPartType; variant: string; level: number };

export async function buildCombatRobot({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("combat_robot.py");
  const common = await readBlenderRecipeSource("kit_common.py");
  const built: Built[] = [];
  for (const part of ROBOT_PARTS) for (const variant of part.variants) for (const level of LEVELS) {
    log(`generate ${part.key} ${bundleVariant(variant, level)}`);
    built.push({ part, variant, level, ...await buildKitPart(root, {
      workspace: path.join(root, "parts", `${part.key}.${bundleVariant(variant, level)}`), allowedValidatorWarnings: VALIDATOR_WARNINGS,
      files: { "combat_robot.py": source.bytes, "kit_common.py": common.bytes },
      spec: createRobotSpec({ part, level, variant, scriptSha256: source.sha256, commonSha256: common.sha256, blenderVersion: source.blenderVersion }),
    }) });
  }

  log("add tangents and COLOR_0");
  const io = new NodeIO().registerExtensions([KHRTextureBasisu]);
  const finished: AssetRef[] = [];
  const atlas = new Map<string, string>();
  for (const part of built) {
    for (const texture of part.document.getRoot().listTextures()) {
      const sha = sha256Bytes(texture.getImage()!);
      const name = texture.getName();
      if ((atlas.get(name) ?? sha) !== sha) throw new Error(`${part.part.key} ${part.variant} ${part.level}: texture '${name}' differs from the shared atlas`);
      atlas.set(name, sha);
    }
    // The exporter samples every channel of every bone; the walk clips only turn the joints, so they keep those rotations.
    const jointNodes = new Set((ROBOT_JOINTS[part.part.key]?.joints ?? []).map((joint) => joint.node));
    for (const animation of part.document.getRoot().listAnimations()) {
      for (const channel of animation.listChannels()) {
        if (channel.getTargetPath() !== "rotation" || !jointNodes.has(channel.getTargetNode()?.getName() ?? "")) channel.dispose();
      }
      for (const sampler of animation.listSamplers()) {
        if (animation.listChannels().some((channel) => channel.getSampler() === sampler)) continue;
        const accessors = [sampler.getInput(), sampler.getOutput()];
        sampler.dispose();
        for (const accessor of accessors) if (accessor && accessor.listParents().every((parent) => parent.propertyType === "Root")) accessor.dispose();
      }
    }
    await withLightingAttributes(part.document);
    finished.push((await storeAssetObject(root, { bytes: await io.writeBinary(part.document), kind: "scene", mediaType: "model/gltf-binary" })).asset);
  }

  log("measure the descriptor");
  const tan = Math.tan((KIT_LOD_REFERENCE_FOV_Y / 2) * Math.PI / 180);
  const lodsOf = (levels: Built[]) => {
    const bounds = documentBounds(levels[0]!.document);
    const radius = round(Math.hypot(...[0, 1, 2].map((k) => bounds.max[k]! - bounds.min[k]!)) / 2);
    const distances = scaledLodDistances(ROBOT_LOD_DISTANCES, bounds);
    return {
      boundingSphere: { center: [0, 1, 2].map((k) => round((bounds.min[k]! + bounds.max[k]!) / 2)), radius },
      levels: levels.map((level, index) => {
        const distance = distances[index];
        return { variant: bundleVariant(level.variant, level.level), triangles: triangles(level.document), minScreenSize: distance ? round(Number((radius / (distance * tan)).toFixed(4))) : 0, referenceMaxDistance: distance ?? null };
      }),
    };
  };
  const parts = ROBOT_PARTS.map((part) => {
    const of = (variant: string) => built.filter((b) => b.part === part && b.variant === variant);
    const full = of("default")[0]!;
    const bounds = documentBounds(full.document);
    const sockets = partSockets(part.cells, SOCKET_FACES[part.sockets]);
    const mountFrame = faceFrame("NegZ");
    return {
      key: part.key, kind: part.kind, cells: part.cells, socketFaces: [...SOCKET_FACES[part.sockets]],
      cuboid: partCuboid(part.cells), bounds, triangles: triangles(full.document),
      mount: { position: [0, 0, 0], normal: partToGltf(mountFrame.normal), uAxis: [1, 0, 0], vAxis: [0, 0, -1] },
      socketCount: sockets.length, sockets,
      joints: ROBOT_JOINTS[part.key]?.joints ?? [], anchors: ROBOT_JOINTS[part.key]?.anchors ?? [],
      hitProxies: [{ name: "body", tag: "hit-proxy", center: [0, 1, 2].map((k) => round((bounds.min[k]! + bounds.max[k]!) / 2)), size: [0, 1, 2].map((k) => round(bounds.max[k]! - bounds.min[k]!)) }],
      lods: lodsOf(of("default")),
      variants: Object.fromEntries(part.variants.filter((v) => v !== "default").map((variant) => [variant, { lods: lodsOf(of(variant)) }])),
    };
  });
  const descriptor = {
    schema: ROBOT_DESCRIPTOR_SCHEMA, kit: ROBOT_RELEASE, ...socketGridConvention(),
    lodSelection: {
      metric: "projected-bounding-sphere-height-fraction", referenceFovYDegrees: KIT_LOD_REFERENCE_FOV_Y,
      rule: "Use the first level whose minScreenSize is at most the asset's projected bounding-sphere diameter divided by the viewport height (radius / (distance * tan(fovY / 2)), scaled by the instance scale). referenceMaxDistance is the distance in metres at which that level ends for an unscaled instance at referenceFovYDegrees.",
    },
    authority: "Shooter owns part IDs and footprints, hit state, damage, collision, motion, attachment legality and assembly. hitProxies are non-authoritative visual bounds.",
    parts,
    compositions: Object.entries(ROBOT_COMPOSITIONS).map(([name, { note, items }]) => ({
      name, note, items: resolveComposition(items).map(({ transform: _transform, ...item }) => item),
    })),
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: ROBOT_DESCRIPTOR_ATTACHMENT, mediaType: "application/json" })).asset;

  log("encode the atlas as KTX2 (ktx create)");
  const delivered = await ktx2Assets(root, ROBOT_RELEASE, finished);
  const selections = built.map((part, index) => ({ key: part.part.key, variant: bundleVariant(part.variant, part.level), ...(index === 0 ? { attachments: [{ name: ROBOT_DESCRIPTOR_ATTACHMENT }] } : {}) }));
  const packed = await exportKitBundle(root, {
    tarName: ROBOT_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(built.map((part) => [`${part.part.key}#${bundleVariant(part.variant, part.level)}`, part.document])) as Record<string, Document>,
    lineage: {
      recipe: { script: "adapters/blender/combat_robot.py", sha256: source.sha256, common: { script: "adapters/blender/kit_common.py", sha256: common.sha256 }, blenderVersion: source.blenderVersion },
      release: ROBOT_RELEASE, descriptor: descriptorAsset,
    },
  };
}

if (import.meta.main) await runKitCli("scripts/build-combat-robot.ts", ROBOT_RELEASE, buildCombatRobot, { descriptorFile: true });
