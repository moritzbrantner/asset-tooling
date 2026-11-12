/**
 * Terrain patches and cosmetic detail scatter sampled from one world-space function (#134).
 *
 * Every height, normal, mask and detail candidate is a pure function of its global integer sample or cell
 * index, so adjacent patches share edges exactly and patches may be generated in any order. Docs:
 * docs/terrain-patches.md.
 */
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { Document, NodeIO } from "@gltf-transform/core";
import { canonicalJson } from "./canonical.js";
import { sha256Bytes } from "./hash.js";

export type Vec2 = [number, number];
export type TerrainShape =
  | { kind: "circle"; center: Vec2; radius: number; falloff: number }
  | { kind: "rect"; center: Vec2; size: Vec2; rotationDegrees: number; falloff: number }
  | { kind: "polyline"; points: Vec2[]; width: number; falloff: number };
export type TerrainEdit =
  | { kind: "flatten"; shape: TerrainShape; height: number; excludeDetail: boolean }
  | { kind: "path"; points: Vec2[]; width: number; falloff: number; excludeDetail: boolean };
export type TerrainShaping =
  | { kind: "noise" }
  | { kind: "island"; center: Vec2; radius: number; falloff: number; seaLevel: number }
  | { kind: "terrace"; step: number; sharpness: number };
export type TerrainDetailLayer = {
  id: string; density: number; minSpacing: number; slopeDegrees: Vec2; height: Vec2;
  maxExclusion: number; paint: string | null; scale: Vec2; variants: number;
  /** Schema 2 only: this layer's own seed group. Schema 1 layers draw from the recipe `seed`. */
  seed?: number;
};
export type TerrainPatchRecipe = {
  /** Schema 2 adds a required `seed` per detail layer; `seed` then drives only the height. */
  schemaVersion: 1 | 2; id: string; seed: number; origin: Vec2; sampleSpacing: number; samples: Vec2;
  height: { min: number; max: number; precision: number };
  noise: { baseHeight: number; amplitude: number; featureSize: number; octaves: number; roughness: number };
  shaping: TerrainShaping; edits: TerrainEdit[]; exclusions: TerrainShape[];
  paint: Record<string, TerrainShape[]>; detail: TerrainDetailLayer[];
};
export type TerrainDetailInstance = { id: string; layer: string; cell: Vec2; position: [number, number, number]; yaw: number; scale: number; variant: number };
export type TerrainPatch = {
  recipe: TerrainPatchRecipe; patch: Vec2; firstSample: Vec2; origin: Vec2; width: number; depth: number;
  /** Row-major (+Z rows of +X columns) height steps above `height.min`, `precision` metres each. */
  heights: Uint16Array; normals: Float32Array;
  /** Q8 masks on the same samples: slope 0..90 degrees, detail exclusion and each paint layer. */
  slope: Uint8Array; exclusion: Uint8Array; paint: Record<string, Uint8Array>;
};

const MAX_SAMPLES = 257, MAX_STEPS = 65535, MAX_INSTANCES = 65536, MAX_COORDINATE = 1e6;

