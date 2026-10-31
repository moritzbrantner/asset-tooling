// Build the Battle Royale fortress art kit (#445, docs/fortress-kit.md) from the scripted Blender recipe
// adapters/blender/fortress.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-fortress-kit.ts --out <directory>
// Each piece is fitted to one shared collider box (or ramp wedge, or lift pillar) of battle_royale_core::arena at the
// revision in FORTRESS_SOURCE, so the art never changes traversal. Each piece and level of detail is one
// external.blender.script@1 run over the hydrated CC0 Poly Haven textures, imported through scene.import.gltf@2.
// The fortress-kit-descriptor-v1 attachment carries the pieces, their LOD chains (the greyhaven-nature #449 format)
// and the composition: every fortress body with the piece that dresses it. <directory> becomes the object-store
// root; the bundle is exported to <directory>/bundle and packed to <directory>/fortress.kit.tar.
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec, type BlenderSpecInput } from "../src/blender-script-spec.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { sha256Bytes } from "../src/hash.js";
import { buildKitPart, documentBounds, exportKitBundle, round, runKitCli, triangles, type KitPart } from "../src/kit-bundle.js";
import type { AssetRef } from "../src/operations.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const FORTRESS_RELEASE = "fortress-kit";
export const FORTRESS_TAR_NAME = "fortress.kit.tar";
export const FORTRESS_KEY_PREFIX = "fortress.kit";
export const FORTRESS_DESCRIPTOR_SCHEMA = "fortress-kit-descriptor-v1";
export const FORTRESS_DESCRIPTOR_ATTACHMENT = "fortress-descriptor";
/** The arena this kit is fitted to. */
export const FORTRESS_SOURCE = { repository: "moenarch-games/battle-royale", revision: "d633da2", module: "battle_royale_core::arena" } as const;
/** mmorpg-core units per metre. */
export const UNITS_PER_METRE = 100;

/** CC0 Poly Haven texture sets, by recipe input name. */
export const FORTRESS_TEXTURES = {
  wallColour: "poly-haven.castle-wall-slates-diff-2k-jpg", wallNormal: "poly-haven.castle-wall-slates-nor-gl-2k-jpg",
  wallRoughness: "poly-haven.castle-wall-slates-rough-2k-jpg",
  trimColour: "poly-haven.japanese-stone-wall-diff-2k-jpg", trimNormal: "poly-haven.japanese-stone-wall-nor-gl-2k-jpg",
  trimRoughness: "poly-haven.japanese-stone-wall-rough-2k-jpg",
  floorColour: "poly-haven.stone-tiles-02-diff-2k-jpg", floorNormal: "poly-haven.stone-tiles-02-nor-gl-2k-jpg",
  floorRoughness: "poly-haven.stone-tiles-02-rough-2k-jpg",
  woodColour: "poly-haven.old-planks-02-diff-2k-jpg", woodNormal: "poly-haven.old-planks-02-nor-gl-2k-jpg",
  woodRoughness: "poly-haven.old-planks-02-rough-2k-jpg",
} as const;

// ---------------------------------------------------------------------------------------------------------------------
// The arena, transcribed from battle_royale_core::arena at FORTRESS_SOURCE (units, y up). A drift shows up in the
// consumer as a body no composition item matches, which keeps its graybox.

