// Build the #118 Greyhaven starter environment bundle from its canonical catalog members
// (docs/greyhaven-starter-bundle.md):
//   bun scripts/build-greyhaven-starter.ts --out <directory>
// Needs the hydrated Git LFS members under assets/canonical/ (docs/greyhaven-starter-sources.md).
// <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and packed
// to <directory>/greyhaven.starter.tar (+ .sha256) with scripts/pack-asset-bundle.ts.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO, type Document } from "@gltf-transform/core";
import { GLTF_RESOURCES_BUNDLE_PROFILE, exportAssetBundle } from "../src/asset-bundle.js";
import { ASSET_BUNDLE_REF_FILE, readAssetBundleTar } from "../src/asset-bundle-pack.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { canonicalJson } from "../src/canonical.js";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { executeGltfPlaceOperation } from "../src/gltf-place-operations.js";
import { executeGltfProductionImportOperation } from "../src/gltf-production-operations.js";
import { sliceResizeDocument } from "../src/gltf-slice-resize.js";
import { executeGltfTextureResizeOperation } from "../src/gltf-texture-resize-operations.js";
import { DEBRIS_PLANES, DEBRIS_VARIANT, generateDebris, type DebrisPlane } from "../src/debris-recipe.js";
import { DAMAGE_RECIPES, DAMAGE_STATES, clipBox, damageLodVariant, generateDamageState, subtractBox, type Box } from "../src/damage-recipe.js";
import { LOD_LEVELS, LOD_RATIOS, LOD_SWITCH_DISTANCE_HINTS, generateLodLevel } from "../src/lod-recipe.js";
import type { AssetOperationResult, AssetRef } from "../src/operations.js";

type Json = Record<string, any>;
export type Vec3 = [number, number, number];
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const TANGENT_WARNING = "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE";
const SKINNED_WARNING = "NODE_SKINNED_MESH_NON_ROOT";
const COLOR_CLAMP_REPAIR = "gltf-color-clamp-v1";

const MEDIEVAL = "quaternius.medieval-village-megakit-standard";
const FANTASY = "quaternius.fantasy-props-megakit-standard";
const NATURE = "quaternius.stylized-nature-megakit-standard";

export const GREYHAVEN_DESCRIPTOR_SCHEMA = "greyhaven-starter-descriptor-v1";
export const GREYHAVEN_DESCRIPTOR_ATTACHMENT = "starter-descriptor";
export const GREYHAVEN_BUNDLE_VARIANT = "default";
export const GREYHAVEN_TAR_NAME = "greyhaven.starter.tar";
/** #124: per-slot maximum texture edges for game delivery (the Ranger's #257 limits); images are never upscaled. */
export const GREYHAVEN_TEXTURE_POLICY = {
  maxEdgeBySlot: { baseColor: 1024, normal: 1024, metallicRoughness: 512, occlusion: 512, emissive: 1024 },
  default: 1024,
} as const;

export type GreyhavenRole = string;
export type GreyhavenCategory = "structure" | "vegetation" | "prop";
export interface GreyhavenMember {
  role: GreyhavenRole; key: string; category: GreyhavenCategory; archive: string; gltf: string; repairs?: string[]; pivotNode?: string;
  /** How the member's collision proxy is derived: its placed bounds, the tree trunk, or none (walk-through or presentation-only). */
  collision?: "bounds" | "trunk" | "none";
  /** A rigged member (the chest's lid joint): its skinned meshes are not scene roots. */
  rigged?: boolean;
}