// ---------- validation ----------
function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const v = value as Record<string, unknown>;
  for (const k of Object.keys(v)) if (!keys.includes(k)) throw new Error(`${label} contains unknown field '${k}'`);
  for (const k of keys) if (!Object.hasOwn(v, k)) throw new Error(`${label} is missing '${k}'`);
  return v;
}
function num(value: unknown, label: string, min = -MAX_COORDINATE, max = MAX_COORDINATE): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be a finite number in ${min}..${max}`);
  return value;
}
function int(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label} must be an integer in ${min}..${max}`);
  return value as number;
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}
function token(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value) || value.length > 64) throw new Error(`${label} must be a lowercase token`);
  return value;
}
function vec2(value: unknown, label: string, min?: number, max?: number): Vec2 {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${label} must be a pair`);
  return [num(value[0], `${label}[0]`, min, max), num(value[1], `${label}[1]`, min, max)];
}
function range(value: unknown, label: string, min?: number, max?: number): Vec2 {
  const r = vec2(value, label, min, max);
  if (r[0] > r[1]) throw new Error(`${label} must be ordered low to high`);
  return r;
}
function points(value: unknown, label: string): Vec2[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 256) throw new Error(`${label} must list 2..256 points`);
  return value.map((p, i) => vec2(p, `${label}[${i}]`));
}
function shape(value: unknown, label: string): TerrainShape {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind === "circle") {
    const v = record(value, ["kind", "center", "radius", "falloff"], label);
    return { kind, center: vec2(v.center, `${label}.center`), radius: num(v.radius, `${label}.radius`, 0), falloff: num(v.falloff, `${label}.falloff`, 0) };
  }
  if (kind === "rect") {
    const v = record(value, ["kind", "center", "size", "rotationDegrees", "falloff"], label);
    return { kind, center: vec2(v.center, `${label}.center`), size: vec2(v.size, `${label}.size`, 0),
      rotationDegrees: num(v.rotationDegrees, `${label}.rotationDegrees`, -360, 360), falloff: num(v.falloff, `${label}.falloff`, 0) };
  }
  if (kind === "polyline") {
    const v = record(value, ["kind", "points", "width", "falloff"], label);
    return { kind, points: points(v.points, `${label}.points`), width: num(v.width, `${label}.width`, 0), falloff: num(v.falloff, `${label}.falloff`, 0) };
  }
  throw new Error(`${label}.kind must be circle, rect or polyline`);
}

/** Validates a complete recipe; there are no implicit defaults. */
export function normalizeTerrainPatchRecipe(value: unknown): TerrainPatchRecipe {
  const v = record(value, ["schemaVersion", "id", "seed", "origin", "sampleSpacing", "samples", "height", "noise", "shaping", "edits", "exclusions", "paint", "detail"], "terrain patch recipe");
  if (v.schemaVersion !== 1 && v.schemaVersion !== 2) throw new Error("terrain patch recipe schemaVersion must be 1 or 2");
  const schemaVersion = v.schemaVersion;
  const h = record(v.height, ["min", "max", "precision"], "height");
  const height = { min: num(h.min, "height.min"), max: num(h.max, "height.max"), precision: num(h.precision, "height.precision", 0.0001, 1) };
  if (!(height.max > height.min)) throw new Error("height.max must be above height.min");
  if ((height.max - height.min) / height.precision > MAX_STEPS) throw new Error(`height range / precision must fit ${MAX_STEPS} steps`);
  const n = record(v.noise, ["baseHeight", "amplitude", "featureSize", "octaves", "roughness"], "noise");
  const noise = { baseHeight: num(n.baseHeight, "noise.baseHeight"), amplitude: num(n.amplitude, "noise.amplitude", 0, 10000),
    featureSize: num(n.featureSize, "noise.featureSize", 0.5, 100000), octaves: int(n.octaves, "noise.octaves", 1, 8), roughness: num(n.roughness, "noise.roughness", 0, 1) };
  const sk = (v.shaping as { kind?: unknown } | null)?.kind;
  let shaping: TerrainShaping;
  if (sk === "noise") { record(v.shaping, ["kind"], "shaping"); shaping = { kind: sk }; }
  else if (sk === "island") {
    const s = record(v.shaping, ["kind", "center", "radius", "falloff", "seaLevel"], "shaping");
    shaping = { kind: sk, center: vec2(s.center, "shaping.center"), radius: num(s.radius, "shaping.radius", 0), falloff: num(s.falloff, "shaping.falloff", 0), seaLevel: num(s.seaLevel, "shaping.seaLevel") };
  } else if (sk === "terrace") {
    const s = record(v.shaping, ["kind", "step", "sharpness"], "shaping");
    shaping = { kind: sk, step: num(s.step, "shaping.step", 0.01), sharpness: num(s.sharpness, "shaping.sharpness", 0, 0.95) };
  } else throw new Error("shaping.kind must be noise, island or terrace");
  if (!Array.isArray(v.edits) || v.edits.length > 64) throw new Error("edits must be an array of at most 64 entries");
  const edits = v.edits.map((e, i): TerrainEdit => {
    const kind = (e as { kind?: unknown } | null)?.kind, label = `edits[${i}]`;
    if (kind === "flatten") {
      const r = record(e, ["kind", "shape", "height", "excludeDetail"], label);
      return { kind, shape: shape(r.shape, `${label}.shape`), height: num(r.height, `${label}.height`), excludeDetail: bool(r.excludeDetail, `${label}.excludeDetail`) };
    }
    if (kind === "path") {
      const r = record(e, ["kind", "points", "width", "falloff", "excludeDetail"], label);
      return { kind, points: points(r.points, `${label}.points`), width: num(r.width, `${label}.width`, 0), falloff: num(r.falloff, `${label}.falloff`, 0), excludeDetail: bool(r.excludeDetail, `${label}.excludeDetail`) };
    }
    throw new Error(`${label}.kind must be flatten or path`);
  });
  if (!Array.isArray(v.exclusions) || v.exclusions.length > 256) throw new Error("exclusions must be an array of at most 256 shapes");
  const exclusions = v.exclusions.map((s, i) => shape(s, `exclusions[${i}]`));
  const paintSource = record(v.paint, Object.keys((v.paint ?? {}) as object), "paint");
  const paint: Record<string, TerrainShape[]> = {};
  for (const name of Object.keys(paintSource).sort()) {
    const list = paintSource[name];
    if (!Array.isArray(list) || list.length > 256) throw new Error(`paint.${name} must be an array of at most 256 shapes`);
    paint[token(name, `paint key '${name}'`)] = list.map((s, i) => shape(s, `paint.${name}[${i}]`));
  }
  if (!Array.isArray(v.detail) || v.detail.length > 32) throw new Error("detail must be an array of at most 32 layers");
  const ids = new Set<string>();
  const detail = v.detail.map((d, i): TerrainDetailLayer => {
    const label = `detail[${i}]`;
    const r = record(d, ["id", "density", "minSpacing", "slopeDegrees", "height", "maxExclusion", "paint", "scale", "variants", ...(schemaVersion === 2 ? ["seed"] : [])], label);
    const layer: TerrainDetailLayer = { id: token(r.id, `${label}.id`), density: num(r.density, `${label}.density`, 1e-6, 100), minSpacing: num(r.minSpacing, `${label}.minSpacing`, 0.01, 1000),
      slopeDegrees: range(r.slopeDegrees, `${label}.slopeDegrees`, 0, 90), height: range(r.height, `${label}.height`), maxExclusion: num(r.maxExclusion, `${label}.maxExclusion`, 0, 1),
      paint: r.paint === null ? null : token(r.paint, `${label}.paint`), scale: range(r.scale, `${label}.scale`, 0.001, 1000), variants: int(r.variants, `${label}.variants`, 1, 256),
      ...(schemaVersion === 2 ? { seed: int(r.seed, `${label}.seed`, 0, 0xffffffff) } : {}) };
    if (ids.has(layer.id)) throw new Error(`duplicate detail layer '${layer.id}'`);
    ids.add(layer.id);
    if (layer.density * layer.minSpacing ** 2 > 1) throw new Error(`${label}.density cannot be packed at minSpacing (density × minSpacing² must be ≤ 1)`);
    if (layer.paint !== null && !Object.hasOwn(paint, layer.paint)) throw new Error(`${label}.paint names undeclared paint layer '${layer.paint}'`);
    return layer;
  });
  if (!Array.isArray(v.samples) || v.samples.length !== 2) throw new Error("samples must be a pair");
  const samples: Vec2 = [int(v.samples[0], "samples[0]", 2, MAX_SAMPLES), int(v.samples[1], "samples[1]", 2, MAX_SAMPLES)];
  return { schemaVersion, id: token(v.id, "id"), seed: int(v.seed, "seed", 0, 0xffffffff), origin: vec2(v.origin, "origin"),
    sampleSpacing: num(v.sampleSpacing, "sampleSpacing", 0.01, 64), samples, height, noise, shaping, edits, exclusions, paint, detail };
}

// ---------- world function ----------
/** 32-bit integer hash of a word sequence (lowbias32 mixing); identical on every platform. */
export function terrainHash(...words: number[]): number {
  let h = 0x9e3779b9;
  for (const w of words) {
    h = Math.imul(h ^ (w | 0), 0x85ebca6b);
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
  }
  return h >>> 0;
}
const unit = (h: number) => h / 4294967296;
function stringSalt(text: string): number { let h = 0; for (const c of text) h = terrainHash(h, c.codePointAt(0)!); return h; }
const smooth = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
function smoothstep(t: number) { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); }

function valueNoise(seed: number, octave: number, x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z), fx = smooth(x - ix), fz = smooth(z - iz);
  const v = (a: number, b: number) => unit(terrainHash(seed, octave, a, b)) * 2 - 1;
  const top = v(ix, iz) + (v(ix + 1, iz) - v(ix, iz)) * fx, bottom = v(ix, iz + 1) + (v(ix + 1, iz + 1) - v(ix, iz + 1)) * fx;
  return top + (bottom - top) * fz;
}
function fbm(r: TerrainPatchRecipe, x: number, z: number): number {
  let sum = 0, weight = 0, amplitude = 1, frequency = 1 / r.noise.featureSize;
  for (let o = 0; o < r.noise.octaves; o += 1) {
    sum += amplitude * valueNoise(r.seed, o, x * frequency, z * frequency);
    weight += amplitude; amplitude *= r.noise.roughness; frequency *= 2;
  }
  return sum / weight;
}

function segmentDistance(px: number, pz: number, a: Vec2, b: Vec2): { distance: number; t: number } {
  const dx = b[0] - a[0], dz = b[1] - a[1], length2 = dx * dx + dz * dz;
  const t = length2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - a[0]) * dx + (pz - a[1]) * dz) / length2));
  return { distance: Math.hypot(px - a[0] - t * dx, pz - a[1] - t * dz), t };
}
function nearestOnPolyline(px: number, pz: number, line: readonly Vec2[]): { distance: number; point: Vec2 } {
  let best = { distance: Infinity, point: line[0]! };
  for (let i = 0; i + 1 < line.length; i += 1) {
    const a = line[i]!, b = line[i + 1]!, s = segmentDistance(px, pz, a, b);
    if (s.distance < best.distance) best = { distance: s.distance, point: [a[0] + s.t * (b[0] - a[0]), a[1] + s.t * (b[1] - a[1])] };
  }
  return best;
}
/** Signed distance from a shape's edge (negative inside). */
function shapeDistance(s: TerrainShape, x: number, z: number): number {
  if (s.kind === "circle") return Math.hypot(x - s.center[0], z - s.center[1]) - s.radius;
  if (s.kind === "polyline") return nearestOnPolyline(x, z, s.points).distance - s.width / 2;
  const a = -s.rotationDegrees * Math.PI / 180, dx = x - s.center[0], dz = z - s.center[1];
  const lx = Math.abs(dx * Math.cos(a) - dz * Math.sin(a)) - s.size[0] / 2, lz = Math.abs(dx * Math.sin(a) + dz * Math.cos(a)) - s.size[1] / 2;
  return Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) + Math.min(Math.max(lx, lz), 0);
}
/** 1 inside, smoothstep to 0 across `falloff` metres outside, 0 beyond. */
export function terrainShapeWeight(s: TerrainShape, x: number, z: number): number {
  const d = shapeDistance(s, x, z);
  if (d <= 0) return 1;
  return s.falloff > 0 && d < s.falloff ? smoothstep(1 - d / s.falloff) : 0;
}

function shapedHeight(r: TerrainPatchRecipe, x: number, z: number): number {
  const n = r.noise.baseHeight + r.noise.amplitude * fbm(r, x, z), s = r.shaping;
  if (s.kind === "island") {
    const d = Math.hypot(x - s.center[0], z - s.center[1]) - s.radius;
    const w = d <= 0 ? 1 : s.falloff > 0 && d < s.falloff ? smoothstep(1 - d / s.falloff) : 0;
    return s.seaLevel + (n - s.seaLevel) * w;
  }
  if (s.kind === "terrace") {
    const k = n / s.step, level = Math.floor(k), f = k - level, edge = 1 - s.sharpness;
    return (level + (f < 1 - edge ? 0 : smoothstep((f - (1 - edge)) / edge))) * s.step;
  }
  return n;
}
function editedHeight(r: TerrainPatchRecipe, x: number, z: number, upTo = r.edits.length): number {
  let h = shapedHeight(r, x, z);
  for (let i = 0; i < upTo; i += 1) {
    const e = r.edits[i]!;
    if (e.kind === "flatten") {
      const w = terrainShapeWeight(e.shape, x, z);
      if (w > 0) h += (e.height - h) * w;
    } else {
      const near = nearestOnPolyline(x, z, e.points), d = near.distance - e.width / 2;
      const w = d <= 0 ? 1 : e.falloff > 0 && d < e.falloff ? smoothstep(1 - d / e.falloff) : 0;
      // Level the path's cross-section to the height at its centreline, as it stood before this edit.
      if (w > 0) h += (editedHeight(r, near.point[0], near.point[1], i) - h) * w;
    }
  }
  return h;
}

/** World X/Z of a global sample index. Every patch uses this one expression, so shared samples are bit-identical. */
export const terrainSampleWorld = (r: TerrainPatchRecipe, gx: number, gz: number): Vec2 => [r.origin[0] + gx * r.sampleSpacing, r.origin[1] + gz * r.sampleSpacing];

let heightEvaluations = 0;
/**
 * How many terrain height samples this process has evaluated. Partial rebuilds read it before and after to prove a
 * preserved height was decoded, not recomputed into equal bytes.
 */
export const terrainHeightEvaluations = () => heightEvaluations;

/** Quantized height step of a global sample; fails closed when the terrain leaves the declared range. */
export function terrainHeightStep(r: TerrainPatchRecipe, gx: number, gz: number): number {
  heightEvaluations += 1;
  const [x, z] = terrainSampleWorld(r, gx, gz), h = editedHeight(r, x, z);
  const q = Math.round((h - r.height.min) / r.height.precision);
  if (!Number.isFinite(q) || q < 0 || q * r.height.precision > r.height.max - r.height.min + r.height.precision / 2) {
    throw new Error(`terrain height ${h.toFixed(3)} m at (${x}, ${z}) is outside the declared range ${r.height.min}..${r.height.max} m`);
  }
  return q;
}
export const terrainStepHeight = (r: TerrainPatchRecipe, step: number) => r.height.min + step * r.height.precision;
const sampledHeight = (r: TerrainPatchRecipe, gx: number, gz: number) => terrainStepHeight(r, terrainHeightStep(r, gx, gz));

function exclusionWeight(r: TerrainPatchRecipe, x: number, z: number): number {
  let w = 0;
  for (const e of r.edits) {
    if (!e.excludeDetail) continue;
    w = Math.max(w, e.kind === "flatten" ? terrainShapeWeight(e.shape, x, z) : terrainShapeWeight({ kind: "polyline", points: e.points, width: e.width, falloff: e.falloff }, x, z));
  }
  for (const s of r.exclusions) w = Math.max(w, terrainShapeWeight(s, x, z));
  return w;
}
const paintWeight = (shapes: readonly TerrainShape[], x: number, z: number) => shapes.reduce((w, s) => Math.max(w, terrainShapeWeight(s, x, z)), 0);
const q8 = (w: number) => Math.round(Math.min(1, Math.max(0, w)) * 255);

// ---------- patches ----------
/**
 * Patch (px, pz) starts at global sample (px·(samplesX−1), pz·(samplesZ−1)): neighbours share their edge row/column.
 * Normals use central differences over the same world function, reading one sample beyond the patch border.
 */
export function generateTerrainPatch(recipeValue: unknown, patch: Vec2): TerrainPatch {
  const r = normalizeTerrainPatchRecipe(recipeValue), g = patchGrid(r, patch);
  const { heights, normals, slope } = heightComponent(r, g);
  const paint = Object.fromEntries(Object.keys(r.paint).map((name) => [name, maskComponent(r, g, (x, z) => paintWeight(r.paint[name]!, x, z))]));
  return { ...g, recipe: r, heights, normals, slope, exclusion: maskComponent(r, g, (x, z) => exclusionWeight(r, x, z)), paint };
}

type PatchGrid = Pick<TerrainPatch, "patch" | "firstSample" | "origin" | "width" | "depth">;
function patchGrid(r: TerrainPatchRecipe, patch: Vec2): PatchGrid {
  const [px, pz] = [int(patch[0], "patch[0]", -100000, 100000), int(patch[1], "patch[1]", -100000, 100000)];
  const [w, d] = r.samples, gx0 = px * (w - 1), gz0 = pz * (d - 1);
  return { patch: [px, pz], firstSample: [gx0, gz0], origin: terrainSampleWorld(r, gx0, gz0), width: w, depth: d };
}
/** Heights, normals and slope: the only part of a patch that evaluates the terrain noise. */
function heightComponent(r: TerrainPatchRecipe, g: PatchGrid) {
  const { width: w, depth: d, firstSample: [gx0, gz0] } = g;
  const apron = new Float64Array((w + 2) * (d + 2));
  for (let j = -1; j <= d; j += 1) for (let i = -1; i <= w; i += 1) apron[(j + 1) * (w + 2) + i + 1] = sampledHeight(r, gx0 + i, gz0 + j);
  const at = (i: number, j: number) => apron[(j + 1) * (w + 2) + i + 1]!;
  const heights = new Uint16Array(w * d), normals = new Float32Array(w * d * 3), slope = new Uint8Array(w * d);
  for (let j = 0; j < d; j += 1) for (let i = 0; i < w; i += 1) {
    const k = j * w + i;
    heights[k] = Math.round((at(i, j) - r.height.min) / r.height.precision);
    const nx = -(at(i + 1, j) - at(i - 1, j)) / (2 * r.sampleSpacing), nz = -(at(i, j + 1) - at(i, j - 1)) / (2 * r.sampleSpacing), length = Math.hypot(nx, 1, nz);
    normals.set([nx / length, 1 / length, nz / length], k * 3);
    slope[k] = Math.round(Math.acos(1 / length) * 180 / Math.PI / 90 * 255);
  }
  return { heights, normals, slope };
}
function maskComponent(r: TerrainPatchRecipe, g: PatchGrid, weight: (x: number, z: number) => number): Uint8Array {
  const mask = new Uint8Array(g.width * g.depth);
  for (let j = 0; j < g.depth; j += 1) for (let i = 0; i < g.width; i += 1) {
    const [x, z] = terrainSampleWorld(r, g.firstSample[0] + i, g.firstSample[1] + j);
    mask[j * g.width + i] = q8(weight(x, z));
  }
  return mask;
}

/** Height and face slope of the mesh surface at a world point (cells split along their (i,j)–(i+1,j+1) diagonal). */
export function terrainSurfaceAt(r: TerrainPatchRecipe, x: number, z: number): { height: number; slopeDegrees: number } {
  return surfaceAt(r, x, z, (gx, gz) => sampledHeight(r, gx, gz));
}
function surfaceAt(r: TerrainPatchRecipe, x: number, z: number, heightAt: (gx: number, gz: number) => number) {
  const u = (x - r.origin[0]) / r.sampleSpacing, v = (z - r.origin[1]) / r.sampleSpacing, gx = Math.floor(u), gz = Math.floor(v), fx = u - gx, fz = v - gz;
  const h00 = heightAt(gx, gz), h11 = heightAt(gx + 1, gz + 1), s = r.sampleSpacing;
  let height: number, dx: number, dz: number;
  if (fx >= fz) { const h10 = heightAt(gx + 1, gz); dx = h10 - h00; dz = h11 - h10; height = h00 + dx * fx + dz * fz; }
  else { const h01 = heightAt(gx, gz + 1); dz = h01 - h00; dx = h11 - h01; height = h00 + dx * fx + dz * fz; }
  return { height, slopeDegrees: Math.atan(Math.hypot(dx, dz) / s) * 180 / Math.PI };
}

const round4 = (value: number) => { const r = Math.round(value * 1e4) / 1e4; return r === 0 ? 0 : r; };
/** The seed a detail layer draws from: its own seed group in schema 2, the recipe seed in schema 1. */
export const terrainDetailSeed = (r: TerrainPatchRecipe, layer: TerrainDetailLayer) => layer.seed ?? r.seed;

/**
 * Cosmetic detail for one patch. Each layer splits the world into square cells of side max(minSpacing, 1/√density);
 * a cell is occupied with probability density·cell² and then holds one candidate anywhere inside it. Of two raw
 * candidates closer than minSpacing, the one with the lower hash priority is dropped, so the realised density falls
 * below `density` as density·minSpacing² approaches 1. Occupancy, position, priority, yaw, scale and variant derive
 * only from (layer seed, layer id, cell), and the spacing test reads raw candidates, so filters only remove detail and
 * an edit never moves or adds detail elsewhere. A patch owns the candidates in its half-open extent
 * [origin, origin + (samples − 1)·spacing).
 */
export function scatterTerrainDetail(patch: TerrainPatch): TerrainDetailInstance[] {
  const out: TerrainDetailInstance[] = [];
  for (const layer of patch.recipe.detail) {
    out.push(...scatterLayer(patch.recipe, patch, patch.heights, layer));
    if (out.length > MAX_INSTANCES) throw new Error(`terrain patch detail exceeds ${MAX_INSTANCES} instances`);
  }
  return out;
}
/** One layer's detail, reading surface heights from the patch's own height steps (it never re-evaluates noise inside the patch). */
function scatterLayer(r: TerrainPatchRecipe, g: PatchGrid, heights: Uint16Array, layer: TerrainDetailLayer): TerrainDetailInstance[] {
  const x0 = g.origin[0], z0 = g.origin[1], seed = terrainDetailSeed(r, layer);
  const x1 = terrainSampleWorld(r, g.firstSample[0] + g.width - 1, 0)[0], z1 = terrainSampleWorld(r, 0, g.firstSample[1] + g.depth - 1)[1];
  const heightAt = (gx: number, gz: number) => {
    const i = gx - g.firstSample[0], j = gz - g.firstSample[1];
    return i >= 0 && i < g.width && j >= 0 && j < g.depth ? terrainStepHeight(r, heights[j * g.width + i]!) : sampledHeight(r, gx, gz);
  };
  const out: TerrainDetailInstance[] = [];
  const salt = stringSalt(layer.id), cell = Math.max(layer.minSpacing, 1 / Math.sqrt(layer.density)), occupancy = layer.density * cell * cell;
  const candidate = (cx: number, cz: number) => {
    const h = (k: number) => terrainHash(seed, salt, cx, cz, k);
    return unit(h(0)) < occupancy ? { x: (cx + unit(h(1))) * cell, z: (cz + unit(h(2))) * cell, priority: h(7) } : null;
  };
  for (let cz = Math.floor(z0 / cell); cz * cell < z1; cz += 1) for (let cx = Math.floor(x0 / cell); cx * cell < x1; cx += 1) {
    const rnd = (k: number) => unit(terrainHash(seed, salt, cx, cz, k));
    const own = candidate(cx, cz);
    if (!own) continue;
    const { x, z } = own;
    if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
    // Spacing: of two raw candidates closer than minSpacing (only neighbouring cells can be), the lower priority yields.
    let yields = false;
    for (let dz = -1; dz <= 1 && !yields; dz += 1) for (let dx = -1; dx <= 1 && !yields; dx += 1) {
      const other = dx === 0 && dz === 0 ? null : candidate(cx + dx, cz + dz);
      if (other && Math.hypot(other.x - x, other.z - z) < layer.minSpacing
        && (other.priority > own.priority || (other.priority === own.priority && (dz > 0 || (dz === 0 && dx > 0))))) yields = true;
    }
    if (yields) continue;
    if (exclusionWeight(r, x, z) > layer.maxExclusion) continue;
    if (layer.paint !== null && paintWeight(r.paint[layer.paint]!, x, z) < rnd(3)) continue;
    const surface = surfaceAt(r, x, z, heightAt);
    if (surface.slopeDegrees < layer.slopeDegrees[0] || surface.slopeDegrees > layer.slopeDegrees[1]) continue;
    if (surface.height < layer.height[0] || surface.height > layer.height[1]) continue;
    out.push({ id: `${layer.id}:${cx}:${cz}`, layer: layer.id, cell: [cx, cz], position: [round4(x), round4(surface.height), round4(z)],
      yaw: round4(rnd(4) * 2 * Math.PI), scale: round4(layer.scale[0] + rnd(5) * (layer.scale[1] - layer.scale[0])), variant: Math.floor(rnd(6) * layer.variants) });
    if (out.length > MAX_INSTANCES) throw new Error(`terrain patch detail exceeds ${MAX_INSTANCES} instances`);
  }
  return out;
}

// ---------- encodings ----------
function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]), out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
  return out;
}
/** Deterministic linear grayscale PNG, 8- or 16-bit (big-endian samples), filter 0, zlib level 9, no metadata. */
export function encodeGrayPng(width: number, height: number, samples: Uint8Array | Uint16Array): Buffer {
  if (samples.length !== width * height) throw new Error("sample buffer does not match the image size");
  const bytes = samples instanceof Uint16Array ? 2 : 1, header = Buffer.alloc(13), stride = width * bytes + 1, raw = Buffer.alloc(stride * height);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([bytes * 8, 0, 0, 0, 0], 8);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const value = samples[y * width + x]!, at = y * stride + 1 + x * bytes;
    if (bytes === 2) raw.writeUInt16BE(value, at); else raw[at] = value;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })), pngChunk("IEND", new Uint8Array())]);
}

/**
 * The patch as a GLB: one node translated to the patch origin, positions local to it, the computed normals and a white
 * COLOR_0. No UVs: sample terrain materials at world X/Z so they continue across patches.
 */
export async function terrainPatchGlb(patch: TerrainPatch, materialName = "terrain"): Promise<Uint8Array> {
  const r = patch.recipe, { width: w, depth: d } = patch, positions = new Float32Array(w * d * 3);
  for (let j = 0; j < d; j += 1) for (let i = 0; i < w; i += 1) {
    const k = j * w + i;
    positions.set([i * r.sampleSpacing, terrainStepHeight(r, patch.heights[k]!), j * r.sampleSpacing], k * 3);
  }
  const indices = w * d > 65535 ? new Uint32Array((w - 1) * (d - 1) * 6) : new Uint16Array((w - 1) * (d - 1) * 6);
  let n = 0;
  for (let j = 0; j + 1 < d; j += 1) for (let i = 0; i + 1 < w; i += 1) {
    const a = j * w + i, b = a + 1, c = a + w, e = c + 1;
    indices.set([a, e, b, a, c, e], n); n += 6;
  }
  const doc = new Document(), buffer = doc.createBuffer();
  const accessor = (type: "VEC3" | "VEC4" | "SCALAR", array: Float32Array | Uint16Array | Uint32Array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const prim = doc.createPrimitive().setIndices(accessor("SCALAR", indices)).setAttribute("POSITION", accessor("VEC3", positions))
    .setAttribute("NORMAL", accessor("VEC3", patch.normals.slice())).setAttribute("COLOR_0", accessor("VEC4", new Float32Array(w * d * 4).fill(1)))
    .setMaterial(doc.createMaterial(materialName).setRoughnessFactor(1).setMetallicFactor(0));
  const name = `${r.id}_${patch.patch[0]}_${patch.patch[1]}`;
  const node = doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)).setTranslation([patch.origin[0], 0, patch.origin[1]]);
  doc.createScene(name).addChild(node);
  return new NodeIO().writeBinary(doc);
}

/** A ready-to-edit recipe per preset; every field stays explicit in the copy you edit. */
export const TERRAIN_PATCH_PRESETS: Readonly<Record<"flat" | "rolling" | "island" | "terrace", TerrainPatchRecipe>> = Object.freeze({
  flat: preset("flat", { baseHeight: 0, amplitude: 0.15, featureSize: 6, octaves: 3, roughness: 0.5 }, { kind: "noise" }),
  rolling: preset("rolling", { baseHeight: 4, amplitude: 6, featureSize: 80, octaves: 5, roughness: 0.45 }, { kind: "noise" }),
  island: preset("island", { baseHeight: 6, amplitude: 5, featureSize: 60, octaves: 5, roughness: 0.5 }, { kind: "island", center: [64, 64], radius: 30, falloff: 34, seaLevel: -2 }),
  terrace: preset("terrace", { baseHeight: 6, amplitude: 9, featureSize: 70, octaves: 4, roughness: 0.4 }, { kind: "terrace", step: 2.5, sharpness: 0.7 }),
});
function preset(id: string, noise: TerrainPatchRecipe["noise"], shaping: TerrainShaping): TerrainPatchRecipe {
  return { schemaVersion: 1, id, seed: 134, origin: [0, 0], sampleSpacing: 1, samples: [65, 65], height: { min: -8, max: 24, precision: 0.001 },
    noise, shaping, edits: [], exclusions: [], paint: {}, detail: [] };
}

// ---------- component builds and partial rebuilds (#139) ----------
/** Schema of the per-patch build record that pins each component's dependency key and output bytes. */
export const TERRAIN_PATCH_BUILD_SCHEMA = "terrain-patch-build-v1";
/** Bump when a component's generation semantics change: every key changes with it, so nothing stale is reused. */
const COMPONENT_SEMANTICS = "terrain-patch-components@1";

export type TerrainPatchComponentRecord = {
  /** SHA-256 of the canonical inputs the component actually depends on, including upstream component keys. */
  key: string;
  /** Output file name → SHA-256 of its bytes. */
  files: Record<string, string>;
  /** Detail layers only: SHA-256 of the layer's canonical instances inside `detail.json`. */
  instances?: string;
};
export type TerrainPatchBuildRecord = { schema: typeof TERRAIN_PATCH_BUILD_SCHEMA; patch: Vec2; components: Record<string, TerrainPatchComponentRecord> };
export type TerrainPatchBuildOptions = {
  /** An earlier build of the same patch: its record and a reader for the bytes it wrote. Bytes are verified before reuse. */
  previous?: { record: TerrainPatchBuildRecord; read(file: string): Uint8Array | undefined };
  /** Components that must be reused from `previous`. The build fails before producing anything if one cannot be. */
  preserve?: readonly string[];
};
export type TerrainPatchBuild = {
  record: TerrainPatchBuildRecord;
  files: Record<string, Uint8Array>;
  detail: TerrainDetailInstance[];
  stages: { executed: string[]; reused: string[] };
  /** Terrain height samples evaluated by this build; 0 when the height component was reused. */
  heightSamplesEvaluated: number;
};

const componentKey = (component: string, inputs: unknown) => sha256Bytes(canonicalJson({ semantics: COMPONENT_SEMANTICS, component, inputs }));
const detailJson = (patch: Vec2, instances: TerrainDetailInstance[]) => Buffer.from(`${canonicalJson({ schema: "terrain-detail-v1", patch, instances })}\n`);

/**
 * The component names of a recipe and the key each depends on. `height` (height.png, slope.png, mesh.glb) depends on
 * the height seed, noise, shaping and edit geometry; `exclusion` and `paint.<name>` only on their shapes; each
 * `detail.<layer>` on its own layer settings and seed group plus the height, exclusion and its paint layer; `detail`
 * assembles detail.json from the layers in recipe order.
 */
export function terrainPatchComponentKeys(recipeValue: unknown, patch: Vec2): Record<string, string> {
  const r = normalizeTerrainPatchRecipe(recipeValue), g = patchGrid(r, patch);
  const grid = { patch: g.patch, origin: r.origin, sampleSpacing: r.sampleSpacing, samples: r.samples };
  const keys: Record<string, string> = {};
  keys.height = componentKey("height", { grid, id: r.id, seed: r.seed, height: r.height, noise: r.noise, shaping: r.shaping,
    edits: r.edits.map(({ excludeDetail: _, ...edit }) => edit) });
  const exclusionInputs = { edits: r.edits.filter((e) => e.excludeDetail), exclusions: r.exclusions };
  keys.exclusion = componentKey("exclusion", { grid, ...exclusionInputs });
  for (const [name, shapes] of Object.entries(r.paint)) keys[`paint.${name}`] = componentKey("paint", { grid, name, shapes });
  for (const layer of r.detail) {
    const { seed: _, ...settings } = layer;
    keys[`detail.${layer.id}`] = componentKey("detail-layer", { grid, layer: settings, seed: terrainDetailSeed(r, layer), height: keys.height,
      ...exclusionInputs, paint: layer.paint === null ? null : r.paint[layer.paint] });
  }
  keys.detail = componentKey("detail", r.detail.map((l) => keys[`detail.${l.id}`]));
  return keys;
}

/**
 * Builds one patch's files component by component. With `previous`, a component whose key is unchanged and whose
 * recorded bytes still verify is reused rather than regenerated; everything else, and everything downstream of it,
 * executes. Outputs are byte-identical to a cold build of the same recipe. Nothing is written: the caller reconciles
 * the returned files.
 */
export async function buildTerrainPatchFiles(recipeValue: unknown, patch: Vec2, options: TerrainPatchBuildOptions = {}): Promise<TerrainPatchBuild> {
  const r = normalizeTerrainPatchRecipe(recipeValue), g = patchGrid(r, patch), keys = terrainPatchComponentKeys(r, patch);
  const preserve = new Set(options.preserve ?? []);
  for (const name of preserve) if (!Object.hasOwn(keys, name)) throw new Error(`cannot preserve unknown terrain component '${name}'`);
  const previous = options.previous, before = heightEvaluations;
  if (previous && previous.record.schema !== TERRAIN_PATCH_BUILD_SCHEMA) throw new Error(`previous terrain build record must use ${TERRAIN_PATCH_BUILD_SCHEMA}`);
  const verified = new Map<string, Uint8Array>();
  const readVerified = (file: string, sha256: string) => {
    const bytes = previous!.read(file);
    if (bytes === undefined || sha256Bytes(bytes) !== sha256) return undefined;
    verified.set(file, bytes);
    return bytes;
  };
  let previousDetail: TerrainDetailInstance[] | undefined | null = null;
  const previousLayer = (id: string, instancesSha256: string) => {
    if (previousDetail === null) {
      const assembly = previous!.record.components.detail?.files["detail.json"], bytes = assembly === undefined ? undefined : readVerified("detail.json", assembly);
      previousDetail = bytes === undefined ? undefined : (JSON.parse(Buffer.from(bytes).toString("utf8")) as { instances: TerrainDetailInstance[] }).instances;
    }
    const instances = previousDetail?.filter((d) => d.layer === id);
    return instances && sha256Bytes(canonicalJson(instances)) === instancesSha256 ? instances : undefined;
  };
  /** Why a component cannot be reused, or null when it can. */
  const reuseBlocker = (name: string): string | null => {
    const old = previous?.record.components[name];
    if (!old) return "no earlier build of it was given";
    if (old.key !== keys[name]) return "its inputs changed";
    for (const [file, sha256] of Object.entries(old.files)) if (!readVerified(file, sha256)) return `the earlier ${file} is missing or does not match its recorded hash`;
    if (name.startsWith("detail.") && (old.instances === undefined || !previousLayer(name.slice(7), old.instances))) return "the earlier detail.json does not hold its recorded instances";
    return null;
  };
  const reusable = (name: string) => {
    const blocker = previous ? reuseBlocker(name) : "no earlier build of it was given";
    if (blocker !== null && preserve.has(name)) throw new Error(`terrain component '${name}' cannot be preserved: ${blocker}`);
    return blocker === null;
  };
  // Decide every component before producing anything, so a refused preservation leaves no partial result.
  const reuse = new Map(Object.keys(keys).map((name) => [name, reusable(name)]));

  const files: Record<string, Uint8Array> = {}, components: Record<string, TerrainPatchComponentRecord> = {};
  const stages = { executed: [] as string[], reused: [] as string[] };
  const put = (name: string, out: Record<string, Uint8Array>, extra: Partial<TerrainPatchComponentRecord> = {}) => {
    Object.assign(files, out);
    components[name] = { key: keys[name]!, files: Object.fromEntries(Object.entries(out).map(([f, b]) => [f, sha256Bytes(b)])), ...extra };
    (reuse.get(name) ? stages.reused : stages.executed).push(name);
  };
  const kept = (name: string) => Object.fromEntries(Object.keys(previous!.record.components[name]!.files).map((f) => [f, verified.get(f)!]));

  let heights: Uint16Array;
  if (reuse.get("height")) {
    const out = kept("height");
    put("height", out);
    heights = decodeGrayPng(out["height.png"]!, g.width, g.depth, 16) as Uint16Array;
  } else {
    const h = heightComponent(r, g);
    heights = h.heights;
    put("height", { "height.png": encodeGrayPng(g.width, g.depth, h.heights), "slope.png": encodeGrayPng(g.width, g.depth, h.slope),
      "mesh.glb": await terrainPatchGlb({ ...g, recipe: r, ...h, exclusion: new Uint8Array(0), paint: {} }) });
  }
  put("exclusion", reuse.get("exclusion") ? kept("exclusion")
    : { "exclusion.png": encodeGrayPng(g.width, g.depth, maskComponent(r, g, (x, z) => exclusionWeight(r, x, z))) });
  for (const [name, shapes] of Object.entries(r.paint)) {
    put(`paint.${name}`, reuse.get(`paint.${name}`) ? kept(`paint.${name}`)
      : { [`paint-${name}.png`]: encodeGrayPng(g.width, g.depth, maskComponent(r, g, (x, z) => paintWeight(shapes, x, z))) });
  }
  const detail: TerrainDetailInstance[] = [];
  for (const layer of r.detail) {
    const name = `detail.${layer.id}`;
    const instances = reuse.get(name) ? previousLayer(layer.id, previous!.record.components[name]!.instances!)! : scatterLayer(r, g, heights, layer);
    detail.push(...instances);
    if (detail.length > MAX_INSTANCES) throw new Error(`terrain patch detail exceeds ${MAX_INSTANCES} instances`);
    put(name, {}, { instances: sha256Bytes(canonicalJson(instances)) });
  }
  put("detail", reuse.get("detail") ? kept("detail") : { "detail.json": detailJson(g.patch, detail) });
  return { record: { schema: TERRAIN_PATCH_BUILD_SCHEMA, patch: g.patch, components }, files, detail, stages, heightSamplesEvaluated: heightEvaluations - before };
}

/** Decodes the exact grayscale PNG layout `encodeGrayPng` writes; anything else fails closed. */
export function decodeGrayPng(bytes: Uint8Array, width: number, height: number, bitDepth: 8 | 16): Uint8Array | Uint16Array {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), idat: Buffer[] = [];
  if (!b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error("not a PNG");
  let at = 8, header: Buffer | undefined;
  while (at < b.length) {
    const length = b.readUInt32BE(at), type = b.toString("latin1", at + 4, at + 8), data = b.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") header = data; else if (type === "IDAT") idat.push(data); else if (type !== "IEND") throw new Error(`unexpected PNG chunk ${type}`);
    at += length + 12;
  }
  if (!header || header.readUInt32BE(0) !== width || header.readUInt32BE(4) !== height || header[8] !== bitDepth || header[9] !== 0 || header[12] !== 0) {
    throw new Error(`expected a ${width}×${height} ${bitDepth}-bit grayscale PNG`);
  }
  const raw = inflateSync(Buffer.concat(idat)), size = bitDepth / 8, stride = width * size + 1;
  if (raw.length !== stride * height) throw new Error("PNG image data has the wrong length");
  const out = bitDepth === 16 ? new Uint16Array(width * height) : new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    if (raw[y * stride] !== 0) throw new Error("PNG rows must be unfiltered");
    for (let x = 0; x < width; x += 1) out[y * width + x] = size === 2 ? raw.readUInt16BE(y * stride + 1 + x * 2) : raw[y * stride + 1 + x]!;
  }
  return out;
}