export type ArenaPart = "Ground" | "Wall" | "Parapet" | "Tower" | "Floor" | "Bridge" | "Column" | "Ramp" | "Lift";
export type Rise = "PosX" | "PosZ" | "NegX" | "NegZ";
type Cuboid = { min: [number, number, number]; max: [number, number, number] };
const cuboid = (x: [number, number], y: [number, number], z: [number, number]): Cuboid => ({ min: [x[0], y[0], z[0]], max: [x[1], y[1], z[1]] });
/** A quarter turn about +Y through the centre: (x, z) -> (-z, x). */
const turned = (c: Cuboid): Cuboid => ({ min: [-c.max[2], c.min[1], c.min[0]], max: [-c.min[2], c.max[1], c.max[0]] });
const turnedBy = (c: Cuboid, quarters: number) => Array.from({ length: quarters }).reduce<Cuboid>((acc) => turned(acc), c);
const TURNED_RISE: Record<Rise, Rise> = { PosX: "PosZ", PosZ: "NegX", NegX: "NegZ", NegZ: "PosX" };
const centre = (c: Cuboid) => [0, 1, 2].map((k) => (c.min[k]! + c.max[k]!) / 2) as [number, number, number];
const half = (c: Cuboid) => [0, 1, 2].map((k) => (c.max[k]! - c.min[k]!) / 2) as [number, number, number];

/**
 * The south side's solids with the piece that dresses each, and that piece's yaw in degrees about +Y for the south
 * side (the piece frame's outward -Z faces south). Yaw 180 on the second hall wall puts its buried end in the corner.
 */
const SIDE_SOLIDS: [ArenaPart, Cuboid, FortressPart, number][] = [
  ["Wall", cuboid([-8_600, -300], [0, 800], [-8_600, -8_200]), "curtain-wall", 0],
  ["Wall", cuboid([300, 8_600], [0, 800], [-8_600, -8_200]), "curtain-wall", 0],
  ["Wall", cuboid([-300, 300], [600, 800], [-8_600, -8_200]), "gate-lintel", 0],
  ["Parapet", cuboid([-8_600, 8_600], [800, 900], [-8_600, -8_540]), "parapet", 0],
  ["Tower", cuboid([-8_760, -8_040], [0, 1_600], [-8_760, -8_040]), "corner-tower", 0],
  ["Wall", cuboid([-1_260, 250], [0, 750], [-1_260, -1_140]), "keep-wall-long", 0],
  ["Wall", cuboid([650, 1_260], [0, 750], [-1_260, -1_140]), "keep-wall-short", 0],
  ["Wall", cuboid([250, 650], [600, 750], [-1_260, -1_140]), "door-lintel", 0],
  ["Wall", cuboid([-460, -200], [0, 750], [-460, -340]), "hall-wall", 0],
  ["Wall", cuboid([200, 460], [0, 750], [-460, -340]), "hall-wall", 180],
  ["Wall", cuboid([-200, 200], [600, 750], [-460, -340]), "door-lintel", 0],
  ["Bridge", cuboid([-150, 150], [750, 800], [-8_200, -1_260]), "bridge", 0],
  ["Column", cuboid([-535, -265], [0, 750], [-840, -570]), "lift-column", 0],
];
const SIDE_RAMPS: [Cuboid, Rise, FortressPart][] = [
  [cuboid([-4_600, -4_200], [0, 800], [-8_200, -7_000]), "NegZ", "ramp-courtyard"],
  [cuboid([4_200, 4_600], [0, 800], [-8_200, -7_000]), "NegZ", "ramp-courtyard"],
  [cuboid([-8_040, -6_840], [800, 1_600], [-8_540, -8_200]), "NegX", "ramp-tower"],
  [cuboid([6_840, 8_040], [800, 1_600], [-8_540, -8_200]), "PosX", "ramp-tower"],
  [cuboid([-1_140, 60], [0, 800], [-1_140, -840]), "NegX", "ramp-keep"],
];
const SIDE_ROOF_HOLE = cuboid([-1_140, 60], [750, 800], [-1_140, -840]);
const SIDE_LIFTS: [Cuboid, FortressPart][] = [
  [cuboid([-940, -660], [-800, 0], [-1_550, -1_270]), "lift-courtyard"],
  [cuboid([-535, -265], [0, 800], [-840, -570]), "lift-tower"],
];
const KEEP_ROOF = cuboid([-1_260, 1_260], [750, 800], [-1_260, 1_260]);
const CENTRAL_TOWER = cuboid([-560, 560], [800, 1_600], [-560, 560]);
const LIFT_RISE = 800;

