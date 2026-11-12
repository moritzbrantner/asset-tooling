// The shared `quadruped-rigid` profile (#128, Atlas Decisions 8.1.2 and 8.1.4, docs/quadruped-rigid.md): an animated
// animal built from named rigid parts on pivoted transform nodes, with no skin. It validates what such an asset must
// carry to be packaged (rig, clips, bounds), for any species. It holds no game behaviour, placement or physics.
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { NodeIO, type Animation, type Document, type Node } from "@gltf-transform/core";
import { GLTF_RESOURCES_BUNDLE_ALLOWED_VALIDATOR_WARNINGS, GLTF_RESOURCES_BUNDLE_PROFILE, parseGltfResourcesBundleManifest, readAssetBundleGltf } from "./asset-bundle.js";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { canonicalJson } from "./canonical.js";
import { executeGltfProductionImportOperation } from "./gltf-production-operations.js";
import { documentBounds, exportKitBundle, round, single, triangles, type Vec3 } from "./kit-bundle.js";
import type { AssetRef } from "./operations.js";

export const QUADRUPED_RIGID_PROFILE = "quadruped-rigid";
export const QUADRUPED_RIGID_ROOT = "animal_root";
export const QUADRUPED_RIGID_LEGS = ["leg_0", "leg_1", "leg_2", "leg_3"] as const;
/** The joints every quadruped carries. A species may add its own, such as the giraffe's `neck`. */
export const QUADRUPED_RIGID_JOINTS = [QUADRUPED_RIGID_ROOT, "body", "head", "tail", ...QUADRUPED_RIGID_LEGS] as const;
/**
 * The rules a rigid animal profile varies (#605): its name, the joints every animal of it carries and the legs its
 * `walk` must swing. `quadruped-rigid` and its two-legged sibling `biped-rigid` (src/biped-rigid.ts) share the rest.
 */
export type RigidAnimalProfile = { name: string; joints: readonly string[]; legs: readonly string[] };
export const QUADRUPED_RIGID: RigidAnimalProfile = { name: QUADRUPED_RIGID_PROFILE, joints: QUADRUPED_RIGID_JOINTS, legs: QUADRUPED_RIGID_LEGS };
export const QUADRUPED_RIGID_CLIPS = ["idle", "walk"] as const;
/**
 * Optional activity clips (#589). They are not required, but a clip with one of these names is checked like
 * `walk`: it stays in place, because the consumer positions the animal.
 */
export const QUADRUPED_RIGID_ACTIVITY_CLIPS = ["feed", "rest"] as const;
/** Metres. The rest pose may float up to this far from the ground plane y = 0. */
export const QUADRUPED_RIGID_GROUND_TOLERANCE = 0.01;
/** Each rest-pose extent must fall in this range, in metres. */
export const QUADRUPED_RIGID_EXTENT = { min: 0.05, max: 8 };
/** Largest net horizontal root travel of `walk` that still counts as in place, in metres. */
export const QUADRUPED_RIGID_MAX_WALK_TRAVEL = 0.001;
/** How far a leg's pivot may sit from the top of its own mesh (its hip), in metres. */
export const QUADRUPED_RIGID_LEG_PIVOT_TOLERANCE = 0.02;
const MIN_CHANNEL_MOTION = 1e-3;
const MIN_LEG_SWING = 0.01;

export type QuadrupedRigidObservations = {
  profile: string;
  joints: string[];
  rigidParts: number;
  triangles: number;
  materials: number;
  bounds: { min: Vec3; max: Vec3 };
  size: { width: number; depth: number; height: number };
  /** `lowestPoint` is the lowest y of any mesh over the clip, sampled at 30 Hz: how far it dips into the ground. */
  clips: Record<string, { seconds: number; channels: string[]; lowestPoint?: number; walkTravel?: number; travel?: number }>;
};

function subtree(node: Node, seen = new Set<Node>()): Set<Node> {
  seen.add(node);
  for (const child of node.listChildren()) subtree(child, seen);
  return seen;
}

function hasGeometry(node: Node): boolean {
  return [...subtree(node)].some((part) => part.getMesh() !== null);
}

