// Build the Shooter robot locomotion kit (docs/robot-locomotion.md, #634) from the scripted recipe
// adapters/blender/robot_locomotion.py, the companion of the robot part kit (#595) and the weapon kit (#594) on the same
// socket-grid convention:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-robot-locomotion.ts [--textures full|half] --out <directory>
// Each part's variant and level is one external.blender.script@1 run, imported through scene.import.gltf@2, all on one
// atlas. The descriptor (socket-grid-kit-descriptor-v3) carries the axles (where Shooter's mechanics turn the wheels),
// the belt, the roll clip and review builds on the robot and weapon kits' parts. No game places the kit yet.
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
  IDENTITY, IDENTITY_TRANSFORM, QUARTER_TURN, SOCKET_FACES, compose, faceFrame, mountTransform, partCuboid, partSockets, partToGltf, quaternion,
  type Face, type Orientation, type Transform, type Vec3,
} from "../src/socket-grid.ts";
import { withLightingAttributes } from "./baked-rock-kit.ts";
import { ROBOT_PARTS, ROBOT_RELEASE, socketGridConvention, type RobotJoint } from "./build-combat-robot.ts";
import { WEAPONS_RELEASE, WEAPON_PARTS } from "./build-shooter-weapons.ts";

/** One rolling release (Atlas Decision 7.1.5), never numbered: separate from the robot kit, which is at its 2 MB budget. */
export const LOCOMOTION_RELEASE = "shooter-robot-locomotion";
export const LOCOMOTION_TAR_NAME = "shooter-robot-locomotion.kit.tar";
export const LOCOMOTION_MATERIAL = "locomotion-metal";
export const LOCOMOTION_DESCRIPTOR_SCHEMA = "socket-grid-kit-descriptor-v3";
export const LOCOMOTION_DESCRIPTOR_ATTACHMENT = "socket-grid-descriptor";
/** Full-detail triangle ceiling per part, as for the robot parts and weapons. */
export const LOCOMOTION_TRIANGLE_BUDGET = 2000;
export const LOCOMOTION_LOD_DISTANCES = [60, 180] as const;
const VALIDATOR_WARNINGS = ["MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"];
const LEVELS = [0, 1, 2] as const;
const VARIANTS = ["default", "damaged"] as const;

export type LocomotionPart = { key: string; kind: "locomotion"; type: "wheel" | "track"; cells: [number, number, number] };

/**
 * The parts, exactly as Shooter's catalog declares them (crates/shooter-sim/src/robot.rs `parts::WHEEL`, `parts::TRACK`:
 * Kind::Locomotion, no sockets).
 */
export const LOCOMOTION_PARTS: readonly LocomotionPart[] = [
  { key: "robot.wheel", kind: "locomotion", type: "wheel", cells: [2, 2, 1] },
  { key: "robot.track", kind: "locomotion", type: "track", cells: [1, 4, 2] },
];

// The recipe's geometry (adapters/blender/robot_locomotion.py), in the part frame (x, y, z; metres from the mount anchor).
/** Shooter's wheel: a sphere of half the 40 cm footprint less a 2 cm inset, at the cuboid's centre (mechanics.rs). */
export const WHEEL_AXLE_PART: Vec3 = [0.1, 0.1, 0.1];
export const WHEEL_ROLLING_RADIUS = 0.18;
/** Shooter's track: two road wheels of radius min(x, z) / 2 = 0.1 m at y = radius and y = length - radius, mid-height. */
export const TRACK_ROLLING_RADIUS = 0.1;
export const TRACK_AXLES_PART: readonly Vec3[] = [[0, 0, 0.2], [0, 0.6, 0.2]];
export const TRACK_WHEELS = [["sprocket", 0], ["road-1", 0.15], ["road-2", 0.3], ["road-3", 0.45], ["idler", 0.6]] as const;
export const TRACK_LINKS = 25;
export const PITCHES_PER_TURN = 9;
export const TRACK_PITCH = (2 * Math.PI * TRACK_ROLLING_RADIUS) / PITCHES_PER_TURN;
export const TRACK_PITCH_RADIUS = (TRACK_LINKS * TRACK_PITCH - 2 * 0.6) / (2 * Math.PI);
export const ROLL_SECONDS = 1;
const linkNodes = Array.from({ length: TRACK_LINKS }, (_, i) => `link-${String(i + 1).padStart(2, "0")}`);
const AXIS: Vec3 = [0, 1, 0]; // the part's +z: the mount normal, every axle's direction