/** arena.rs's slabs_around: the keep roof less the ramp openings, as disjoint boxes in x bands. */
function slabsAround(area: Cuboid, holes: Cuboid[]): Cuboid[] {
  const xs = [...new Set([...holes.flatMap((h) => [h.min[0], h.max[0]]), area.min[0], area.max[0]]
    .filter((x) => x >= area.min[0] && x <= area.max[0]))].sort((a, b) => a - b);
  const slabs: Cuboid[] = [];
  for (let i = 0; i + 1 < xs.length; i += 1) {
    const [x0, x1] = [xs[i]!, xs[i + 1]!];
    const cuts = holes.filter((h) => h.min[0] <= x0 && x1 <= h.max[0]).map((h) => [h.min[2], h.max[2]] as [number, number])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let z = area.min[2];
    for (const [cutMin, cutMax] of [...cuts, [area.max[2], area.max[2]] as [number, number]]) {
      if (z < cutMin) slabs.push(cuboid([x0, x1], [area.min[1], area.max[1]], [z, cutMin]));
      z = Math.max(z, cutMax);
    }
  }
  return slabs;
}

/** A fortress body as the shared zone holds it: a static collider, a ramp wedge or a lift pillar at its low stop. */
export type FortressBody = {
  kind: "collider" | "ramp" | "lift"; body: number; part: ArenaPart; position: [number, number, number]; halfExtents: [number, number, number];
  rises?: Rise;
};

/** Every body of the arena in arena.rs's body order (ids from 1), with the piece that dresses it. */
export function fortressBodies(): (FortressBody & { piece: FortressPart | null; yawDegrees: number })[] {
  const out: (FortressBody & { piece: FortressPart | null; yawDegrees: number })[] = [];
  const push = (kind: FortressBody["kind"], part: ArenaPart, c: Cuboid, piece: FortressPart | null, yawDegrees: number, rises?: Rise) =>
    out.push({ kind, body: out.length + 1, part, position: centre(c), halfExtents: half(c), ...(rises ? { rises } : {}), piece, yawDegrees });
  push("collider", "Ground", cuboid([-32_000, 32_000], [-100, 0], [-32_000, 32_000]), null, 0);
  for (let q = 0; q < 4; q += 1) {
    for (const [part, c, piece, yaw] of SIDE_SOLIDS) push("collider", part, turnedBy(c, q), piece, mod360(yaw - 90 * q));
  }
  const holes = [0, 1, 2, 3].map((q) => turnedBy(SIDE_ROOF_HOLE, q));
  for (const slab of slabsAround(KEEP_ROOF, holes)) push("collider", "Floor", slab, "keep-roof", 0);
  push("collider", "Tower", CENTRAL_TOWER, "central-tower", 0);
  for (let q = 0; q < 4; q += 1) {
    for (const [c, rise, piece] of SIDE_RAMPS) {
      const rises = Array.from({ length: q }).reduce<Rise>((r) => TURNED_RISE[r], rise);
      push("ramp", "Ramp", turnedBy(c, q), piece, RISE_YAW[rises], rises);
    }
  }
  for (let q = 0; q < 4; q += 1) for (const [c, piece] of SIDE_LIFTS) push("lift", "Lift", turnedBy(c, q), piece, mod360(-90 * q));
  return out;
}
const mod360 = (degrees: number) => ((degrees % 360) + 360) % 360;
/** The yaw that turns a piece rising to local +Z so it rises towards `rise` (yaw 90 turns +Z to +X). */
const RISE_YAW: Record<Rise, number> = { PosZ: 0, PosX: 90, NegZ: 180, NegX: 270 };

// ---------------------------------------------------------------------------------------------------------------------
// Pieces.

