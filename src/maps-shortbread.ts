import { FileSource, PMTiles, TileType, tileIdToZxy } from "pmtiles";
import { VectorTile, classifyRings } from "@mapbox/vector-tile";
import Pbf from "pbf";
import { sha256Bytes } from "./hash.js";

export const MAPS_SHORTBREAD_LAYERS = ["land", "water_polygons", "water_lines", "streets", "buildings", "boundaries"];
export type MapsArchiveCandidate = {
  version: 1; sourceId: string; dataRevision: string; format: "mvt";
  schema: { id: "shortbread"; version: "1.0"; sourceLayers: string[] };
  projection: "web-mercator"; scheme: "xyz"; bounds: number[]; minZoom: number; maxZoom: number; tileSize: 512;
  attribution: string; license: string; provenance: string; observation: { snapshot: string };
  archiveRef: { format: "pmtiles"; version: 3; path: string; sha256: string; bytes: number; mvtExtent: 4096 };
};

export function validateMapsArchiveCandidate(value: unknown): MapsArchiveCandidate {
  if (!value || typeof value !== "object") { throw new Error("candidate must be an object"); }
  const v = value as MapsArchiveCandidate;
  if (v.version !== 1 || typeof v.sourceId !== "string" || !/^[a-z0-9-]+$/.test(v.sourceId) || v.format !== "mvt" || v.projection !== "web-mercator" || v.scheme !== "xyz" || v.tileSize !== 512) { throw new Error("unsupported Maps format/CRS/identity"); }
  if (v.schema?.id !== "shortbread" || v.schema.version !== "1.0" || !Array.isArray(v.schema.sourceLayers) || v.schema.sourceLayers.length === 0 || new Set(v.schema.sourceLayers).size !== v.schema.sourceLayers.length || v.schema.sourceLayers.some(l => !MAPS_SHORTBREAD_LAYERS.includes(l))) { throw new Error("unsupported Maps Shortbread schema"); }
  if (!Array.isArray(v.bounds) || v.bounds.length !== 4 || !v.bounds.every(Number.isFinite) || v.bounds[0]! < -180 || v.bounds[2]! > 180 || v.bounds[1]! < -85 || v.bounds[3]! > 85 || v.bounds[0]! >= v.bounds[2]! || v.bounds[1]! >= v.bounds[3]! || !Number.isInteger(v.minZoom) || !Number.isInteger(v.maxZoom) || v.minZoom < 0 || v.maxZoom > 14 || v.minZoom > v.maxZoom) { throw new Error("invalid bounded coverage"); }
  for (const field of [v.attribution, v.license, v.provenance, v.observation?.snapshot]) {
    if (typeof field !== "string" || !field.trim()) { throw new Error("attribution, license, provenance and snapshot are required"); }
  }
  const a = v.archiveRef;
  if (!a || a.format !== "pmtiles" || a.version !== 3 || !/^[0-9a-f]{64}$/.test(a.sha256) || v.dataRevision !== `sha256:${a.sha256}` || !Number.isSafeInteger(a.bytes) || a.bytes <= 0 || a.mvtExtent !== 4096 || typeof a.path !== "string" || !/^[a-z0-9-]+\.pmtiles$/.test(a.path)) { throw new Error("invalid archive reference or revision collision"); }
  return v;
}