/** The starter kit (#118 first slice, #119 expansion), in build order (docs/greyhaven-starter-sources.md). */
export const GREYHAVEN_MEMBERS: readonly GreyhavenMember[] = [
  { role: "wall", key: "greyhaven.starter.wall", category: "structure", archive: MEDIEVAL, gltf: "glTF/Wall_Plaster_Door_Flat.gltf" },
  // The door's hinge is the source node origin: the leaf spans x −0.046..1.072 from it.
  { role: "door", key: "greyhaven.starter.door", category: "structure", archive: MEDIEVAL, gltf: "glTF/Door_1_Flat.gltf", pivotNode: "Door_1_Flat" },
  { role: "door-frame", key: "greyhaven.starter.door-frame", category: "structure", archive: MEDIEVAL, gltf: "glTF/DoorFrame_Flat_WoodDark.gltf", collision: "none" },
  { role: "barrel", key: "greyhaven.starter.barrel", category: "prop", archive: FANTASY, gltf: "Exports/glTF/Barrel.gltf" },
  { role: "tree", key: "greyhaven.starter.tree", category: "vegetation", archive: NATURE, gltf: "glTF/CommonTree_1.gltf", repairs: [COLOR_CLAMP_REPAIR], collision: "trunk" },
  // #119: modular structures, vegetation and props from the same three kits (Atlas Decision 3.1.1).
  { role: "wall-plain", key: "greyhaven.starter.wall-plain", category: "structure", archive: MEDIEVAL, gltf: "glTF/Wall_Plaster_Straight.gltf" },
  { role: "corner", key: "greyhaven.starter.corner", category: "structure", archive: MEDIEVAL, gltf: "glTF/Corner_Exterior_Wood.gltf" },
  { role: "roof", key: "greyhaven.starter.roof", category: "structure", archive: MEDIEVAL, gltf: "glTF/Roof_RoundTiles_4x4.gltf" },
  // The roof's gable ends: the roof pieces leave them open.
  { role: "gable", key: "greyhaven.starter.gable", category: "structure", archive: MEDIEVAL, gltf: "glTF/Roof_Front_Brick4.gltf" },
  { role: "fence", key: "greyhaven.starter.fence", category: "structure", archive: MEDIEVAL, gltf: "glTF/Prop_WoodenFence_Single.gltf" },
  { role: "fence-extension", key: "greyhaven.starter.fence-extension", category: "structure", archive: MEDIEVAL, gltf: "glTF/Prop_WoodenFence_Extension1.gltf" },
  { role: "pine", key: "greyhaven.starter.pine", category: "vegetation", archive: NATURE, gltf: "glTF/Pine_1.gltf", repairs: [COLOR_CLAMP_REPAIR], collision: "trunk" },
  { role: "bush", key: "greyhaven.starter.bush", category: "vegetation", archive: NATURE, gltf: "glTF/Bush_Common_Flowers.gltf", repairs: [COLOR_CLAMP_REPAIR], collision: "none" },
  { role: "grass", key: "greyhaven.starter.grass", category: "vegetation", archive: NATURE, gltf: "glTF/Grass_Common_Short.gltf", repairs: [COLOR_CLAMP_REPAIR], collision: "none" },
  { role: "rock", key: "greyhaven.starter.rock", category: "vegetation", archive: NATURE, gltf: "glTF/Rock_Medium_1.gltf", repairs: [COLOR_CLAMP_REPAIR] },
  { role: "crate", key: "greyhaven.starter.crate", category: "prop", archive: FANTASY, gltf: "Exports/glTF/Crate_Wooden.gltf" },
  { role: "chest", key: "greyhaven.starter.chest", category: "prop", archive: FANTASY, gltf: "Exports/glTF/Chest_Wood.gltf", rigged: true, pivotNode: "Chest_Top" },
  { role: "bench", key: "greyhaven.starter.bench", category: "prop", archive: FANTASY, gltf: "Exports/glTF/Bench.gltf" },
  { role: "lantern", key: "greyhaven.starter.lantern", category: "prop", archive: FANTASY, gltf: "Exports/glTF/Lantern_Wall.gltf", collision: "none" },
  { role: "cart", key: "greyhaven.starter.cart", category: "prop", archive: FANTASY, gltf: "Exports/glTF/Stall_Cart_Empty.gltf" },
  // #318: the floor piece of destructible buildings (WoodTrim, like the door).
  { role: "floor", key: "greyhaven.starter.floor", category: "structure", archive: MEDIEVAL, gltf: "glTF/Floor_WoodDark.gltf" },
];

/**
 * #121 controlled variations: each resizes a kit member to new outer dimensions with `sliceResizeDocument`, keeping
 * fixed end margins (rims, trims, posts) and stretching the middle, and may drop a construction part by material.
 * They share the source's materials and trim-sheet textures. Sizes are footprint W (x) × H (y) × D (z) in metres.
 */
export interface GreyhavenVariation {
  role: string; key: string; base: GreyhavenRole; label: string;
  size: Partial<Record<"x" | "y" | "z", number>>; margin: Record<"x" | "y" | "z", number>; dropMaterials?: string[];
}
export const GREYHAVEN_VARIATIONS: readonly GreyhavenVariation[] = [
  { role: "crate-long", key: "greyhaven.starter.crate-long", base: "crate", label: "long crate", size: { x: 1.5 }, margin: { x: 0.12, y: 0.12, z: 0.12 } },
  { role: "crate-low", key: "greyhaven.starter.crate-low", base: "crate", label: "low crate", size: { y: 0.5 }, margin: { x: 0.12, y: 0.12, z: 0.12 } },
  { role: "crate-plain", key: "greyhaven.starter.crate-plain", base: "crate", label: "crate without metal fittings", size: {}, margin: { x: 0.12, y: 0.12, z: 0.12 }, dropMaterials: ["MI_Trim_Metal"] },
  { role: "keg", key: "greyhaven.starter.keg", base: "barrel", label: "keg", size: { x: 0.56, y: 0.56, z: 0.56 }, margin: { x: 0, y: 0.1, z: 0 } },
  { role: "barrel-tall", key: "greyhaven.starter.barrel-tall", base: "barrel", label: "tall barrel", size: { y: 1.25 }, margin: { x: 0, y: 0.1, z: 0 } },
  { role: "tub", key: "greyhaven.starter.tub", base: "barrel", label: "wide tub", size: { x: 1.0, y: 0.55, z: 1.0 }, margin: { x: 0, y: 0.1, z: 0 } },
  { role: "wall-plain-1m", key: "greyhaven.starter.wall-plain-1m", base: "wall-plain", label: "1 m wall", size: { x: 1 }, margin: { x: 0.12, y: 0.25, z: 0.05 } },
  { role: "wall-plain-3m", key: "greyhaven.starter.wall-plain-3m", base: "wall-plain", label: "3 m wall", size: { x: 3 }, margin: { x: 0.12, y: 0.25, z: 0.05 } },
  { role: "wall-plain-4m", key: "greyhaven.starter.wall-plain-4m", base: "wall-plain", label: "4 m wall", size: { x: 4 }, margin: { x: 0.12, y: 0.25, z: 0.05 } },
  { role: "fence-1m", key: "greyhaven.starter.fence-1m", base: "fence", label: "1 m fence", size: { x: 1.06 }, margin: { x: 0.12, y: 0.05, z: 0.02 } },
  { role: "fence-3m", key: "greyhaven.starter.fence-3m", base: "fence", label: "3 m fence", size: { x: 3.06 }, margin: { x: 0.12, y: 0.05, z: 0.02 } },
  { role: "fence-tall", key: "greyhaven.starter.fence-tall", base: "fence", label: "tall fence", size: { y: 1.3 }, margin: { x: 0.12, y: 0.12, z: 0.02 } },
];