export const FORTRESS_PARTS = [
  "curtain-wall", "gate-lintel", "parapet", "corner-tower", "keep-wall-long", "keep-wall-short", "hall-wall", "door-lintel",
  "keep-roof", "central-tower", "bridge", "lift-column", "ramp-courtyard", "ramp-tower", "ramp-keep", "lift-courtyard", "lift-tower",
] as const;
export type FortressPart = (typeof FORTRESS_PARTS)[number];
export const fortressKey = (part: FortressPart) => `${FORTRESS_KEY_PREFIX}.${part}`;
export const FORTRESS_ROLE: Record<FortressPart, "wall" | "parapet" | "tower" | "floor" | "bridge" | "column" | "ramp" | "lift"> = {
  "curtain-wall": "wall", "gate-lintel": "wall", parapet: "parapet", "corner-tower": "tower", "keep-wall-long": "wall",
  "keep-wall-short": "wall", "hall-wall": "wall", "door-lintel": "wall", "keep-roof": "floor", "central-tower": "tower",
  bridge: "bridge", "lift-column": "column", "ramp-courtyard": "ramp", "ramp-tower": "ramp", "ramp-keep": "ramp",
  "lift-courtyard": "lift", "lift-tower": "lift",
};
/** Pieces that leave part of their fitted box to a neighbour that owns the shared corner (no coplanar overlap). */
const BURIED: Partial<Record<FortressPart, string>> = {
  "keep-wall-long": "the -X end's 1.2 m corner square is drawn by the perpendicular keep-wall-short",
  "hall-wall": "the -X end's 1.2 m corner square is drawn by the perpendicular hall-wall",
  "lift-column": "stands 0.1 m inside its box, clear of the lift-tower pillar that shares its footprint",
};

/** Levels of detail: LOD0 is variant `default`; `lod1` and `lod2` come from the same recipe in the same frame. */
export const FORTRESS_LOD_VARIANTS = ["lod1", "lod2"] as const;
/** Screen-size switch points (the #449 metric): level n while the projected sphere fraction is at least SIZES[n]. */
export const FORTRESS_LOD_SCREEN_SIZES = [0.35, 0.12] as const;
export const FORTRESS_LOD_METRIC = "projected-bounding-sphere-height-fraction";
export const FORTRESS_LOD_REFERENCE_FOV_Y = 60;

/** One piece's local box: [width (X), height (Y), depth (Z)] in metres, read from its first body. */
function pieceSize(body: FortressBody, yawDegrees: number): [number, number, number] {
  const [hx, hy, hz] = body.halfExtents.map((h) => (2 * h) / UNITS_PER_METRE) as [number, number, number];
  return yawDegrees % 180 === 0 ? [hx, hy, hz] : [hz, hy, hx];
}

export type FortressPiece = { part: FortressPart; size: [number, number, number]; holes?: number[][]; hatches?: number[][] };

/** The pieces, each sized from the bodies it dresses (every body of a piece must give the same size). */
export function fortressPieces(): FortressPiece[] {
  const bodies = fortressBodies();
  const metres = (v: number) => round(v / UNITS_PER_METRE);
  return FORTRESS_PARTS.map((part) => {
    const mine = bodies.filter((b) => b.piece === part);
    if (!mine.length) throw new Error(`no fortress body uses ${part}`);
    if (part === "keep-roof") {
      const [cx, , cz] = centre(KEEP_ROOF);
      const rect = (c: Cuboid) => [metres(c.min[0] - cx), metres(c.min[2] - cz), metres(c.max[0] - cx), metres(c.max[2] - cz)];
      const towerLifts = [0, 1, 2, 3].map((q) => turnedBy(SIDE_LIFTS[1]![0], q));
      return {
        part, size: [metres(KEEP_ROOF.max[0] - KEEP_ROOF.min[0]), metres(KEEP_ROOF.max[1] - KEEP_ROOF.min[1]), metres(KEEP_ROOF.max[2] - KEEP_ROOF.min[2])],
        holes: [0, 1, 2, 3].map((q) => rect(turnedBy(SIDE_ROOF_HOLE, q))), hatches: towerLifts.map(rect),
      };
    }
    const sizes = mine.map((b) => pieceSize(b, b.yawDegrees));
    if (sizes.some((s) => s.some((v, k) => Math.abs(v - sizes[0]![k]!) > 1e-9))) throw new Error(`${part} dresses bodies of different sizes`);
    return { part, size: sizes[0]! };
  });
}