/** The range of one output component over the sampler's keys. */
function ranges(values: ArrayLike<number>, size: number): number[] {
  const low = new Array<number>(size).fill(Infinity), high = new Array<number>(size).fill(-Infinity);
  for (let index = 0; index < values.length; index += 1) {
    const component = index % size;
    low[component] = Math.min(low[component]!, values[index]!);
    high[component] = Math.max(high[component]!, values[index]!);
  }
  return high.map((value, component) => value - low[component]!);
}

/** The per-clip checks of the profile: named, finite, targeting rig nodes, with no duplicate or morph channels. */
function checkClip(animation: Animation, rig: Set<Node>, issues: string[]): { seconds: number; channels: string[] } {
  const name = animation.getName();
  const channels = animation.listChannels();
  if (channels.length === 0) issues.push(`clip '${name}' has no channels`);
  const seen = new Set<string>();
  let seconds = 0;
  for (const channel of channels) {
    const target = channel.getTargetNode();
    const channelPath = channel.getTargetPath();
    if (!target) { issues.push(`clip '${name}' has a channel with no target node`); continue; }
    if (!rig.has(target)) issues.push(`clip '${name}' targets node '${target.getName()}' outside the rig`);
    if (channelPath === "weights") issues.push(`clip '${name}' animates morph weights on '${target.getName()}', which a rigid rig has no use for`);
    else if (channelPath !== "translation" && channelPath !== "rotation" && channelPath !== "scale") issues.push(`clip '${name}' has a channel with no target path on '${target.getName()}'`);
    const label = `${target.getName()}.${channelPath}`;
    if (seen.has(label)) issues.push(`clip '${name}' animates '${label}' twice`);
    seen.add(label);
    const sampler = channel.getSampler();
    const times = sampler?.getInput()?.getArray();
    const output = sampler?.getOutput()?.getArray();
    if (!times || !output || times.length < 2) { issues.push(`clip '${name}' channel '${label}' needs at least two keys`); continue; }
    if ([...times, ...output].some((value) => !Number.isFinite(value))) issues.push(`clip '${name}' channel '${label}' has non-finite keys`);
    if ([...times].some((time, index) => index > 0 && time <= times[index - 1]!)) issues.push(`clip '${name}' channel '${label}' key times do not increase`);
    seconds = Math.max(seconds, times[times.length - 1]!);
  }
  if (seconds <= 0) issues.push(`clip '${name}' has no duration`);
  return { seconds: round(seconds), channels: [...seen].sort() };
}

function channelMotion(animation: Animation, name: string, channelPath: string): number[] | null {
  for (const channel of animation.listChannels()) {
    if (channel.getTargetNode()?.getName() !== name || channel.getTargetPath() !== channelPath) continue;
    const output = channel.getSampler()?.getOutput();
    if (output) return ranges(output.getArray()!, output.getElementSize());
  }
  return null;
}

/** Net horizontal travel from the first to the last key of the translation of `name`, or 0 when it has none. */
function horizontalTravel(animation: Animation, name: string): number {
  for (const channel of animation.listChannels()) {
    if (channel.getTargetNode()?.getName() !== name || channel.getTargetPath() !== "translation") continue;
    const values = channel.getSampler()?.getOutput()?.getArray();
    if (!values || values.length < 6) return 0;
    return Math.hypot(values[values.length - 3]! - values[0]!, values[values.length - 1]! - values[2]!);
  }
  return 0;
}

/** The value of a LINEAR or STEP sampler at `time`, clamped to its keys; rotations are slerped. */
function sampleAt(times: ArrayLike<number>, values: ArrayLike<number>, size: number, interpolation: string, time: number, rotation: boolean): number[] {
  const at = (index: number) => Array.from({ length: size }, (_, k) => values[index * size + k]!);
  const last = times.length - 1;
  if (time <= times[0]!) return at(0);
  if (time >= times[last]!) return at(last);
  let index = 0;
  while (index < last - 1 && times[index + 1]! <= time) index += 1;
  if (interpolation === "STEP") return at(index);
  const a = at(index), b = at(index + 1);
  const u = (time - times[index]!) / (times[index + 1]! - times[index]!);
  if (!rotation) return a.map((value, k) => value + (b[k]! - value) * u);
  let dot = a.reduce((sum, value, k) => sum + value * b[k]!, 0);
  const target = dot < 0 ? b.map((value) => -value) : b;
  dot = Math.abs(dot);
  if (dot > 0.9995) {
    const mixed = a.map((value, k) => value + (target[k]! - value) * u);
    const length = Math.hypot(...mixed);
    return mixed.map((value) => value / length);
  }
  const theta = Math.acos(dot), sin = Math.sin(theta);
  const wa = Math.sin((1 - u) * theta) / sin, wb = Math.sin(u * theta) / sin;
  return a.map((value, k) => value * wa + target[k]! * wb);
}