/** Doorway measurement: the ray grid and the band of the trunk used for the tree's trunk proxy. */
export const DOORWAY_RAY_STEP = 0.005;
export const DOORWAY_RAY_TOLERANCE = 1e-5;
export const TRUNK_BAND = { minY: 0.5, maxY: 1.0 } as const;

function single(result: AssetOperationResult, port = "output"): AssetRef {
  const output = result.outputs[port];
  if (!output || Array.isArray(output)) throw new Error(`operation output '${port}' is missing`);
  return output;
}

async function readJson(file: string): Promise<Json> {
  return JSON.parse(await readFile(path.join(REPOSITORY_ROOT, file), "utf8"));
}

const round = (value: number) => { const r = Math.round(value * 1e6) / 1e6; return r === 0 ? 0 : r; };
const round3 = (v: readonly number[]): Vec3 => [round(v[0]!), round(v[1]!), round(v[2]!)];

/** World-space triangles of every mesh instance (static meshes; the starter members have no skins). */
export function worldTriangles(document: Document): { positions: Float64Array; materials: string[] } {
  const out: number[] = [];
  const materials: string[] = [];
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION")!;
      const indices = primitive.getIndices();
      const count = indices ? indices.getCount() : position.getCount();
      const p: number[] = [0, 0, 0];
      const material = primitive.getMaterial()?.getName() ?? "";
      for (let i = 0; i < count; i += 1) {
        const index = indices ? indices.getScalar(i) : i;
        position.getElement(index, p);
        out.push(m[0] * p[0]! + m[4] * p[1]! + m[8] * p[2]! + m[12], m[1] * p[0]! + m[5] * p[1]! + m[9] * p[2]! + m[13], m[2] * p[0]! + m[6] * p[1]! + m[10] * p[2]! + m[14]);
        if (i % 3 === 0) materials.push(material);
      }
    }
  }
  return { positions: Float64Array.from(out), materials };
}

/** z of every triangle hit by the ray through (x, y) parallel to Z (the wall's thickness axis). */
export function rayHitsZ(triangles: Float64Array, x: number, y: number): number[] {
  const hits: number[] = [];
  for (let t = 0; t < triangles.length; t += 9) {
    const ax = triangles[t]!, ay = triangles[t + 1]!, az = triangles[t + 2]!;
    const bx = triangles[t + 3]!, by = triangles[t + 4]!, bz = triangles[t + 5]!;
    const cx = triangles[t + 6]!, cy = triangles[t + 7]!, cz = triangles[t + 8]!;
    if (x < Math.min(ax, bx, cx) || x > Math.max(ax, bx, cx) || y < Math.min(ay, by, cy) || y > Math.max(ay, by, cy)) continue;
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-14) continue; // parallel to the ray
    const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
    const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
    const w = 1 - u - v;
    if (u < 0 || v < 0 || w < 0) continue;
    hits.push(u * az + v * bz + w * cz);
  }
  return hits;
}

/**
 * Measure the doorway as the clear rectangle through the wall's whole thickness that contains `seed`:
 * from the seed, rays parallel to Z march outwards in DOORWAY_RAY_STEP steps until they hit geometry,
 * and each boundary is bisected to DOORWAY_RAY_TOLERANCE. Width is the narrowest span over 21 rows,
 * height the lowest top over 21 columns; depth is the Z extent of the geometry hit just outside both
 * jambs. Coordinates are the placed wall's frame.
 */
