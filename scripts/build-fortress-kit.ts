// Build the Battle Royale fortress art kit (#445, docs/fortress-kit.md) from the scripted Blender recipe
// adapters/blender/fortress.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-fortress-kit.ts --out <directory>
// Each piece dresses one shared collider box (or ramp wedge, or lift pillar) of battle_royale_core::arena at the
// revision in FORTRESS_SOURCE; its walks and blocking faces match the box within 5 cm (fortressFit). Each piece and level of detail is one
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
import type { Document } from "@gltf-transform/core";
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
  wallColour: "poly-haven.broken-wall-diff-2k-jpg", wallNormal: "poly-haven.broken-wall-nor-gl-2k-jpg",
  wallRoughness: "poly-haven.broken-wall-rough-2k-jpg",
  trimColour: "poly-haven.japanese-stone-wall-diff-2k-jpg", trimNormal: "poly-haven.japanese-stone-wall-nor-gl-2k-jpg",
  trimRoughness: "poly-haven.japanese-stone-wall-rough-2k-jpg",
  floorColour: "poly-haven.stone-tiles-02-diff-2k-jpg", floorNormal: "poly-haven.stone-tiles-02-nor-gl-2k-jpg",
  floorRoughness: "poly-haven.stone-tiles-02-rough-2k-jpg",
  woodColour: "poly-haven.old-planks-02-diff-2k-jpg", woodNormal: "poly-haven.old-planks-02-nor-gl-2k-jpg",
  woodRoughness: "poly-haven.old-planks-02-rough-2k-jpg",
  // Displacement maps, used at build time only to darken the mortar and lift the proud stone edges.
  wallHeight: "poly-haven.broken-wall-disp-2k-jpg", trimHeight: "poly-haven.japanese-stone-wall-disp-2k-jpg",
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

/**
 * The fit rule (#459), per piece in its own frame (metres). What a character stands on or is blocked by matches the
 * collider within FORTRESS_FIT_TOLERANCE: every `walk` area is flush with its top (or the ramp slope) with
 * FORTRESS_HEAD_ROOM clear above it, and every blocking `faces` entry lies within the tolerance of the box face except
 * where an opening (slit, window, putlog hole) is cut deeper or decoration stands in front of it. Decoration may leave
 * the box, but no vertex leaves `reach`.
 */
export type FortressFit = {
  walk: { x: [number, number]; z: [number, number]; y: number | "slope"; except?: number[][] }[];
  faces: { axis: 0 | 2; sign: 1 | -1; along: [number, number]; y: [number, number] }[];
  reach: { min: [number, number, number]; max: [number, number, number] };
};
export const FORTRESS_FIT_TOLERANCE = 0.05;
export const FORTRESS_HEAD_ROOM = 2.2;