/**
 * Pose `document` at `time` of `animation`, call `measure`, and restore the rest pose. Only LINEAR and STEP
 * samplers are evaluated; a CUBICSPLINE channel throws, because a rigid rig has no use for one here.
 */
export function withClipPose<T>(document: Document, animation: Animation, time: number, measure: () => T): T {
  const saved = document.getRoot().listNodes().map((node) => [node, node.getTranslation(), node.getRotation(), node.getScale()] as const);
  try {
    for (const channel of animation.listChannels()) {
      const node = channel.getTargetNode(), sampler = channel.getSampler();
      const input = sampler?.getInput()?.getArray(), output = sampler?.getOutput();
      if (!node || !sampler || !input || !output) continue;
      const interpolation = sampler.getInterpolation();
      if (interpolation === "CUBICSPLINE") throw new Error(`clip '${animation.getName()}' uses CUBICSPLINE on '${node.getName()}'`);
      const channelPath = channel.getTargetPath();
      const value = sampleAt(input, output.getArray()!, output.getElementSize(), interpolation, time, channelPath === "rotation");
      if (channelPath === "translation") node.setTranslation(value as Vec3);
      else if (channelPath === "rotation") node.setRotation(value as [number, number, number, number]);
      else if (channelPath === "scale") node.setScale(value as Vec3);
    }
    return measure();
  } finally {
    for (const [node, translation, rotation, scale] of saved) node.setTranslation(translation).setRotation(rotation).setScale(scale);
  }
}

/** Samples per second when a clip is walked through for its ground contact. */
const CLIP_SAMPLE_RATE = 30;

/** The lowest point of any mesh over `animation`, sampled at CLIP_SAMPLE_RATE and at its last key. */
export function clipLowestPoint(document: Document, animation: Animation): number {
  const end = Math.max(0, ...animation.listChannels().map((channel) => {
    const times = channel.getSampler()?.getInput()?.getArray();
    return times && times.length > 0 ? times[times.length - 1]! : 0;
  }));
  const steps = Math.max(1, Math.ceil(end * CLIP_SAMPLE_RATE));
  let lowest = Infinity;
  for (let step = 0; step <= steps; step += 1) {
    lowest = Math.min(lowest, withClipPose(document, animation, (end * step) / steps, () => documentBounds(document).min[1]));
  }
  return round(lowest);
}

