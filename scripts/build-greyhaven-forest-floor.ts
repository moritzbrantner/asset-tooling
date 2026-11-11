// Build the Greyhaven forest floor kit for mmorpg (docs/greyhaven-forest-floor.md, #572):
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-forest-floor.ts [--textures full|half] --out <directory>
// Each piece and level is one external.blender.script@1 run of adapters/blender/greyhaven_forest_floor.py (which reuses
// the meadow and marsh recipes' helpers, declared inputs), imported through scene.import.gltf@2, all on one cut-out
// atlas. Every level is built in the same frame from the same seeded layout. The atlas ships as KTX2. <directory>
// becomes the object-store root; the bundle is exported to <directory>/bundle and packed to
// <directory>/greyhaven-forest-floor.kit.tar. No game places the kit yet.
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec } from "../src/blender-script-spec.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { sha256Bytes } from "../src/hash.js";
import { buildKitPart, documentBounds, exportKitBundle, ktx2Assets, round, runKitCli, scaledLodDistances, triangles, type KitPart } from "../src/kit-bundle.js";
import type { AssetRef } from "../src/operations.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const FLOOR_PIECES = ["fern", "fern-large", "bracken", "bluebells", "wood-anemone", "mushrooms", "leaf-litter"] as const;
export type FloorPiece = (typeof FLOOR_PIECES)[number];
export const FLOOR_VARIANTS = ["default", "lod1", "lod2"] as const;
export const FLOOR_KEY_PREFIX = "greyhaven-forest-floor.kit";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const FLOOR_RELEASE = "greyhaven-forest-floor";
export const FLOOR_TAR_NAME = "greyhaven-forest-floor.kit.tar";
export const FLOOR_MATERIAL = "Greyhaven_Forest_Floor";
export const FLOOR_DESCRIPTOR_SCHEMA = "greyhaven-forest-floor-descriptor-v1";
export const FLOOR_DESCRIPTOR_ATTACHMENT = "greyhaven-forest-floor-descriptor";
/** The catalogued CC0 Quaternius Stylized Nature MegaKit textures: the shading strip, the flowers and the broadleaf leaves. */
export const FLOOR_SOURCES = {
  grass: "quaternius.stylized-nature-megakit-standard.grass-png",
  flowers: "quaternius.stylized-nature-megakit-standard.flowers-png",
  leaves: "quaternius.stylized-nature-megakit-standard.leaves-normaltree-c-png",
} as const;
/** Scatter: no piece may exceed a few hundred triangles at full detail. */
export const FLOOR_TRIANGLES = 320;
/** Where LOD0 and lod1 end for a piece up to 1 m across, in metres at the reference FOV; scaledLodDistances grows them for larger pieces. */
export const FLOOR_LOD_DISTANCES = [60, 180] as const;
/** The leaf litter lies flat this far above its origin, so it doesn't z-fight the terrain. */
export const FLOOR_LITTER_FLOAT = 0.01;
const LOD_REFERENCE_FOV_Y = 60;

export const floorKey = (piece: FloorPiece) => `${FLOOR_KEY_PREFIX}.${piece}`;

export function createFloorSpec({ piece, level, hashes, blenderVersion }: {
  piece: FloorPiece; level: number; blenderVersion: string;
  hashes: { script: string; meadow: string; marsh: string; grass: string; flowers: string; leaves: string };
}) {
  return blenderScriptSpec({
    assetId: floorKey(piece),
    inputs: {
      script: { path: "greyhaven_forest_floor.py", sha256: hashes.script },
      meadow: { path: "greyhaven_meadow.py", sha256: hashes.meadow },
      marsh: { path: "greyhaven_marsh.py", sha256: hashes.marsh },
      grass: { path: "grass.png", sha256: hashes.grass },
      flowers: { path: "flowers.png", sha256: hashes.flowers },
      leaves: { path: "leaves.png", sha256: hashes.leaves },
    },
    blenderVersion, arguments: { schemaVersion: 1, piece, level }, output: `${FLOOR_VARIANTS[level]}.glb`,
  });
}

type Built = KitPart & { piece: FloorPiece; variant: (typeof FLOOR_VARIANTS)[number] };