export function fortressFit(piece: FortressPiece): FortressFit {
  const [w, h, d] = piece.size;
  const box = (dx0: number, dy0: number, dz0: number, dx1: number, dy1: number, dz1: number) =>
    ({ min: [-w / 2 - dx0, -dy0, -d / 2 - dz0] as [number, number, number], max: [w / 2 + dx1, h + dy1, d / 2 + dz1] as [number, number, number] });
  const top = (inset = 0.05, outerParapet = 0) => ({ x: [-w / 2 + inset, w / 2 - inset] as [number, number], z: [-d / 2 + inset + outerParapet, d / 2 - inset] as [number, number], y: h });
  const zFaces = (along: [number, number], y: [number, number] = [0.1, h - 0.1]) =>
    [{ axis: 2 as const, sign: -1 as const, along, y }, { axis: 2 as const, sign: 1 as const, along, y }];
  const xFaces = (along: [number, number], y: [number, number] = [0.1, h - 0.1]) =>
    [{ axis: 0 as const, sign: -1 as const, along, y }, { axis: 0 as const, sign: 1 as const, along, y }];
  switch (piece.part) {
    case "curtain-wall":
      // The parapet stands on the outer 0.6 m; the last 5.6 m of either end may lie inside a corner tower.
      return { walk: [top(0.1, 0.55)], faces: [...zFaces([-w / 2 + 5.7, w / 2 - 0.2]), ...xFaces([-d / 2 + 0.1, d / 2 - 0.1])], reach: box(0, 0.6, 3.7, 0, 3.3, 1.3) };
    case "gate-lintel":
      return { walk: [top(0.05, 0.6)], faces: [], reach: box(6.4, 6.6, 5.0, 6.4, 6.0, 0.1) };
    case "parapet":
      // Its top is the crenels' sill under full-height merlons, not a walk; its faces block.
      return { walk: [], faces: zFaces([-w / 2 + 6, w / 2 - 6], [0.1, h - 0.1]), reach: box(0, 0, 0.05, 0, 1.8, 0.05) };
    case "corner-tower":
    case "central-tower": {
      const out = piece.part === "corner-tower" ? 2.6 : 1.0;
      return { walk: [top()], faces: [...zFaces([-w / 2 + 0.2, w / 2 - 0.2]), ...xFaces([-d / 2 + 0.2, d / 2 - 0.2])], reach: box(out, 0.6, out, out, 12.5, out) };
    }
    case "keep-wall-long":
    case "keep-wall-short":
    case "hall-wall": {
      const x0 = -w / 2 + (BURIED[piece.part] ? d : 0) + 0.2;
      return { walk: [], faces: zFaces([x0, w / 2 - 0.2]), reach: box(0, 0.6, 1.5, 0, 0, 0.05) };
    }
    case "door-lintel":
      return { walk: [], faces: [], reach: box(0, 1.4, 0.1, 0, 0, 0.1) };
    case "keep-roof":
      return { walk: [{ ...top(), except: piece.holes }], faces: [], reach: box(2.0, 3.5, 2.0, 2.0, 4.8, 2.0) };
    case "bridge":
      return { walk: [top()], faces: [], reach: box(0, 0.8, 0, 0, 0, 0) };
    case "lift-column":
      // Stands 0.1 m inside its box, clear of the lift pillar that shares its footprint (leavesToNeighbour).
      return { walk: [], faces: [], reach: box(0, 0, 0, 0, 0, 0) };
    case "ramp-courtyard":
    case "ramp-tower":
    case "ramp-keep":
      return { walk: [{ ...top(), y: "slope" }], faces: xFaces([-d / 2 + 0.3, d / 2 - 0.1]), reach: box(0, 0, 0, 0, 0, 0) };
    case "lift-courtyard":
    case "lift-tower":
      return { walk: [top()], faces: [], reach: box(0, 0, 0, 0, 0, 0) };
  }
}

/** Every triangle of the document in the world frame (9 numbers each), and its vertices. */
function geometry(document: Document) {
  const vertices: number[][] = [], triangles: number[] = [];
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION")!, p: number[] = [0, 0, 0];
      const base = vertices.length;
      for (let i = 0; i < position.getCount(); i += 1) {
        position.getElement(i, p);
        vertices.push([0, 1, 2].map((k) => m[k]! * p[0]! + m[4 + k]! * p[1]! + m[8 + k]! * p[2]! + m[12 + k]!));
      }
      const indices = primitive.getIndices();
      const count = indices ? indices.getCount() : position.getCount();
      for (let i = 0; i < count; i += 1) triangles.push(...vertices[base + (indices ? indices.getScalar(i) : i)]!);
    }
  }
  return { vertices, triangles: Float64Array.from(triangles) };
}

/**
 * Cast an axis-aligned ray from `origin` along `axis` (`sign` +-1) and return the distance to the first hit, or null.
 * `entering` keeps only faces whose normal points against the ray: the outside of a solid, not its back faces.
 */
function cast(t: Float64Array, origin: number[], axis: number, sign: number, maxDistance: number, entering = false): number | null {
  const [a, b] = [0, 1, 2].filter((k) => k !== axis) as [number, number];
  const oa = origin[a]!, ob = origin[b]!;
  let best: number | null = null;
  for (let i = 0; i < t.length; i += 9) {
    const x0 = t[i + a]!, x1 = t[i + 3 + a]!, x2 = t[i + 6 + a]!, y0 = t[i + b]!, y1 = t[i + 3 + b]!, y2 = t[i + 6 + b]!;
    if (oa < Math.min(x0, x1, x2) || oa > Math.max(x0, x1, x2) || ob < Math.min(y0, y1, y2) || ob > Math.max(y0, y1, y2)) continue;
    // Barycentric coordinates in the (a, b) plane give the hit's coordinate on `axis`.
    const det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(det) < 1e-12) continue;
    const l0 = ((y1 - y2) * (oa - x2) + (x2 - x1) * (ob - y2)) / det;
    const l1 = ((y2 - y0) * (oa - x2) + (x0 - x2) * (ob - y2)) / det;
    const l2 = 1 - l0 - l1;
    if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
    const distance = (l0 * t[i + axis]! + l1 * t[i + 3 + axis]! + l2 * t[i + 6 + axis]! - origin[axis]!) * sign;
    if (distance < 0 || distance > maxDistance || (best !== null && distance >= best)) continue;
    if (entering) {
      const e1 = [0, 1, 2].map((k) => t[i + 3 + k]! - t[i + k]!), e2 = [0, 1, 2].map((k) => t[i + 6 + k]! - t[i + k]!);
      const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      if (n[axis]! * sign >= 0) continue;
    }
    best = distance;
  }
  return best;
}