/** Every way `document` breaks `profile`, and the measurements the descriptor records. */
export function inspectRigidAnimal(document: Document, profile: RigidAnimalProfile): { issues: string[]; observations: QuadrupedRigidObservations | null } {
  const issues: string[] = [];
  const root = document.getRoot();
  if (root.listSkins().length > 0) issues.push(`the rig has ${root.listSkins().length} skin(s); ${profile.name} carries no skin`);
  for (const mesh of root.listMeshes()) for (const primitive of mesh.listPrimitives()) {
    if (primitive.listTargets().length > 0) issues.push(`mesh '${mesh.getName()}' has morph targets; a rigid part has none`);
  }

  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const roots = scene?.listChildren() ?? [];
  const rootNode = roots.length === 1 && roots[0]!.getName() === QUADRUPED_RIGID_ROOT ? roots[0]! : null;
  if (!rootNode) issues.push(`the scene must have the single root node '${QUADRUPED_RIGID_ROOT}'`);
  const rig = rootNode ? subtree(rootNode) : new Set<Node>();
  const nodes = root.listNodes();
  const names = new Set<string>();
  for (const node of nodes) {
    const name = node.getName();
    if (!name) { issues.push("every node needs a name, because clips and joints are addressed by name"); continue; }
    if (names.has(name)) issues.push(`node name '${name}' is used twice`);
    names.add(name);
    if (rootNode && !rig.has(node)) issues.push(`node '${name}' is outside the rig root '${QUADRUPED_RIGID_ROOT}'`);
  }

  const byName = new Map(nodes.map((node) => [node.getName(), node]));
  if (rootNode) {
    const t = rootNode.getTranslation(), r = rootNode.getRotation(), s = rootNode.getScale();
    if (t.some((value) => Math.abs(value) > 1e-6) || Math.abs(r[3]! - 1) > 1e-6 || s.some((value) => Math.abs(value - 1) > 1e-6)) {
      issues.push(`the rig root '${QUADRUPED_RIGID_ROOT}' must have an identity transform`);
    }
  }
  for (const joint of profile.joints) {
    const node = byName.get(joint);
    if (!node) { issues.push(`required joint '${joint}' is missing`); continue; }
    if (rootNode && !rig.has(node)) issues.push(`required joint '${joint}' is not under the rig root`);
    if (joint !== QUADRUPED_RIGID_ROOT && !hasGeometry(node)) issues.push(`joint '${joint}' moves no geometry`);
  }
  for (const leg of profile.legs) {
    const node = byName.get(leg);
    if (!node?.getMesh()) continue;
    let top: number;
    try { top = documentBounds(document, leg).max[1]; } catch { issues.push(`joint '${leg}' has no finite geometry`); continue; }
    const pivot = node.getWorldTranslation()[1];
    if (Math.abs(top - pivot) > QUADRUPED_RIGID_LEG_PIVOT_TOLERANCE) issues.push(`joint '${leg}' pivots at y ${round(pivot)}, not at the top of its leg (y ${round(top)})`);
  }

  const animations = root.listAnimations();
  const clips: QuadrupedRigidObservations["clips"] = {};
  const clipNames = animations.map((animation) => animation.getName());
  for (const name of clipNames) if (!name || clipNames.indexOf(name) !== clipNames.lastIndexOf(name)) issues.push(name ? `clip name '${name}' is used twice` : "every clip needs a name");
  for (const animation of animations) if (animation.getName()) clips[animation.getName()] = checkClip(animation, rig, issues);
  const clip = (name: string) => animations.find((animation) => animation.getName() === name);
  for (const required of QUADRUPED_RIGID_CLIPS) if (!clip(required)) issues.push(`required clip '${required}' is missing`);

  const idle = clip("idle");
  if (idle && Math.max(0, ...idle.listChannels().map((channel) => {
    const output = channel.getSampler()?.getOutput();
    return output ? Math.max(0, ...ranges(output.getArray()!, output.getElementSize())) : 0;
  })) <= MIN_CHANNEL_MOTION) issues.push("clip 'idle' does not move");

  const walk = clip("walk");
  if (walk) {
    for (const leg of profile.legs) {
      const motion = channelMotion(walk, leg, "rotation");
      if (!motion) issues.push(`clip 'walk' does not rotate joint '${leg}'`);
      else if (Math.max(...motion) <= MIN_LEG_SWING) issues.push(`clip 'walk' barely moves joint '${leg}'`);
    }
    const travel = Math.max(...[QUADRUPED_RIGID_ROOT, "body"].map((name) => horizontalTravel(walk, name)));
    if (travel > QUADRUPED_RIGID_MAX_WALK_TRAVEL) issues.push(`clip 'walk' travels ${round(travel)} m; ${profile.name} walks are in place`);
    if (clips.walk) clips.walk.walkTravel = round(travel);
  }
  for (const name of QUADRUPED_RIGID_ACTIVITY_CLIPS) {
    const activity = clip(name);
    if (!activity || !clips[name]) continue;
    const travel = Math.max(...[QUADRUPED_RIGID_ROOT, "body"].map((joint) => horizontalTravel(activity, joint)));
    if (travel > QUADRUPED_RIGID_MAX_WALK_TRAVEL) issues.push(`clip '${name}' travels ${round(travel)} m; ${profile.name} activity clips are in place`);
    clips[name]!.travel = round(travel);
  }
  for (const animation of animations) {
    const name = animation.getName();
    if (!name || !clips[name] || clips[name]!.seconds <= 0) continue;
    let lowest: number;
    try { lowest = clipLowestPoint(document, animation); } catch (error) { issues.push(`clip '${name}' cannot be sampled: ${(error as Error).message}`); continue; }
    if (!Number.isFinite(lowest)) continue;
    clips[name]!.lowestPoint = lowest;
    if (lowest < -QUADRUPED_RIGID_GROUND_TOLERANCE) issues.push(`clip '${name}' sinks to y ${lowest}, below the ground plane`);
  }

  let bounds: { min: Vec3; max: Vec3 } | null = null;
  try { bounds = documentBounds(document); } catch { issues.push("the rest pose has no finite mesh bounds"); }
  if (bounds) {
    const { min, max } = bounds;
    if (Math.abs(min[1]) > QUADRUPED_RIGID_GROUND_TOLERANCE) issues.push(`the rest pose stands at y ${min[1]}, not on the ground plane`);
    for (const [axis, label] of [[0, "length"], [1, "height"], [2, "depth"]] as const) {
      const extent = max[axis] - min[axis];
      if (extent < QUADRUPED_RIGID_EXTENT.min || extent > QUADRUPED_RIGID_EXTENT.max) issues.push(`the rest-pose ${label} of ${round(extent)} m is outside ${QUADRUPED_RIGID_EXTENT.min}–${QUADRUPED_RIGID_EXTENT.max} m`);
    }
    if (min[0] > 0 || max[0] < 0 || min[2] > 0 || max[2] < 0) issues.push("the rig origin lies outside the rest-pose footprint");
  }
  const observations = bounds ? {
    profile: profile.name,
    joints: profile.joints.filter((joint) => byName.has(joint)).sort(),
    rigidParts: nodes.filter((node) => node.getMesh()).length,
    triangles: triangles(document),
    materials: root.listMaterials().length,
    bounds,
    size: { width: round(bounds.max[0] - bounds.min[0]), depth: round(bounds.max[2] - bounds.min[2]), height: round(bounds.max[1] - bounds.min[1]) },
    clips,
  } : null;
  return { issues, observations };
}