/** Checks every addressed tile using upstream readers; does not encode archives or own Maps rendering. */
export async function verifyMapsArchive(bytes: Uint8Array, value: unknown) {
  const manifest = validateMapsArchiveCandidate(value);
  if (sha256Bytes(bytes) !== manifest.archiveRef.sha256 || bytes.byteLength !== manifest.archiveRef.bytes) { throw new Error("archive hash/size mismatch"); }
  const archive = new PMTiles(new FileSource(new File([Uint8Array.from(bytes)], "candidate.pmtiles")));
  const h = await archive.getHeader();
  if (h.specVersion !== 3 || h.tileType !== TileType.Mvt || h.minZoom !== manifest.minZoom || h.maxZoom !== manifest.maxZoom || h.centerZoom < h.minZoom || h.centerZoom > h.maxZoom) { throw new Error("invalid archive format/zoom"); }
  if ([h.minLon,h.minLat,h.maxLon,h.maxLat].some((v,i) => Math.abs(v-manifest.bounds[i]!) > 1e-6)) { throw new Error("archive bounds mismatch"); }
  const metadata: unknown = await archive.getMetadata();
  if (!metadata || typeof metadata !== "object" || !("attribution" in metadata) || metadata.attribution !== manifest.attribution) { throw new Error("archive attribution mismatch"); }
  const counts: Record<string, number> = {};
  const representatives: Record<string, { z: number; x: number; y: number; feature: number }> = {};
  let tiles = 0, holes = 0;
  const visited = new Set<number>();
  async function inspectDirectory(offset: number, length: number, depth: number) {
    if (depth > 3) { throw new Error("archive directory depth exceeded"); }
    const entries = await archive.cache.getDirectory(archive.source, offset, length, h);
    let previousEnd = -1;
    for (const entry of entries) {
      if (entry.tileId <= previousEnd) { throw new Error("duplicate or unordered tiles"); }
      previousEnd = entry.tileId + Math.max(1, entry.runLength) - 1;
      if (entry.runLength === 0) { await inspectDirectory(h.leafDirectoryOffset + entry.offset, entry.length, depth + 1); continue; }
      for (let id = entry.tileId; id < entry.tileId + entry.runLength; id++) {
        if (visited.has(id) || visited.size >= 4096) { throw new Error("duplicate tiles or bounded tile budget exceeded"); }
        visited.add(id);
        const [z,x,y] = tileIdToZxy(id);
        if (z < manifest.minZoom || z > manifest.maxZoom) { throw new Error("tile outside declared zooms"); }
        const tileWest = x / 2 ** z * 360 - 180, tileEast = (x + 1) / 2 ** z * 360 - 180;
        const latitude = (row: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * row / 2 ** z))) * 180 / Math.PI;
        if (tileEast <= manifest.bounds[0]! || tileWest >= manifest.bounds[2]! || latitude(y) <= manifest.bounds[1]! || latitude(y+1) >= manifest.bounds[3]!) { throw new Error("addressed tile outside declared bounds"); }
        const raw = await archive.getZxy(z,x,y);
        if (!raw || raw.data.byteLength === 0) { throw new Error("missing addressed tile"); }
        const tile = new VectorTile(new Pbf(new Uint8Array(raw.data)));
        if (Object.keys(tile.layers).length === 0) { throw new Error("empty addressed tile"); }
        for (const [name, layer] of Object.entries(tile.layers)) {
          if (!manifest.schema.sourceLayers.includes(name) || layer.extent !== 4096 || layer.version !== 2) { throw new Error("unsupported layer/extent/version"); }
          counts[name] = (counts[name] ?? 0) + layer.length;
          for (let i=0;i<layer.length;i++) {
            const f = layer.feature(i);
            const polygon = ["land","water_polygons","buildings"].includes(name);
            if (f.type !== (polygon ? 3 : 2) || f.loadGeometry().length === 0 || (name !== "boundaries" && typeof f.properties.kind !== "string") || (name === "boundaries" && typeof f.properties.admin_level !== "number")) { throw new Error("invalid Shortbread geometry/properties"); }
            representatives[name] ??= {z,x,y,feature:i};
            if (name === "water_polygons" && classifyRings(f.loadGeometry()).some(p=>p.length>1)) { holes++; representatives.waterHole ??= {z,x,y,feature:i}; }
          }
        }
        tiles++;
      }
    }
  }
  await inspectDirectory(h.rootDirectoryOffset,h.rootDirectoryLength,0);
  if (tiles !== h.numAddressedTiles || tiles === 0) { throw new Error("missing tiles/header count mismatch"); }
  for (const layer of manifest.schema.sourceLayers) { if (!counts[layer]) { throw new Error(`missing layer ${layer}`); } }
  if (!holes) { throw new Error("representative water hole missing"); }
  return { tiles, counts, waterHoleFeatures: holes, representatives, archiveSha256: manifest.archiveRef.sha256 };
}