/** The composition: every arena body with the piece item that dresses it; the keep roof is one item over its slabs. */
export function fortressComposition() {
  const bodies = fortressBodies();
  const items: { key: string; part: FortressPart; origin: [number, number, number]; yawDegrees: number; bodies: Omit<FortressBody, "part">[] & object[] }[] = [];
  const strip = ({ kind, body, part, position, halfExtents, rises }: FortressBody) => ({ kind, body, part, position, halfExtents, ...(rises ? { rises } : {}) });
  const roof = bodies.filter((b) => b.piece === "keep-roof");
  for (const b of bodies) {
    if (!b.piece || b.piece === "keep-roof") continue;
    items.push({ key: fortressKey(b.piece), part: b.piece, origin: [b.position[0], b.position[1] - b.halfExtents[1], b.position[2]], yawDegrees: b.yawDegrees, bodies: [strip(b)] });
  }
  items.push({ key: fortressKey("keep-roof"), part: "keep-roof", origin: [centre(KEEP_ROOF)[0], KEEP_ROOF.min[1], centre(KEEP_ROOF)[2]], yawDegrees: 0, bodies: roof.map(strip) });
  return { units: "mmorpg-core units (100 per metre)", items, liftRise: LIFT_RISE, undressed: bodies.filter((b) => !b.piece).map(strip) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Build.

export function createFortressAssetSpec({ piece, lod, inputs, scriptSha256, blenderVersion }: {
  piece: FortressPiece; lod: 0 | 1 | 2; inputs: Record<string, BlenderSpecInput>; scriptSha256: string; blenderVersion: string;
}) {
  const { part, size, holes, hatches } = piece;
  return blenderScriptSpec({
    assetId: fortressKey(part), inputs: { script: { path: "fortress.py", sha256: scriptSha256 }, ...inputs }, blenderVersion,
    arguments: { schemaVersion: 1, part, lod, size, ...(holes ? { holes } : {}), ...(hatches ? { hatches } : {}) }, output: "fortress.glb",
  });
}

type Built = KitPart & { piece: FortressPiece; variant: string };

export async function buildFortressKit({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("fortress.py");
  const sources = JSON.parse(await readFile(path.join(ROOT, "catalog/sources.json"), "utf8"));
  const providers = JSON.parse(await readFile(path.join(ROOT, "catalog/providers.json"), "utf8"));
  const storage = JSON.parse(await readFile(path.join(ROOT, "catalog/storage.json"), "utf8"));
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const files: Record<string, Uint8Array> = { "fortress.py": source.bytes };
  const inputs: Record<string, BlenderSpecInput> = {};
  const textures: Record<string, AssetRef> = {};
  for (const [name, sourceId] of Object.entries(FORTRESS_TEXTURES)) {
    const asset = (await importAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
    const bytes = new Uint8Array(await resolveAssetObject(root, asset));
    files[`${name}.jpg`] = bytes;
    inputs[name] = { path: `${name}.jpg`, sha256: sha256Bytes(bytes) };
    textures[name] = asset;
  }
  const pieces = fortressPieces();
  const built: Built[] = [];
  for (const piece of pieces) {
    for (const [lod, variant] of [[0, "default"], [1, "lod1"], [2, "lod2"]] as const) {
      log(`generate ${piece.part} ${variant} (external.blender.script@1 fortress recipe, scene.import.gltf@2)`);
      built.push({ piece, variant, ...await buildKitPart(root, {
        workspace: path.join(root, "fortress", `${piece.part}.${variant}`), files,
        // The normal maps ship without tangents (as greyhaven-nature's do): the boolean-cut faces give MikkTSpace
        // zero tangents on some long slivers, so the runtime generates them instead.
        allowedValidatorWarnings: ["MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"],
        spec: createFortressAssetSpec({ piece, lod, inputs, scriptSha256: source.sha256, blenderVersion: source.blenderVersion }),
      }) });
    }
  }
  const levels = (part: FortressPart) => built.filter((b) => b.piece.part === part);

  log("measure the fortress-kit descriptor");
  const tan = Math.tan((FORTRESS_LOD_REFERENCE_FOV_Y / 2) * Math.PI / 180);
  const assets = pieces.map((piece) => {
    const [main, ...lods] = levels(piece.part);
    const bounds = documentBounds(main!.document);
    const radius = round(Math.hypot(...[0, 1, 2].map((k) => bounds.max[k]! - bounds.min[k]!)) / 2);
    return {
      key: fortressKey(piece.part), role: FORTRESS_ROLE[piece.part], fits: { size: piece.size, ...(piece.part.startsWith("ramp-") ? { rises: "+Z" } : {}) },
      ...(piece.holes ? { holes: piece.holes, hatches: piece.hatches } : {}),
      ...(BURIED[piece.part] ? { leavesToNeighbour: BURIED[piece.part] } : {}),
      triangles: triangles(main!.document), bounds, materials: main!.observations.materials,
      lods: {
        boundingSphere: { center: [0, 1, 2].map((k) => round((bounds.min[k]! + bounds.max[k]!) / 2)), radius },
        levels: [main!, ...lods].map((level, index) => {
          const minScreenSize = FORTRESS_LOD_SCREEN_SIZES[index] ?? 0;
          return { variant: level.variant, triangles: triangles(level.document), minScreenSize,
            referenceMaxDistance: minScreenSize ? round(Number((radius / (minScreenSize * tan)).toFixed(2))) : null };
        }),
      },
    };
  });
  const descriptor = {
    schema: FORTRESS_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", outward: "-Z", handedness: "right", origin: "fitted-box-base-centre",
    source: FORTRESS_SOURCE,
    placement: "Each piece is built at exactly its fitted box (fits.size, metres) and never reaches outside it: dressing over "
      + "authoritative collision. Place a piece at its item's origin (units) turned by yawDegrees about +Y (90 turns +Z to +X). "
      + "A lift piece follows its platform: origin = centre_at(tick) minus halfExtents[1] in y.",
    lodSelection: {
      metric: FORTRESS_LOD_METRIC,
      rule: "Use the first level whose minScreenSize is at most the piece's projected bounding-sphere diameter divided by the "
        + "viewport height (radius / (distance * tan(fovY / 2))). referenceMaxDistance is the distance in metres at which that "
        + "level ends at referenceFovYDegrees.",
      referenceFovYDegrees: FORTRESS_LOD_REFERENCE_FOV_Y,
    },
    assets, composition: fortressComposition(),
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "fortress-descriptor", mediaType: "application/json" })).asset;
  const selections = built.map((b) => ({
    key: fortressKey(b.piece.part), variant: b.variant,
    ...(b.piece.part === "curtain-wall" && b.variant === "default" ? { attachments: [{ name: FORTRESS_DESCRIPTOR_ATTACHMENT }] } : {}),
  }));
  const packed = await exportKitBundle(root, {
    tarName: FORTRESS_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: built.map((b) => b.asset), attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor, built,
    lineage: {
      recipe: { script: "adapters/blender/fortress.py", sha256: source.sha256, blenderVersion: source.blenderVersion }, release: FORTRESS_RELEASE,
      source: FORTRESS_SOURCE, textures, parts: Object.fromEntries(built.map((b) => [`${b.piece.part}.${b.variant}`, b.asset])), descriptor: descriptorAsset,
    },
  };
}

if (import.meta.main) {
  if (process.argv[2] === "--pieces") console.log(JSON.stringify({ pieces: fortressPieces(), composition: fortressComposition() }));
  else await runKitCli("scripts/build-fortress-kit.ts", "fortress", buildFortressKit, { descriptorFile: true });
}