/** Every way `document` breaks quadruped-rigid, and the measurements the descriptor records. */
export function inspectQuadrupedRigid(document: Document) {
  return inspectRigidAnimal(document, QUADRUPED_RIGID);
}

/** The measurements of a valid `document` under `profile`; throws naming every issue otherwise. */
export function assertRigidAnimal(document: Document, profile: RigidAnimalProfile, label = "asset"): QuadrupedRigidObservations {
  const { issues, observations } = inspectRigidAnimal(document, profile);
  if (issues.length > 0 || !observations) throw new Error(`${label} fails ${profile.name}:\n- ${issues.join("\n- ") || "no observations"}`);
  return observations;
}

/** The measurements of a valid quadruped-rigid `document`; throws naming every issue otherwise. */
export function assertQuadrupedRigid(document: Document, label = "asset"): QuadrupedRigidObservations {
  return assertRigidAnimal(document, QUADRUPED_RIGID, label);
}

/**
 * One animal of a family, as a pinned source with what it came from. `profile` is the rigid profile it is checked
 * against, quadruped-rigid unless given (a two-legged animal names `BIPED_RIGID`); its descriptor entry records it.
 */
export type QuadrupedFamilyMember = { key: string; variant?: string; profile?: RigidAnimalProfile; source: AssetRef; provenance: Record<string, unknown> };
export type QuadrupedFamilyLicense = { spdx: string; attribution: string; evidenceUrl: string; text: string };
export type QuadrupedFamilyOptions = {
  release: string; tarName: string; descriptorFile: string; descriptorSchema: string; descriptorAttachment: string;
  /** The conventions of the family's authored models, recorded with its descriptor. */
  conventions: Record<string, string>;
  members: readonly QuadrupedFamilyMember[]; license: QuadrupedFamilyLicense; log?: (line: string) => void;
};

