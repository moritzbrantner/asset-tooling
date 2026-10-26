import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

// Consumer-specific glue: every geometry result comes from Maps' public Rust/WASM API.
const [mapsRoot, handoffPath, outputPath] = process.argv.slice(2);
if (!mapsRoot || !handoffPath || !outputPath) {
  throw new Error("Usage: bun examples/maps-shortbread/verify-maps-decoder.ts maps-root handoff.json output.json");
}
const git = (...args: string[]) => execFileSync("git", args, { cwd: mapsRoot, encoding: "utf8", timeout: 10000 }).trim();
if (git("status", "--porcelain=v1", "--untracked-files=all")) { throw new Error("Maps compatibility requires a clean source checkout"); }
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Sample = { path: string; sha256: string; bytes: number; z: number; x: number; y: number; candidate: string; purpose: string; waterHoles: number; counts: Record<string, number> };
type Point = [number, number];
type GeographicTile = { lines: { kind: string; coordinates: Point[] }[]; polygons: { kind: string; sourceKind: string | null; rings: Point[][] }[] };
type PixelTile = { lines: unknown[]; polygons: { kind: string; rings: unknown[][] }[] };
const handoffBytes = await readFile(handoffPath);
// Every sample identity is checked below before file access; malformed structures fail closed.
const handoff = JSON.parse(handoffBytes.toString()) as { samples: Sample[] };
if (!Array.isArray(handoff.samples) || handoff.samples.length < 1 || handoff.samples.length > 16) { throw new Error("Expected 1..16 decoder samples"); }
const wasmBytes = await readFile(resolve(mapsRoot, "public/wasm/maps_wasm_bg.wasm"));
const wasm: {
  initSync: (value: { module: Uint8Array }) => void;
  decodeShortbreadBasemap: (bytes: Uint8Array, z: number, x: number, y: number) => GeographicTile;
  decodeShortbreadTilePixels: (bytes: Uint8Array, size: number) => PixelTile;
} = await import(pathToFileURL(resolve(mapsRoot, "public/wasm/maps_wasm.js")).href);
wasm.initSync({ module: wasmBytes });
function summarize(tile: GeographicTile) {
  const lines: Record<string, number> = {}, polygons: Record<string, number> = {}, holes: Record<string, number> = {};
  const sourceKinds = new Set<string>();
  for (const line of tile.lines) {
    lines[line.kind] = (lines[line.kind] ?? 0) + 1;
    for (const p of line.coordinates) { if (!p.every(Number.isFinite)) { throw new Error("Non-finite geographic line"); } }
  }
  for (const polygon of tile.polygons) {
    polygons[polygon.kind] = (polygons[polygon.kind] ?? 0) + 1;
    holes[polygon.kind] = (holes[polygon.kind] ?? 0) + Math.max(0, polygon.rings.length - 1);
    if (polygon.sourceKind) { sourceKinds.add(polygon.sourceKind); }
    for (const ring of polygon.rings) {
      for (const p of ring) { if (!p.every(Number.isFinite)) { throw new Error("Non-finite geographic polygon"); } }
    }
  }
  return { lines, polygons, holes, sourceKinds: [...sourceKinds].sort() };
}
const results = [];
for (const sample of handoff.samples) {
  if (!/^[a-zA-Z0-9_-]+\.mvt$/.test(sample.path) || !/^[0-9a-f]{64}$/.test(sample.sha256) || !Number.isSafeInteger(sample.bytes) || sample.bytes <= 0 ||
      !Number.isInteger(sample.z) || sample.z < 0 || sample.z > 14 || !Number.isInteger(sample.x) || !Number.isInteger(sample.y) ||
      sample.x < 0 || sample.y < 0 || sample.x >= 2 ** sample.z || sample.y >= 2 ** sample.z || !Number.isInteger(sample.waterHoles) || sample.waterHoles < 0) {
    throw new Error("Invalid sample identity/coordinates");
  }
  const bytes = await readFile(resolve(dirname(handoffPath), sample.path));
  if (bytes.length !== sample.bytes || digest(bytes) !== sample.sha256) { throw new Error(`Input mismatch: ${sample.path}`); }
  const normalized = summarize(wasm.decodeShortbreadBasemap(bytes, sample.z, sample.x, sample.y));
  const pixels = wasm.decodeShortbreadTilePixels(bytes, 512);
  const pixelCounts = { lines: pixels.lines.length, polygons: pixels.polygons.length,
    waterHoles: pixels.polygons.filter(p => p.kind === "water").reduce((n, p) => n + Math.max(0, p.rings.length - 1), 0) };
  if (pixelCounts.lines !== Object.values(normalized.lines).reduce((n, v) => n + v, 0) || pixelCounts.polygons !== Object.values(normalized.polygons).reduce((n, v) => n + v, 0)) { throw new Error("Geographic/pixel primitive counts differ"); }
  if ((normalized.holes.water ?? 0) !== sample.waterHoles || pixelCounts.waterHoles !== sample.waterHoles) { throw new Error(`Water-hole mismatch: ${sample.path}`); }
  if (sample.counts.buildings && !normalized.polygons.building) { throw new Error(`Missing buildings: ${sample.path}`); }
  if (sample.counts.water_lines && !normalized.lines.water) { throw new Error(`Missing water lines: ${sample.path}`); }
  results.push({ path: sample.path, candidate: sample.candidate, purpose: sample.purpose, tile: [sample.z, sample.x, sample.y], bytes: bytes.length, sha256: digest(bytes), normalized, pixelCounts });
}
const result = { mapsRevision: git("rev-parse", "HEAD"), mapsDirty: false, wasmSha256: digest(wasmBytes), wasmBytes: wasmBytes.length,
  handoffSha256: digest(handoffBytes), decoder: "actual Maps Rust/WASM decodeShortbreadBasemap + decodeShortbreadTilePixels", status: "passed", results };
await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