export function measureDoorway(triangles: Float64Array, bounds: { min: Vec3; max: Vec3 }, seed: [number, number]) {
  const blocked = (x: number, y: number) => rayHitsZ(triangles, x, y).length > 0;
  if (blocked(seed[0], seed[1])) throw new Error(`doorway seed (${seed.join(", ")}) is not open`);
  // March from `from` along +/- one axis until blocked (or `limit`), then bisect the boundary.
  const edge = (from: number, direction: 1 | -1, limit: number, probe: (value: number) => boolean) => {
    let open = from;
    for (;;) {
      const next = open + direction * DOORWAY_RAY_STEP;
      if (direction > 0 ? next >= limit : next <= limit) return probe(limit) ? bisect(open, limit, probe) : limit;
      if (probe(next)) return bisect(open, next, probe);
      open = next;
    }
  };
  const bisect = (open: number, closed: number, probe: (value: number) => boolean) => {
    while (Math.abs(closed - open) > DOORWAY_RAY_TOLERANCE) {
      const middle = (open + closed) / 2;
      if (probe(middle)) closed = middle; else open = middle;
    }
    return (open + closed) / 2;
  };
  const verticalSpan = (x: number) => ({
    bottom: edge(seed[1], -1, bounds.min[1], (y) => blocked(x, y)),
    top: edge(seed[1], 1, bounds.max[1], (y) => blocked(x, y)),
  });
  const horizontalSpan = (y: number) => ({
    left: edge(seed[0], -1, bounds.min[0], (x) => blocked(x, y)),
    right: edge(seed[0], 1, bounds.max[0], (x) => blocked(x, y)),
  });
  const samples = (a: number, b: number, inset: number) => Array.from({ length: 21 }, (_, i) => a + inset + ((b - a - 2 * inset) * i) / 20);
  let { bottom, top } = verticalSpan(seed[0]);
  let left = -Infinity, right = Infinity;
  for (let pass = 0; pass < 2; pass += 1) {
    left = -Infinity; right = Infinity;
    for (const y of samples(bottom, top, 0.01)) { const span = horizontalSpan(y); left = Math.max(left, span.left); right = Math.min(right, span.right); }
    let lowestTop = Infinity, highestBottom = -Infinity;
    for (const x of samples(left, right, 0.01)) { const span = verticalSpan(x); lowestTop = Math.min(lowestTop, span.top); highestBottom = Math.max(highestBottom, span.bottom); }
    top = lowestTop; bottom = highestBottom;
  }
  // Depth: geometry hit just outside each jamb, over the doorway's height.
  const zs: number[] = [];
  for (const x of [left - 0.02, right + 0.02]) for (const y of samples(bottom, top, 0.05)) zs.push(...rayHitsZ(triangles, x, y));
  if (zs.length === 0) throw new Error("no wall geometry beside the doorway");
  const zMin = Math.min(...zs), zMax = Math.max(...zs);
  return {
    min: [left, bottom, zMin] as Vec3, max: [right, top, zMax] as Vec3,
    center: [(left + right) / 2, (bottom + top) / 2, (zMin + zMax) / 2] as Vec3,
    width: right - left, height: top - bottom, depth: zMax - zMin,
  };
}

/** The trunk box: X/Z extent of the trunk (bark) vertices in TRUNK_BAND, from the ground to the lowest leaf. */
export function measureTrunk(triangles: Float64Array, materials: string[], barkMaterial: string) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, leavesMinY = Infinity;
  for (let t = 0; t < materials.length; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const x = triangles[t * 9 + k * 3]!, y = triangles[t * 9 + k * 3 + 1]!, z = triangles[t * 9 + k * 3 + 2]!;
      if (materials[t] !== barkMaterial) { leavesMinY = Math.min(leavesMinY, y); continue; }
      if (y < TRUNK_BAND.minY || y > TRUNK_BAND.maxY) continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(leavesMinY)) throw new Error("tree has no trunk vertices in the trunk band or no leaves");
  return { min: [minX, 0, minZ] as Vec3, max: [maxX, leavesMinY, maxZ] as Vec3 };
}

const box = (min: readonly number[], max: readonly number[], tag: string, name: string) => ({
  name, tag,
  center: round3([(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2]),
  size: round3([max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!]),
});

function documentWorldBounds(document: Document) {
  const triangles = worldTriangles(document).positions;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < triangles.length; i += 3) for (let a = 0; a < 3; a += 1) { min[a] = Math.min(min[a]!, triangles[i + a]!); max[a] = Math.max(max[a]!, triangles[i + a]!); }
  return { min, max };
}