/** Shooter's joints: each axle Shooter's mechanics turns, at its body's centre, about the part's mount normal. */
export const LOCOMOTION_JOINTS: Readonly<Record<string, RobotJoint[]>> = {
  "robot.wheel": [{ name: "wheel", kind: "wheel", node: "wheel", origin: partToGltf(WHEEL_AXLE_PART), axis: AXIS }],
  "robot.track": [
    { name: "sprocket", kind: "track-wheel", node: "sprocket", origin: partToGltf(TRACK_AXLES_PART[0]!), axis: AXIS },
    { name: "idler", kind: "track-wheel", node: "idler", origin: partToGltf(TRACK_AXLES_PART[1]!), axis: AXIS },
  ],
};

/** The locomotion block of each part (schema v3): Shooter's bodies, the visual wheels, the belt and how to drive the roll clip. */
export function locomotionOf(part: LocomotionPart) {
  const roll = {
    animation: "roll", seconds: ROLL_SECONDS, radiansPerCycle: round(2 * Math.PI),
    rule: "The clip turns every wheel node one full turn about the axis (and moves the belt to match). To follow a drive, set the clip time to (angle mod 2 pi) / radiansPerCycle * seconds, where angle is Shooter's joint angle; or turn the wheel nodes by the angle directly.",
  };
  if (part.type === "wheel") {
    return {
      type: "wheel" as const, axis: AXIS, rollingRadius: WHEEL_ROLLING_RADIUS,
      bodies: [{ joint: "wheel", node: "wheel", centre: partToGltf(WHEEL_AXLE_PART), radius: WHEEL_ROLLING_RADIUS }],
      wheels: ["wheel"], roll,
      shooter: "mechanics.rs Locomotion::Wheel: one sphere of radius 0.18 m (min(x, y) / 2 - WHEEL_INSET) at the cuboid's centre on a revolute joint about the part's mount normal, no limits. The tyre's tread is at that radius.",
    };
  }
  return {
    type: "track" as const, axis: AXIS, rollingRadius: TRACK_ROLLING_RADIUS,
    bodies: LOCOMOTION_JOINTS[part.key]!.map((joint) => ({ joint: joint.name, node: joint.node, centre: joint.origin, radius: TRACK_ROLLING_RADIUS })),
    wheels: TRACK_WHEELS.map(([name]) => name),
    tread: {
      links: linkNodes, pitch: round(TRACK_PITCH), pitchRadius: round(TRACK_PITCH_RADIUS), outerRadius: 0.0985,
      length: round(TRACK_LINKS * TRACK_PITCH), centres: TRACK_AXLES_PART.map((p) => partToGltf(p)),
      metresPerRadian: TRACK_ROLLING_RADIUS, linksPerTurn: PITCHES_PER_TURN,
      rule: "The belt is a stadium round the two driven axles in the part's x-y plane (glTF X and -Z), the links' pivots on it at pitchRadius. A positive wheel angle about the axis moves the belt anticlockwise seen from the axis (along the part's +y on its +x side): metresPerRadian metres a radian, linksPerTurn links a turn, so the roll clip loops seamlessly. A link's node carries it; the clip moves each link along the path and turns it with the path's tangent.",
    },
    roll,
    shooter: "mechanics.rs Locomotion::Track: two spheres of radius 0.1 m (min(x, z) / 2) at y = 0.1 and 0.7 m from the cuboid's corner, mid-width and mid-height, each on a revolute joint about the part's mount normal with the same drive. The sprocket and idler nodes turn on those axles; the belt's outer face touches the same 0.1 m circles (0.0985 m at the grousers).",
  };
}

export const bundleVariant = (variant: string, level: number) => level === 0 ? variant : variant === "default" ? `lod${level}` : `${variant}-lod${level}`;