const steps = (from: number, to: number, step: number) => {
  const out: number[] = [];
  for (let v = from + step / 2; v < to; v += step) out.push(v);
  return out;
};

/** The largest share of a blocking face that openings (slits, windows, putlog holes) may sink below the tolerance. */
const MAX_OPENINGS = 0.08;

/** The #459 fit rule checked on one built level of one piece (its document as imported): the violations. */
export function fortressFitViolations(piece: FortressPiece, document: Document): string[] {
  const fit = fortressFit(piece);
  const [w, h, d] = piece.size;
  const { vertices, triangles } = geometry(document);
  const errors: string[] = [];
  const outside = vertices.find((v) => [0, 1, 2].some((k) => v[k]! < fit.reach.min[k]! - 1e-4 || v[k]! > fit.reach.max[k]! + 1e-4));
  if (outside) errors.push(`vertex ${outside.map((x) => x.toFixed(3))} leaves the decoration reach`);
  // Walks: coming down through the head room, the first surface is the top (or the slope) within the tolerance.
  const slope = (z: number) => (h * (z + d / 2)) / d;
  for (const area of fit.walk) {
    for (const x of steps(area.x[0], area.x[1], 0.37)) {
      for (const z of steps(area.z[0], area.z[1], 0.37)) {
        if (area.except?.some(([x0, z0, x1, z1]) => x > x0! - 0.03 && x < x1! + 0.03 && z > z0! - 0.03 && z < z1! + 0.03)) continue;
        const y = area.y === "slope" ? slope(z) : area.y;
        const from = y + FORTRESS_FIT_TOLERANCE + FORTRESS_HEAD_ROOM;
        const hit = cast(triangles, [x, from, z], 1, -1, FORTRESS_HEAD_ROOM + 1);
        const top = hit === null ? null : from - hit;
        if (top === null || Math.abs(top - y) > FORTRESS_FIT_TOLERANCE + 1e-3) {
          errors.push(`walk at (${x.toFixed(2)}, ${z.toFixed(2)}): top ${top?.toFixed(3)} for ${y.toFixed(3)}`);
        }
      }
    }
  }
  // Blocking faces: coming in from outside, the first surface lies within the tolerance of the box face, or further out
  // (decoration in front of it); openings may sink deeper on a small share of the face.
  const far = 12;
  for (const face of fit.faces) {
    const along = face.axis === 2 ? 0 : 2;
    const half = (face.axis === 2 ? d : w) / 2;
    const name = `${face.sign > 0 ? "+" : "-"}${"xyz"[face.axis]}`;
    let samples = 0, sunk = 0;
    for (const s of steps(face.along[0], face.along[1], 0.5)) {
      for (const y of steps(face.y[0], face.y[1], 0.5)) {
        if (fit.walk[0]?.y === "slope" && y > slope(s) - 0.1) continue;
        const origin = [0, y, 0];
        origin[along] = s;
        origin[face.axis] = face.sign * (half + far);
        const hit = cast(triangles, origin, face.axis, -face.sign, far + half, true);
        samples += 1;
        // Sunk: the first surface lies deeper than the tolerance (or the ray finds none, through an opening).
        if (hit === null || hit - far > FORTRESS_FIT_TOLERANCE + 1e-3) sunk += 1;
      }
    }
    if (samples && sunk / samples > MAX_OPENINGS) errors.push(`face ${name}: ${sunk} of ${samples} samples sunk deeper than the tolerance`);
  }
  return errors;
}

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
    placement: "Each piece dresses its fitted box (fits.size, metres) over authoritative collision: its walkable tops, ramp slopes "
      + "and blocking faces match the box within 5 cm, and decoration (merlons, buttresses, roofs, hoardings, rubble) may reach "
      + "outside it as far as bounds says, never into the head room above a walk. "
      + "Place a piece at its item's origin (units) turned by yawDegrees about +Y (90 turns +Z to +X). "
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