export async function buildGreyhavenStarter({ outDir, lods = true, debris = lods, log = () => {} }: {
  outDir: string;
  /** Build the Blender lod1/lod2 variants (#123). Off only where Blender is unavailable, e.g. the hosted storage job. */
  lods?: boolean;
  /** #319/#318: the `debris` variant of the breakable props and building pieces, and the building pieces'
   * `damaged`/`destroyed` states (Blender; defaults to `lods`). */
  debris?: boolean;
  log?: (line: string) => void;
}) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const providers = await readJson("catalog/providers.json");
  const sources = await readJson("catalog/sources.json");
  const storage = await readJson("catalog/storage.json");
  const rawSources: Json[] = sources.sources;
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const memberId = (archive: string, memberPath: string) => {
    const matches = rawSources.filter((source) => source.archiveMember?.archive === archive && source.archiveMember?.path === memberPath);
    if (matches.length !== 1) throw new Error(`'${memberPath}' must be registered exactly once`);
    return matches[0]!.id as string;
  };
  // The one registered member of the archive with the URI's basename (docs/greyhaven-starter-sources.md).
  const resourceId = (archive: string, uri: string) => {
    const name = path.posix.basename(decodeURIComponent(uri));
    const matches = rawSources.filter((source) => source.archiveMember?.archive === archive && path.posix.basename(source.archiveMember.path) === name);
    if (matches.length !== 1) throw new Error(`URI '${uri}' must resolve to exactly one member of '${archive}'`);
    return matches[0]!.id as string;
  };
  const member = async (sourceId: string) =>
    (await importAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot: REPOSITORY_ROOT, objectStoreRoot: root })).asset as AssetRef;

  const io = new NodeIO();
  const built: Json[] = [];
  const lineage: Json = { members: {} };
  for (const entry of GREYHAVEN_MEMBERS) {
    const source = await member(memberId(entry.archive, entry.gltf));
    const json = JSON.parse((await resolveAssetObject(root, source)).toString("utf8"));
    const uris: string[] = [...(json.buffers ?? []), ...(json.images ?? [])].map((item: Json) => item.uri);
    const resources: AssetRef[] = [];
    for (const uri of uris) resources.push(await member(resourceId(entry.archive, uri)));
    const warnings = entry.rigged ? [SKINNED_WARNING, TANGENT_WARNING] : [TANGENT_WARNING];
    const policy = { allowedValidatorWarnings: warnings, ...(entry.repairs ? { repairs: entry.repairs } : {}) };
    log(`import ${entry.role} ${entry.gltf} (scene.import.gltf@2${entry.repairs ? `, ${entry.repairs.join(", ")}` : ""})`);
    const importResult = await executeGltfProductionImportOperation(root, { inputs: { source, resources }, parameters: { resourceUris: uris, policy } });
    const imported = single(importResult);
    const parentName = `greyhaven.${entry.role}`;
    log(`place ${entry.role} under '${parentName}' (scene.place.gltf@1, footprint-base-center)`);
    const placeResult = await executeGltfPlaceOperation(root, {
      inputs: { source: imported },
      parameters: { parentName, anchor: "footprint-base-center", ...(entry.pivotNode ? { sourcePivot: { node: entry.pivotNode } } : {}), policy: { allowedValidatorWarnings: warnings } },
    });
    // #124: game-resolution textures (the kit's sources are up to 4096 px), as the Ranger has since #257.
    const placed = single(await executeGltfTextureResizeOperation(root, {
      inputs: { source: single(placeResult) }, parameters: { ...GREYHAVEN_TEXTURE_POLICY, policy: { allowedValidatorWarnings: warnings } },
    }));
    const observations = placeResult.observations as Json;
    const document = await io.readBinary(new Uint8Array(await resolveAssetObject(root, placed)));
    built.push({ entry, source, resources, imported, placed, parentName, observations, document });
    lineage.members[entry.role] = {
      key: entry.key, gltf: entry.gltf, source, resources, imported, placed,
      ...(importResult.observations as Json).repairs ? { repairs: (importResult.observations as Json).repairs } : {},
      placement: { parentName, translation: observations.translation, footprint: observations.footprint, ...(observations.sourcePivot ? { sourcePivot: observations.sourcePivot } : {}) },
    };
  }
  const byRole = (role: GreyhavenRole) => built.find((item) => item.entry.role === role)!;

  for (const variation of GREYHAVEN_VARIATIONS) {
    const base = byRole(variation.base);
    log(`vary ${variation.base} -> ${variation.role} (slice resize${variation.dropMaterials ? `, drop ${variation.dropMaterials.join(", ")}` : ""})`);
    const document = await io.readBinary(new Uint8Array(await resolveAssetObject(root, base.placed)));
    const resized = sliceResizeDocument(document, { size: variation.size, margin: variation.margin, dropMaterials: variation.dropMaterials });
    const bytes = await io.writeBinary(document);
    const placed = (await storeAssetObject(root, { bytes: Buffer.from(bytes), kind: "mesh", mediaType: "model/gltf-binary",
      metadata: { variation: variation.role, base: base.placed.sha256 } })).asset;
    // Re-validate through the same import boundary, then measure it like the other members.
    const checked = single(await executeGltfProductionImportOperation(root, { inputs: { source: placed }, parameters: { policy: { allowedValidatorWarnings: [TANGENT_WARNING] } } }));
    const reread = await io.readBinary(new Uint8Array(await resolveAssetObject(root, checked)));
    const parent = reread.getRoot().listNodes().find((node) => node.getName() === base.parentName)!;
    const bounds = documentWorldBounds(reread);
    const footprint = { width: bounds.max[0]! - bounds.min[0]!, depth: bounds.max[2]! - bounds.min[2]!, height: bounds.max[1]! - bounds.min[1]! };
    const entry: GreyhavenMember = { role: variation.role, key: variation.key, category: base.entry.category, archive: base.entry.archive, gltf: base.entry.gltf };
    built.push({ entry, placed: checked, parentName: base.parentName, document: reread, variation: { ...variation, resized },
      observations: { translation: parent.getTranslation(), footprint, bounds: { placed: bounds } } });
    lineage.members[variation.role] = { key: variation.key, base: variation.base, placed: checked, variation: { size: variation.size, margin: variation.margin, dropMaterials: variation.dropMaterials ?? [], resized } };
  }

  // #123: lod1/lod2 of every entry, decimated in Blender from the placed LOD0 and re-validated on import.
  for (const item of built) {
    item.lods = [];
    for (const level of lods ? LOD_LEVELS : []) {
      log(`${level} of ${item.entry.role} (lod.py, ratio ${LOD_RATIOS.static[level]})`);
      const lod = await generateLodLevel(root, item.placed, LOD_RATIOS.static[level], `${item.entry.role}.${level}`);
      const warnings = item.entry.rigged ? [SKINNED_WARNING, TANGENT_WARNING] : [TANGENT_WARNING];
      const checked = single(await executeGltfProductionImportOperation(root, { inputs: { source: lod.glb }, parameters: { policy: { allowedValidatorWarnings: warnings } } }));
      item.lods.push({ level, placed: checked, ratio: LOD_RATIOS.static[level], triangles: lod.observations.trianglesAfter, source: lod.observations.trianglesBefore });
      lineage.members[item.entry.role].lods = item.lods.map((entry: Json) => ({ level: entry.level, ratio: entry.ratio, placed: entry.placed, triangles: entry.triangles }));
    }
  }

  // #319 (mmorpg#288): pre-fractured debris of the breakable props, cut in Blender from the placed LOD0.
  for (const item of built) {
    const planes = (DEBRIS_PLANES as Record<string, readonly DebrisPlane[]>)[item.entry.role];
    if (!debris || !planes) continue;
    log(`debris of ${item.entry.role} (debris.py, ${planes.length} planes)`);
    const split = await generateDebris(root, item.placed, item.entry.role, planes);
    const checked = single(await executeGltfProductionImportOperation(root, { inputs: { source: split.glb }, parameters: { policy: { allowedValidatorWarnings: [TANGENT_WARNING] } } }));
    item.debris = { placed: checked, chunks: split.observations.chunks };
    lineage.members[item.entry.role].debris = { placed: checked, planes, chunks: split.observations.chunks };
  }

  // #318: damaged and destroyed states of the building pieces, cut in Blender from the placed LOD0, each with its LODs.
  for (const item of built) {
    const recipe = DAMAGE_RECIPES[item.entry.role];
    if (!debris || !recipe) continue;
    item.damage = [];
    for (const state of DAMAGE_STATES) {
      log(`${state} ${item.entry.role} (damage.py)`);
      const cut = await generateDamageState(root, item.placed, item.entry.role, state, recipe);
      const checked = single(await executeGltfProductionImportOperation(root, { inputs: { source: cut.glb }, parameters: { policy: { allowedValidatorWarnings: [TANGENT_WARNING] } } }));
      const stateLods: Json[] = [];
      for (const level of lods ? LOD_LEVELS : []) {
        const lod = await generateLodLevel(root, checked, LOD_RATIOS.static[level], `${item.entry.role}.${state}.${level}`);
        stateLods.push({ level, variant: damageLodVariant(state, level), ratio: LOD_RATIOS.static[level], triangles: lod.observations.trianglesAfter,
          placed: single(await executeGltfProductionImportOperation(root, { inputs: { source: lod.glb }, parameters: { policy: { allowedValidatorWarnings: [TANGENT_WARNING] } } })) });
      }
      item.damage.push({ state, placed: checked, observations: cut.observations, lods: stateLods });
    }
    lineage.members[item.entry.role].damage = { recipe, states: item.damage.map((entry: Json) => ({ state: entry.state, placed: entry.placed,
      lods: entry.lods.map((lod: Json) => ({ variant: lod.variant, ratio: lod.ratio, placed: lod.placed, triangles: lod.triangles })) })) };
  }

  log("measure doorway and collision proxies");
  const wall = byRole("wall"), door = byRole("door"), frame = byRole("door-frame"), barrel = byRole("barrel"), tree = byRole("tree");
  const wallBounds = wall.observations.bounds.placed as { min: Vec3; max: Vec3; center: Vec3 };
  const doorBounds = door.observations.bounds.placed as { min: Vec3; max: Vec3; size: Vec3 };
  const wallTriangles = worldTriangles(wall.document).positions;
  // Seed: the wall's centre line at half the door's height.
  const doorway = measureDoorway(wallTriangles, wallBounds, [wallBounds.center[0], wallBounds.min[1] + doorBounds.size[1] / 2]);
  const solidZ = [doorway.min[2], doorway.max[2]];
  const wallProxies = [
    box([wallBounds.min[0], wallBounds.min[1], solidZ[0]!], [doorway.min[0], wallBounds.max[1], solidZ[1]!], "solid", "left-jamb"),
    box([doorway.max[0], wallBounds.min[1], solidZ[0]!], [wallBounds.max[0], wallBounds.max[1], solidZ[1]!], "solid", "right-jamb"),
    box([doorway.min[0], doorway.max[1], solidZ[0]!], [doorway.max[0], wallBounds.max[1], solidZ[1]!], "solid", "lintel"),
  ];
  const trunkBox = (item: Json) => {
    const triangles = worldTriangles(item.document);
    const barkMaterial = item.document.getRoot().listMaterials().find((material: Json) => /bark/i.test(material.getName()))?.getName();
    if (!barkMaterial) throw new Error(`${item.entry.role} has no bark material`);
    const trunk = measureTrunk(triangles.positions, triangles.materials, barkMaterial);
    return box(trunk.min, trunk.max, "solid", "trunk");
  };
  const boundsBox = (item: Json, tag: string, name: string) => box(item.observations.bounds.placed.min, item.observations.bounds.placed.max, tag, name);
  const wallTranslation = wall.observations.translation as Vec3;
  const frameTranslation = frame.observations.translation as Vec3;

  // #318: per-state collision proxies, derived from the intact ones: breaches are subtracted, and the stub clips them.
  const proxyBox = (proxy: Json): Box => ({ min: proxy.center.map((c: number, i: number) => c - proxy.size[i] / 2), max: proxy.center.map((c: number, i: number) => c + proxy.size[i] / 2) });
  const stateProxies = (intact: Json[], entry: Json) => {
    if (entry.state === "destroyed") {
      return intact.flatMap((proxy) => {
        const clipped = clipBox(proxyBox(proxy), entry.observations.bounds);
        return clipped ? [box(clipped.min, clipped.max, proxy.tag, proxy.name)] : [];
      });
    }
    return intact.flatMap((proxy) => {
      let pieces = [proxyBox(proxy)];
      for (const breach of entry.observations.breaches as Json[]) pieces = pieces.flatMap((piece) => subtractBox(piece, breach.box));
      return pieces.length === 1 ? [box(pieces[0]!.min, pieces[0]!.max, proxy.tag, proxy.name)] : pieces.map((piece, index) => box(piece.min, piece.max, proxy.tag, `${proxy.name}-${index + 1}`));
    });
  };
  const damageEntry = (item: Json, intact: Json[]) => ({
    states: [
      { state: "intact", variant: GREYHAVEN_BUNDLE_VARIANT, collisionProxies: intact },
      ...item.damage.map((entry: Json) => ({
        state: entry.state, variant: entry.state, triangles: entry.observations.triangles,
        bounds: { min: round3(entry.observations.bounds.min), max: round3(entry.observations.bounds.max) },
        ...(entry.observations.breaches ? { breaches: entry.observations.breaches.map((breach: Json) => ({ min: round3(breach.box.min), max: round3(breach.box.max) })) } : {}),
        lods: entry.lods.map((lod: Json) => ({ variant: lod.variant, ratio: lod.ratio, triangles: lod.triangles, switchDistanceHint: LOD_SWITCH_DISTANCE_HINTS[lod.level as "lod1" | "lod2"] })),
        collisionProxies: stateProxies(intact, entry),
      })),
    ],
  });
  const assetEntry = (item: Json, extra: Json) => ({
    key: item.entry.key, role: item.entry.role, category: item.entry.category, parentName: item.parentName,
    placement: { anchor: "footprint-base-center", translation: item.observations.translation },
    footprint: { width: round(item.observations.footprint.width), depth: round(item.observations.footprint.depth), height: round(item.observations.footprint.height) },
    bounds: { min: round3(item.observations.bounds.placed.min), max: round3(item.observations.bounds.placed.max) },
    ...(item.debris ? { debris: {
      variant: DEBRIS_VARIANT,
      chunks: item.debris.chunks.map((chunk: Json) => ({
        node: chunk.node, translation: chunk.center, volumeShare: chunk.volumeShare, triangles: chunk.triangles,
        collisionProxy: { name: chunk.node, tag: "debris", center: [0, 0, 0], size: round3(chunk.halfExtents.map((half: number) => 2 * half)) },
      })),
    } } : {}),
    lods: [{ variant: GREYHAVEN_BUNDLE_VARIANT, triangles: worldTriangles(item.document).positions.length / 9 }, ...item.lods.map((lod: Json) => ({
      variant: lod.level, ratio: lod.ratio, triangles: lod.triangles, switchDistanceHint: LOD_SWITCH_DISTANCE_HINTS[lod.level as "lod1" | "lod2"],
    }))],
    ...extra,
    ...(item.damage ? { damage: damageEntry(item, extra.collisionProxies) } : {}),
  });
  const descriptor = {
    schema: GREYHAVEN_DESCRIPTOR_SCHEMA,
    units: "metre", up: "+Y", facing: "+Z", handedness: "right",
    origin: "footprint-base-center",
    frame: "Each asset's values are in its own placed frame (its parent node at the origin). `mount` places an asset in the wall's placed frame.",
    collisionProxies: "Axis-aligned boxes for presentation and inspection; game physics stays with the consumer.",
    assets: [
      assetEntry(wall, {
        doorway: { center: round3(doorway.center), width: round(doorway.width), height: round(doorway.height), depth: round(doorway.depth), min: round3(doorway.min), max: round3(doorway.max) },
        collisionProxies: wallProxies,
      }),
      assetEntry(door, {
        sourcePivot: { node: door.observations.sourcePivot.node, sourceWorldPosition: round3(door.observations.sourcePivot.sourceWorldPosition), placedWorldPosition: round3(door.observations.sourcePivot.placedWorldPosition) },
        // Closed in the doorway: footprint centred in X and Z, base on the doorway's bottom.
        mount: { parent: wall.entry.key, translation: round3([doorway.center[0], doorway.min[1], doorway.center[2]]) },
        collisionProxies: [boundsBox(door, "dynamic-door", "door")],
      }),
      assetEntry(frame, {
        // The kit's pieces share one source grid, so the frame goes back to its source offset from the wall.
        mount: { parent: wall.entry.key, translation: round3([wallTranslation[0] - frameTranslation[0], wallTranslation[1] - frameTranslation[1], wallTranslation[2] - frameTranslation[2]]) },
        collisionProxies: [],
      }),
      assetEntry(barrel, { collisionProxies: [boundsBox(barrel, "solid", "barrel")] }),
      assetEntry(tree, { collisionProxies: [trunkBox(tree)] }),
      ...built.filter((item) => ![wall, door, frame, barrel, tree].includes(item)).map((item) => assetEntry(item, {
        ...(item.variation ? { variationOf: byRole(item.variation.base).entry.key, label: item.variation.label } : {}),
        ...(item.observations.sourcePivot ? { sourcePivot: { node: item.observations.sourcePivot.node, sourceWorldPosition: round3(item.observations.sourcePivot.sourceWorldPosition), placedWorldPosition: round3(item.observations.sourcePivot.placedWorldPosition) } } : {}),
        collisionProxies: item.entry.collision === "none" ? [] : item.entry.collision === "trunk" ? [trunkBox(item)] : [boundsBox(item, "solid", item.entry.role)],
      })),
    ].sort((a, b) => (a.key < b.key ? -1 : 1)),
  };
  const descriptorRef = (await storeAssetObject(root, {
    bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "descriptor", mediaType: "application/json",
    metadata: { schema: GREYHAVEN_DESCRIPTOR_SCHEMA },
  })).asset;
  lineage.descriptor = descriptorRef;

  log(`export gltf-resources-v1 bundle (asset.bundle@4, ${built.length} entries)`);
  const bundleDir = path.join(root, "bundle");
  const exported = await exportAssetBundle(root, bundleDir, {
    parameters: {
      profile: GLTF_RESOURCES_BUNDLE_PROFILE,
      assets: built.flatMap((item) => [{
        key: item.entry.key, variant: GREYHAVEN_BUNDLE_VARIANT,
        ...(item.entry.role === "wall" ? { attachments: [{ name: GREYHAVEN_DESCRIPTOR_ATTACHMENT }] } : {}),
      }, ...item.lods.map((lod: Json) => ({ key: item.entry.key, variant: lod.level })),
      ...(item.debris ? [{ key: item.entry.key, variant: DEBRIS_VARIANT }] : []),
      ...(item.damage ?? []).flatMap((entry: Json) => [{ key: item.entry.key, variant: entry.state }, ...entry.lods.map((lod: Json) => ({ key: item.entry.key, variant: lod.variant }))])]),
    },
    inputs: { assets: built.flatMap((item) => [item.placed, ...item.lods.map((lod: Json) => lod.placed), ...(item.debris ? [item.debris.placed] : []),
      ...(item.damage ?? []).flatMap((entry: Json) => [entry.placed, ...entry.lods.map((lod: Json) => lod.placed)])]), attachments: [descriptorRef] },
  });
  const tarPath = path.join(root, GREYHAVEN_TAR_NAME);
  log("pack release tar (scripts/pack-asset-bundle.ts)");
  const pack = Bun.spawnSync(["bun", path.join(REPOSITORY_ROOT, "scripts/pack-asset-bundle.ts"), bundleDir, tarPath], { stdout: "pipe", stderr: "pipe" });
  if (pack.exitCode !== 0) throw new Error(`pack-asset-bundle failed: ${pack.stderr.toString()}`);
  const packed = JSON.parse(pack.stdout.toString());
  // The consumer pin is the tar's own content-only export.ref.json (docs/asset-bundles.md).
  const refEntry = readAssetBundleTar(await readFile(tarPath)).find((item) => item.path === ASSET_BUNDLE_REF_FILE);
  if (!refEntry) throw new Error(`packed tar has no ${ASSET_BUNDLE_REF_FILE}`);
  const exportRefPath = path.join(root, ASSET_BUNDLE_REF_FILE);
  await writeFile(exportRefPath, refEntry.bytes);
  return {
    bundleDir, manifest: exported.manifest, descriptor, descriptorRef,
    tar: tarPath, tarSha256: packed.sha256 as string, tarByteLength: packed.byteLength as number,
    exportRef: JSON.parse(Buffer.from(refEntry.bytes).toString("utf8")) as Json, exportRefPath, lineage,
  };
}

function parseArguments(args: string[]) {
  return args.length === 2 && args[0] === "--out" && args[1] ? { outDir: args[1] } : undefined;
}

if (import.meta.main) {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    console.error("Usage: bun scripts/build-greyhaven-starter.ts --out <directory>");
    process.exit(2);
  }
  try {
    const result = await buildGreyhavenStarter({ ...options, log: (line) => console.error(`[greyhaven] ${line}`) });
    await writeFile(path.join(path.resolve(options.outDir), "lineage.json"), `${JSON.stringify(result.lineage, null, 2)}\n`);
    console.log(JSON.stringify({
      bundle: result.bundleDir, tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength,
      exportRef: result.exportRef, exportRefPath: result.exportRefPath, descriptor: result.descriptor,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