export function createLocomotionSpec({ part, level, variant, scriptSha256, commonSha256, robotSha256, blenderVersion }: {
  part: LocomotionPart; level: number; variant: string; scriptSha256: string; commonSha256: string; robotSha256: string; blenderVersion: string;
}) {
  return blenderScriptSpec({
    assetId: part.key,
    inputs: { script: { path: "robot_locomotion.py", sha256: scriptSha256 }, common: { path: "kit_common.py", sha256: commonSha256 }, robot: { path: "combat_robot.py", sha256: robotSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, part: part.key, cells: part.cells, level, variant }, output: "locomotion.glb",
  });
}

// ---------------------------------------------------------------- review builds

type Mount = { face: Face; u: number; v: number; orientation?: Orientation };
type Item = { id: string; key: string; variant?: string; parent?: string; mount?: Mount; translation?: Vec3; orientation?: Orientation };
const GROUND = { normal: [0, 1, 0] as Vec3, uAxis: [1, 0, 0] as Vec3, vAxis: [0, 0, -1] as Vec3 };
const yaw = (quarters: number): Orientation => ({ ...IDENTITY, yaw: quarters * QUARTER_TURN });
const L = "robot.chassis.40x60x80";

/** Shooter's wheeled fixtures (crates/shooter-sim/src/mechanics/fixtures.rs `wheeled`): the large chassis on end, a sensor
 * on top where the retired core sat (shooter#89), four wheels hanging over the bottom corners of two opposite faces. */
function wheeled(sideways: boolean, lift: number): Item[] {
  const [left, right]: Face[] = sideways ? ["PosX", "NegX"] : ["PosY", "NegY"];
  const [secondLeft, secondRight, quarterLeft, quarterRight] = sideways ? [[2, 0], [0, 2], 3, 1] as const : [[0, 1], [1, 0], 1, 3] as const;
  return [
    { id: "chassis", key: L, translation: [-0.1, lift, 0.1] },
    { id: "sensor", key: "robot.sensor", parent: "chassis", mount: { face: "PosZ", u: 0, v: 0 } },
    { id: "wheel-left-rear", key: "robot.wheel", parent: "chassis", mount: { face: left, u: 0, v: 0, orientation: yaw(2) } },
    { id: "wheel-left-front", key: "robot.wheel", parent: "chassis", mount: { face: left, u: secondLeft[0], v: secondLeft[1], orientation: yaw(quarterLeft) } },
    { id: "wheel-right-rear", key: "robot.wheel", parent: "chassis", mount: { face: right, u: 0, v: 0, orientation: yaw(2) } },
    { id: "wheel-right-front", key: "robot.wheel", parent: "chassis", mount: { face: right, u: secondRight[0], v: secondRight[1], orientation: yaw(quarterRight) } },
  ];
}

/** The large chassis lying along +X as a hull (40 cm tall, 60 wide, its bottom on the ground). */
function hull(): Item[] {
  return [
    { id: "hull", key: L, translation: [-0.4, 0.3, 0.2], orientation: { yaw: 0, pitch: QUARTER_TURN, roll: 0 } },
  ];
}

/**
 * Review builds. `biped` is Shooter's humanoid frame on the robot kit's legs, for comparison; `wheeler` and `strafer` are
 * Shooter's `car` and `strafer` fixtures exactly (wheels on the sides, then on the front and back: the unusual mounting
 * that drives it sideways), the wheeler with a grapple added; `mini-tank` lays the large chassis on two tracks on
 * its sides (their axles across the hull) under a rotor, hinge and rail-gun turret; `crab` carries its tracks on the
 * hull's ends, overhanging, so it crawls sideways.
 */
export const LOCOMOTION_COMPOSITIONS: Record<string, { note: string; items: Item[] }> = {
  biped: {
    note: "For comparison: Shooter's humanoid frame on the small chassis (robot.rs `frame`) on the robot kit's legs, with the rifle and the grapple.",
    items: [
      { id: "torso", key: "robot.chassis.20x40x80", translation: [0, 0.8, 0] },
      { id: "sensor", key: "robot.sensor", parent: "torso", mount: { face: "PosZ", u: 0, v: 0 } },
      { id: "arm-left", key: "robot.beam.20x20x80", parent: "torso", mount: { face: "PosY", u: 3, v: 0 } },
      { id: "arm-right", key: "robot.beam.20x20x80", parent: "torso", mount: { face: "NegY", u: 0, v: 3 } },
      { id: "leg-left", key: "robot.leg", parent: "torso", mount: { face: "NegZ", u: 0, v: 0 } },
      { id: "leg-right", key: "robot.leg", parent: "torso", mount: { face: "NegZ", u: 1, v: 0 } },
      { id: "rifle", key: "weapon.energy-rifle", parent: "arm-left", mount: { face: "PosZ", u: 0, v: 0 } },
      { id: "grapple", key: "weapon.grapple-hook", parent: "torso", mount: { face: "PosZ", u: 0, v: 1 } },
    ],
  },
  wheeler: {
    note: "Shooter's `car` fixture exactly (the large chassis on end, a sensor on top where the retired core sat, four wheels hanging over the bottom corners of its sides, axles across), plus the grapple on its front.",
    items: [...wheeled(false, 0.2 - 0.02), { id: "grapple", key: "weapon.grapple-hook", parent: "chassis", mount: { face: "PosX", u: 0, v: 3 } }],
  },
  strafer: {
    note: "Shooter's `strafer` fixture exactly: the same four wheels on the chassis' front and back, axles along its length, so the same drive moves it sideways. The unusual wheel mounting.",
    items: wheeled(true, 0.2 - 0.02),
  },
  "mini-tank": {
    note: "A low tank: the large chassis lying along +X (40 cm tall, 60 wide) with a track on each side over its lower cell row (axles across the hull, the belt's bottom flush with the hull's), a rotor, riser and hinge carrying the rail gun, a sensor and the grapple on the front.",
    items: [
      ...hull(),
      { id: "track-left", key: "robot.track", parent: "hull", mount: { face: "PosY", u: 0, v: 1, orientation: yaw(-1) } },
      { id: "track-right", key: "robot.track", parent: "hull", mount: { face: "NegY", u: 1, v: 0 } },
      { id: "rotor", key: "robot.joint.rotor", parent: "hull", mount: { face: "NegX", u: 1, v: 1 } },
      { id: "riser", key: "robot.beam.20x20x40", parent: "rotor", mount: { face: "PosZ", u: 0, v: 0 } },
      { id: "elevation", key: "robot.joint.hinge", parent: "riser", mount: { face: "PosX", u: 0, v: 1 } },
      { id: "rail-gun", key: "weapon.rail-gun", parent: "elevation", mount: { face: "PosZ", u: 0, v: 0 } },
      { id: "sensor", key: "robot.sensor", parent: "hull", mount: { face: "NegX", u: 3, v: 0 } },
      { id: "grapple", key: "weapon.grapple-hook", parent: "hull", mount: { face: "PosZ", u: 0, v: 1 } },
    ],
  },
  crab: {
    note: "An unusual track mounting: the same hull with its tracks on its front and back ends instead, axles along the hull and each track overhanging the 60 cm end by a cell, so its drive crawls it sideways; a sensor and the grapple on the deck.",
    items: [
      ...hull(),
      { id: "track-front", key: "robot.track", parent: "hull", mount: { face: "PosZ", u: 1, v: 0 } },
      { id: "track-back", key: "robot.track", parent: "hull", mount: { face: "NegZ", u: 0, v: 1, orientation: yaw(-1) } },
      { id: "sensor", key: "robot.sensor", parent: "hull", mount: { face: "NegX", u: 3, v: 1 } },
      { id: "grapple", key: "weapon.grapple-hook", parent: "hull", mount: { face: "NegX", u: 1, v: 1 } },
    ],
  },
};

const ROBOT_KEYS = new Set(ROBOT_PARTS.map((part) => part.key));
const WEAPON_KEYS = new Set(WEAPON_PARTS.map((part) => part.key));
const allTypes = () => new Map<string, { key: string; cells: readonly number[]; sockets: keyof typeof SOCKET_FACES }>([
  ...ROBOT_PARTS, ...WEAPON_PARTS.map((part) => ({ ...part, sockets: "NONE" as const })), ...LOCOMOTION_PARTS.map((part) => ({ ...part, sockets: "NONE" as const })),
].map((part) => [part.key, part]));

/** Each item's part type, socket, kit and placement (translation, quaternion) in the build's glTF frame. */
export function resolveBuild(items: readonly Item[]) {
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
    const kit = ROBOT_KEYS.has(item.key) ? ROBOT_RELEASE : WEAPON_KEYS.has(item.key) ? WEAPONS_RELEASE : undefined;
    return {
      id: item.id, key: item.key, ...(kit ? { kit } : {}), variant: item.variant ?? "default",
      ...(item.parent ? { parent: item.parent, socket, face: item.mount!.face, u: item.mount!.u, v: item.mount!.v, orientation: item.mount!.orientation ?? IDENTITY } : {}),
      ...(!item.parent && item.orientation ? { orientation: item.orientation } : {}),
      translation: transform.translation.map(round) as Vec3, rotation: quaternion(transform.rotation),
      transform,
    };
  });
}