export async function buildGreyhavenForestFloor({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("greyhaven_forest_floor.py");
  const meadow = await readBlenderRecipeSource("greyhaven_meadow.py");
  const marsh = await readBlenderRecipeSource("greyhaven_marsh.py");
  const sources = JSON.parse(await readFile(path.join(ROOT, "catalog/sources.json"), "utf8"));
  const providers = JSON.parse(await readFile(path.join(ROOT, "catalog/providers.json"), "utf8"));
  const storage = JSON.parse(await readFile(path.join(ROOT, "catalog/storage.json"), "utf8"));
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const imported = {} as Record<keyof typeof FLOOR_SOURCES, { asset: AssetRef; bytes: Uint8Array }>;
  for (const [name, sourceId] of Object.entries(FLOOR_SOURCES) as [keyof typeof FLOOR_SOURCES, string][]) {
    const asset = (await importAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
    imported[name] = { asset, bytes: new Uint8Array(await resolveAssetObject(root, asset)) };
  }
  const files = {
    "greyhaven_forest_floor.py": source.bytes, "greyhaven_meadow.py": meadow.bytes, "greyhaven_marsh.py": marsh.bytes,
    "grass.png": imported.grass.bytes, "flowers.png": imported.flowers.bytes, "leaves.png": imported.leaves.bytes,
  };
  const hashes = {
    script: source.sha256, meadow: meadow.sha256, marsh: marsh.sha256,
    grass: sha256Bytes(imported.grass.bytes), flowers: sha256Bytes(imported.flowers.bytes), leaves: sha256Bytes(imported.leaves.bytes),
  };

  const built: Built[] = [];
  for (const piece of FLOOR_PIECES) {
    for (const [level, variant] of FLOOR_VARIANTS.entries()) {
      log(`generate ${piece} ${variant}`);
      const part = await buildKitPart(root, {
        workspace: path.join(root, "pieces", `${piece}.${variant}`), files,
        spec: createFloorSpec({ piece, level, hashes, blenderVersion: source.blenderVersion }),
      });
      built.push({ piece, variant, ...part });
    }
  }

  log("measure the descriptor");
  const tan = Math.tan((LOD_REFERENCE_FOV_Y / 2) * Math.PI / 180);
  const assets = FLOOR_PIECES.map((piece) => {
    const levels = built.filter((part) => part.piece === piece);
    const { document, observations } = levels[0]!;
    const bounds = documentBounds(document);
    const radius = round(Math.hypot(...[0, 1, 2].map((k) => bounds.max[k]! - bounds.min[k]!)) / 2);
    const distances = scaledLodDistances(FLOOR_LOD_DISTANCES, bounds);
    const count = triangles(document);
    return {
      key: floorKey(piece), kind: piece, triangles: count, bounds, collision: "none", origin: "patch-centre-on-ground",
      footprint: { width: round(bounds.max[0] - bounds.min[0]), depth: round(bounds.max[2] - bounds.min[2]), height: round(bounds.max[1]) },
      coverM2: observations.coverM2, trianglesPerCoveredM2: Math.round(count / Number(observations.coverM2)),
      fronds: observations.fronds, flowers: observations.flowers, caps: observations.caps, litterQuads: observations.litterQuads,
      lods: {
        boundingSphere: { center: [0, 1, 2].map((k) => round((bounds.min[k]! + bounds.max[k]!) / 2)), radius },
        levels: levels.map((level, index) => {
          const distance = distances[index];
          return { variant: level.variant, triangles: triangles(level.document), minScreenSize: distance ? Number((radius / (distance * tan)).toFixed(4)) : 0, referenceMaxDistance: distance ?? null };
        }),
      },
    };
  });
  const descriptor = {
    schema: FLOOR_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", handedness: "right", origin: "patch-centre-on-ground",
    placement: "The origin is the patch's centre on the ground; card feet and mushroom stems run 3 cm below it, so a patch stays rooted on uneven ground. "
      + `leaf-litter lies flat ${FLOOR_LITTER_FLOAT * 100} cm above its origin (overlapping quads a millimetre apart), so it doesn't z-fight the terrain; on a slope, tilt it with the ground or sink the origin a few centimetres. `
      + "Each patch wanders along X with a ragged outline. Turn them to any angle about +Y, scale them about 0.85 to 1.2 and tint each placement; "
      + "overlap bracken into stands at clearings and woodland edges, ferns round trunks and in damp hollows, bluebell and wood-anemone drifts under broadleaf canopy, "
      + "mushrooms at trunk feet and on rotting wood, and leaf litter anywhere under broadleaves. The game owns where and how densely they stand. "
      + "coverM2 is the ground a patch covers; trianglesPerCoveredM2 its full-detail triangles over that.",
    collision: "Walk-through forest-floor plants: every piece declares `collision: \"none\"`.",
    tint: "Fronds, stalks, strap leaves, anemone leaves and mushroom caps and stems are greyscale in the atlas and take their colour from COLOR_0, so a material colour multiplies over them; "
      + "the bluebells, the anemone flowers, the leaf litter and the far mushroom card carry their own colour, also times COLOR_0.",
    lodSelection: {
      metric: "projected-bounding-sphere-height-fraction", referenceFovYDegrees: LOD_REFERENCE_FOV_Y,
      rule: "Use the first level whose minScreenSize is at most the asset's projected bounding-sphere diameter divided by the viewport height "
        + "(radius / (distance * tan(fovY / 2)), scaled by the instance scale). referenceMaxDistance is the distance in metres at which that "
        + "level ends for an unscaled instance at referenceFovYDegrees.",
    },
    assets,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: FLOOR_DESCRIPTOR_ATTACHMENT, mediaType: "application/json" })).asset;

  log("encode the atlas as KTX2 (ktx create)");
  const delivered = await ktx2Assets(root, FLOOR_RELEASE, built.map((part) => part.asset));
  const selections = built.map((part, index) => ({
    key: floorKey(part.piece), variant: part.variant, ...(index === 0 ? { attachments: [{ name: FLOOR_DESCRIPTOR_ATTACHMENT }] } : {}),
  }));
  const packed = await exportKitBundle(root, {
    tarName: FLOOR_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(built.map((part) => [`${part.piece}.${part.variant}`, part.document])),
    lineage: {
      recipe: {
        script: "adapters/blender/greyhaven_forest_floor.py", sha256: source.sha256, blenderVersion: source.blenderVersion,
        meadow: { script: "adapters/blender/greyhaven_meadow.py", sha256: meadow.sha256 },
        marsh: { script: "adapters/blender/greyhaven_marsh.py", sha256: marsh.sha256 },
      },
      sources: Object.fromEntries(Object.entries(FLOOR_SOURCES).map(([name, id]) => [name, { id, license: "CC0-1.0", asset: imported[name as keyof typeof FLOOR_SOURCES].asset }])),
      release: FLOOR_RELEASE, descriptor: descriptorAsset,
      observations: Object.fromEntries(built.map((part) => [`${floorKey(part.piece)}#${part.variant}`, part.observations])),
    },
  };
}

if (import.meta.main) {
  await runKitCli("scripts/build-greyhaven-forest-floor.ts", FLOOR_RELEASE, buildGreyhavenForestFloor, { descriptorFile: true });
}