/**
 * Package a family through the shared path: check each pinned source against the profile, import it through
 * scene.import.gltf@2 and check it again, export a gltf-resources-v1 bundle with the descriptor as the first
 * animal's attachment, pack the tar and check the packaged glTF once more. Each member is validated before it
 * leaves its stage; there is no private importer.
 */
export async function packageQuadrupedRigidFamily(root: string, options: QuadrupedFamilyOptions) {
  const { members, license, log = () => {} } = options;
  const io = new NodeIO();
  const policy = { allowedValidatorWarnings: [...GLTF_RESOURCES_BUNDLE_ALLOWED_VALIDATOR_WARNINGS] };
  const built = [];
  for (const member of [...members].sort((a, b) => a.key.localeCompare(b.key))) {
    const profile = member.profile ?? QUADRUPED_RIGID;
    log(`check ${member.key} against ${profile.name} and import it (scene.import.gltf@2)`);
    const sourceObservations = assertRigidAnimal(await io.readBinary(new Uint8Array(await resolveAssetObject(root, member.source))), profile, `${member.key} source`);
    const imported = single(await executeGltfProductionImportOperation(root, { inputs: { source: member.source }, parameters: { policy } }));
    const observations = assertRigidAnimal(await io.readBinary(new Uint8Array(await resolveAssetObject(root, imported))), profile, `${member.key} import`);
    if (canonicalJson(observations) !== canonicalJson(sourceObservations)) throw new Error(`${member.key}: the import changed the measured rig, clips or bounds`);
    built.push({ member, imported, observations });
  }
  const variant = (member: QuadrupedFamilyMember) => member.variant ?? "default";
  const descriptor = {
    schema: options.descriptorSchema, profile: QUADRUPED_RIGID_PROFILE, units: "metre", up: "+Y", handedness: "right", ...options.conventions,
    placement: "Presentation only. The consumer owns placement, gameplay and physics; none is implied here.",
    clips: { required: QUADRUPED_RIGID_CLIPS, activity: QUADRUPED_RIGID_ACTIVITY_CLIPS, walk: "in-place", activityClips: "in-place", loop: true },
    license,
    assets: built.map(({ member, observations }) => ({
      key: member.key, variant: variant(member), license: license.spdx, source: member.source, provenance: member.provenance, ...observations,
    })),
  };
  const descriptorBytes = Buffer.from(`${canonicalJson(descriptor)}\n`);
  await writeFile(path.join(root, options.descriptorFile), descriptorBytes);
  const attachment = (await storeAssetObject(root, { bytes: descriptorBytes, kind: "descriptor", mediaType: "application/json", metadata: { schema: options.descriptorSchema } })).asset;

  const packed = await exportKitBundle(root, {
    tarName: options.tarName, log,
    invocation: {
      parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: built.map(({ member }, index) => ({ key: member.key, variant: variant(member), ...(index === 0 ? { attachments: [{ name: options.descriptorAttachment }] } : {}) })) },
      inputs: { assets: built.map(({ imported }) => imported), attachments: [attachment] },
    },
  });

  log("check the packaged glTF against the profile");
  const manifest = parseGltfResourcesBundleManifest(await readFile(path.join(packed.bundleDir, "manifest.json")));
  for (const { member, observations } of built) {
    const { gltf, resources } = await readAssetBundleGltf(packed.bundleDir, manifest, member.key, variant(member));
    const document = await io.readJSON({ json: JSON.parse(gltf.toString("utf8")), resources: Object.fromEntries(resources) });
    if (canonicalJson(assertRigidAnimal(document, member.profile ?? QUADRUPED_RIGID, `${member.key} bundle`)) !== canonicalJson(observations)) throw new Error(`${member.key}: the bundle changed the measured rig, clips or bounds`);
  }
  await writeFile(path.join(root, `${options.tarName.replace(/\.tar$/, "")}.LICENSE.txt`), license.text);
  return {
    ...packed, descriptor, manifest,
    lineage: {
      release: options.release, profile: QUADRUPED_RIGID_PROFILE, license: { spdx: license.spdx, attribution: license.attribution, evidenceUrl: license.evidenceUrl },
      animals: Object.fromEntries(built.map(({ member, imported, observations }) => [member.key, { source: member.source, imported, provenance: member.provenance, observations }])),
    },
  };
}