// ---------------------------------------------------------------- build

type Built = KitPart & { part: LocomotionPart; variant: string; level: number };

/** Drop animation channels that never leave the node's rest value (the exporter samples every bone). */
function pruneStaticChannels(document: Document) {
  for (const animation of document.getRoot().listAnimations()) {
    for (const channel of animation.listChannels()) {
      const node = channel.getTargetNode(), path = channel.getTargetPath(), output = channel.getSampler()?.getOutput();
      if (!node || !output || !path) continue;
      const rest = path === "translation" ? node.getTranslation() : path === "rotation" ? node.getRotation() : path === "scale" ? node.getScale() : null;
      if (!rest) continue;
      let moves = false;
      for (let i = 0; i < output.getCount() && !moves; i += 1) moves = output.getElement(i, []).some((c, k) => Math.abs(c - rest[k]!) > 1e-6);
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

export async function buildRobotLocomotion({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("robot_locomotion.py");
  const common = await readBlenderRecipeSource("kit_common.py");
  const robot = await readBlenderRecipeSource("combat_robot.py");
  const built: Built[] = [];
  for (const part of LOCOMOTION_PARTS) for (const variant of VARIANTS) for (const level of LEVELS) {
    log(`generate ${part.key} ${bundleVariant(variant, level)}`);
    built.push({ part, variant, level, ...await buildKitPart(root, {
      workspace: path.join(root, "parts", `${part.key}.${bundleVariant(variant, level)}`), allowedValidatorWarnings: VALIDATOR_WARNINGS,
      files: { "robot_locomotion.py": source.bytes, "kit_common.py": common.bytes, "combat_robot.py": robot.bytes },
      spec: createLocomotionSpec({ part, level, variant, scriptSha256: source.sha256, commonSha256: common.sha256, robotSha256: robot.sha256, blenderVersion: source.blenderVersion }),
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
      if ((atlas.get(name) ?? sha) !== sha) throw new Error(`${part.part.key} ${part.variant} ${part.level}: texture '${name}' differs from the shared atlas`);
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
    const distances = scaledLodDistances(LOCOMOTION_LOD_DISTANCES, bounds);
    return {
      boundingSphere: { center: [0, 1, 2].map((k) => round((bounds.min[k]! + bounds.max[k]!) / 2)), radius },
      levels: levels.map((level, index) => {
        const distance = distances[index];
        return { variant: bundleVariant(level.variant, level.level), triangles: triangles(level.document), minScreenSize: distance ? round(Number((radius / (distance * tan)).toFixed(4))) : 0, referenceMaxDistance: distance ?? null };
      }),
    };
  };
  const mountFrame = { position: [0, 0, 0], normal: partToGltf(faceFrame("NegZ").normal), uAxis: [1, 0, 0], vAxis: [0, 0, -1] };
  const parts = LOCOMOTION_PARTS.map((part) => {
    const of = (variant: string) => built.filter((b) => b.part === part && b.variant === variant);
    const full = of("default")[0]!;
    const bounds = documentBounds(full.document);
    const roll = full.document.getRoot().listAnimations().find((animation) => animation.getName() === "roll");
    if (!roll) throw new Error(`${part.key}: no roll animation`);
    return {
      key: part.key, kind: part.kind, cells: part.cells, socketFaces: [], cuboid: partCuboid(part.cells), bounds, triangles: triangles(full.document),
      mount: mountFrame, socketCount: 0, sockets: [],
      joints: LOCOMOTION_JOINTS[part.key]!, anchors: [],
      hitProxies: [{ name: "body", tag: "hit-proxy", center: [0, 1, 2].map((k) => round((bounds.min[k]! + bounds.max[k]!) / 2)), size: [0, 1, 2].map((k) => round(bounds.max[k]! - bounds.min[k]!)) }],
      lods: lodsOf(of("default")),
      variants: { damaged: { lods: lodsOf(of("damaged")) } },
      states: [{ name: "roll", animation: "roll", loop: true, seconds: ROLL_SECONDS, use: "roll", nodes: [...new Set(roll.listChannels().map((channel) => channel.getTargetNode()!.getName()))].sort() }],
      locomotion: locomotionOf(part),
    };
  });
  const descriptor = {
    schema: LOCOMOTION_DESCRIPTOR_SCHEMA, kit: LOCOMOTION_RELEASE, ...socketGridConvention(),
    lodSelection: {
      metric: "projected-bounding-sphere-height-fraction", referenceFovYDegrees: KIT_LOD_REFERENCE_FOV_Y,
      rule: "Use the first level whose minScreenSize is at most the asset's projected bounding-sphere diameter divided by the viewport height (radius / (distance * tan(fovY / 2)), scaled by the instance scale). referenceMaxDistance is the distance in metres at which that level ends for an unscaled instance at referenceFovYDegrees.",
    },
    authority: "Shooter owns the part IDs and footprints, which wheels and tracks drive, their torque, rates, energy, contacts, collision, motion, damage, detachment and assembly. Joints and bodies here repeat where Shooter's mechanics put the axles, so the visuals line up; hitProxies are non-authoritative visual bounds.",
    locomotionRule: "A wheel or track turns about its part's mount normal (glTF +Y in the part frame), at the joints' origins, exactly as Shooter's mechanics model it: nothing is corrected for the mount's direction, so the same angle turns wheels on opposite sides opposite ways in the robot's frame. Detached and damaged: a lost part is the same entry falling free (every level is closed), and `damaged` (with its LODs) is the part after hits, with the same nodes and clip.",
    sources: "Original geometry and procedurally painted textures from the recipe (adapters/blender/robot_locomotion.py on the robot kit's Part builder); no third-party assets.",
    parts,
    compositions: Object.entries(LOCOMOTION_COMPOSITIONS).map(([name, { note, items }]) => ({
      name, note, items: resolveBuild(items).map(({ transform: _t, ...item }) => item),
    })),
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: LOCOMOTION_DESCRIPTOR_ATTACHMENT, mediaType: "application/json" })).asset;

  log("encode the atlas as KTX2 (ktx create)");
  const delivered = await ktx2Assets(root, LOCOMOTION_RELEASE, finished);
  const selections = built.map((part, index) => ({ key: part.part.key, variant: bundleVariant(part.variant, part.level), ...(index === 0 ? { attachments: [{ name: LOCOMOTION_DESCRIPTOR_ATTACHMENT }] } : {}) }));
  const packed = await exportKitBundle(root, {
    tarName: LOCOMOTION_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(built.map((part) => [`${part.part.key}#${bundleVariant(part.variant, part.level)}`, part.document])) as Record<string, Document>,
    lineage: {
      recipe: {
        script: "adapters/blender/robot_locomotion.py", sha256: source.sha256, common: { script: "adapters/blender/kit_common.py", sha256: common.sha256 },
        robot: { script: "adapters/blender/combat_robot.py", sha256: robot.sha256 }, blenderVersion: source.blenderVersion,
      },
      release: LOCOMOTION_RELEASE, descriptor: descriptorAsset,
    },
  };
}

if (import.meta.main) await runKitCli("scripts/build-robot-locomotion.ts", LOCOMOTION_RELEASE, buildRobotLocomotion, { descriptorFile: true });
