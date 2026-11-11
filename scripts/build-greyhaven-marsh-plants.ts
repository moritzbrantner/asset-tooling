// Build the Greyhaven marsh plants kit for mmorpg (docs/greyhaven-marsh-plants.md, #571):
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-marsh-plants.ts [--textures full|half] --out <directory>
// Each piece and level is one external.blender.script@1 run of adapters/blender/greyhaven_marsh.py (which reuses the
// meadow recipe's helpers, a declared input), imported through scene.import.gltf@2, all on one cut-out atlas. Every
// level is built in the same frame from the same seeded layout. The atlas ships as KTX2. <directory> becomes the
// object-store root; the bundle is exported to <directory>/bundle and packed to <directory>/greyhaven-marsh-plants.kit.tar.
// No game places the kit yet.
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
import { buildKitPart, documentBounds, exportKitBundle, ktx2Assets, round, runKitCli, SCATTER_LOD_SELECTION, scatterLods, triangles, type KitPart } from "../src/kit-bundle.js";
import type { AssetRef } from "../src/operations.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const MARSH_PIECES = ["reeds-stand", "reeds-edge", "cattails", "sedge-tussock", "rushes", "water-lilies", "marsh-marigold"] as const;
export type MarshPiece = (typeof MARSH_PIECES)[number];
/** Full detail and the reduced level: scatter is not drawn beyond 60 m, so it needs no far card (#586). */
export const MARSH_VARIANTS = ["default", "lod1"] as const;
export const MARSH_KEY_PREFIX = "greyhaven-marsh-plants.kit";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const MARSH_RELEASE = "greyhaven-marsh-plants";
export const MARSH_TAR_NAME = "greyhaven-marsh-plants.kit.tar";
export const MARSH_MATERIAL = "Greyhaven_Marsh";
export const MARSH_DESCRIPTOR_SCHEMA = "greyhaven-marsh-plants-descriptor-v1";
export const MARSH_DESCRIPTOR_ATTACHMENT = "greyhaven-marsh-plants-descriptor";
/** The catalogued CC0 Quaternius Stylized Nature MegaKit textures: the leaf shading strip and the two flowers. */
export const MARSH_SOURCES = {
  grass: "quaternius.stylized-nature-megakit-standard.grass-png",
  flowers: "quaternius.stylized-nature-megakit-standard.flowers-png",
} as const;
/** Scatter: reeds are tall, but no piece may exceed a few hundred triangles at full detail. */
export const MARSH_TRIANGLES = 320;

export const marshKey = (piece: MarshPiece) => `${MARSH_KEY_PREFIX}.${piece}`;

export function createMarshSpec({ piece, level, hashes, blenderVersion }: {
  piece: MarshPiece; level: number; blenderVersion: string; hashes: { script: string; meadow: string; grass: string; flowers: string };
}) {
  return blenderScriptSpec({
    assetId: marshKey(piece),
    inputs: {
      script: { path: "greyhaven_marsh.py", sha256: hashes.script },
      meadow: { path: "greyhaven_meadow.py", sha256: hashes.meadow },
      grass: { path: "grass.png", sha256: hashes.grass },
      flowers: { path: "flowers.png", sha256: hashes.flowers },
    },
    blenderVersion, arguments: { schemaVersion: 1, piece, level }, output: `${MARSH_VARIANTS[level]}.glb`,
  });
}

type Built = KitPart & { piece: MarshPiece; variant: (typeof MARSH_VARIANTS)[number] };

export async function buildGreyhavenMarshPlants({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("greyhaven_marsh.py");
  const meadow = await readBlenderRecipeSource("greyhaven_meadow.py");
  const sources = JSON.parse(await readFile(path.join(ROOT, "catalog/sources.json"), "utf8"));
  const providers = JSON.parse(await readFile(path.join(ROOT, "catalog/providers.json"), "utf8"));
  const storage = JSON.parse(await readFile(path.join(ROOT, "catalog/storage.json"), "utf8"));
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const imported = {} as Record<keyof typeof MARSH_SOURCES, { asset: AssetRef; bytes: Uint8Array }>;
  for (const [name, sourceId] of Object.entries(MARSH_SOURCES) as [keyof typeof MARSH_SOURCES, string][]) {
    const asset = (await importAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
    imported[name] = { asset, bytes: new Uint8Array(await resolveAssetObject(root, asset)) };
  }
  const files = {
    "greyhaven_marsh.py": source.bytes, "greyhaven_meadow.py": meadow.bytes,
    "grass.png": imported.grass.bytes, "flowers.png": imported.flowers.bytes,
  };
  const hashes = { script: source.sha256, meadow: meadow.sha256, grass: sha256Bytes(imported.grass.bytes), flowers: sha256Bytes(imported.flowers.bytes) };

  const built: Built[] = [];
  for (const piece of MARSH_PIECES) {
    for (const [level, variant] of MARSH_VARIANTS.entries()) {
      log(`generate ${piece} ${variant}`);
      const part = await buildKitPart(root, {
        workspace: path.join(root, "pieces", `${piece}.${variant}`), files,
        spec: createMarshSpec({ piece, level, hashes, blenderVersion: source.blenderVersion }),
      });
      built.push({ piece, variant, ...part });
    }
  }

  log("measure the descriptor");
  const assets = MARSH_PIECES.map((piece) => {
    const levels = built.filter((part) => part.piece === piece);
    const { document, observations } = levels[0]!;
    const bounds = documentBounds(document);
    const count = triangles(document);
    return {
      key: marshKey(piece), kind: piece, triangles: count, bounds, collision: "none",
      origin: piece === "water-lilies" ? "water-line" : "patch-centre-on-ground",
      footprint: { width: round(bounds.max[0] - bounds.min[0]), depth: round(bounds.max[2] - bounds.min[2]), height: round(bounds.max[1]) },
      coverM2: observations.coverM2, trianglesPerCoveredM2: Math.round(count / Number(observations.coverM2)),
      flowers: observations.flowers, plumeCards: observations.plumeCards, pads: observations.pads,
      ...scatterLods(bounds, levels.map((level) => ({ variant: level.variant, triangles: triangles(level.document) }))),
    };
  });
  const descriptor = {
    schema: MARSH_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", handedness: "right", origin: "patch-centre-on-ground",
    placement: "The origin is the patch's centre on the ground; card feet run 3 cm below it, so a patch stays rooted on uneven ground or a shallow bed. "
      + "water-lilies is the exception: its origin is the water line, and its pads and flowers float 1 to 6 cm above it, so place it at the water surface's height and the pads don't z-fight the water plane. "
      + "Each patch wanders along X with a ragged outline. reeds-edge thins towards +Z: turn it so +Z faces open water and run it along the shoreline in front of reeds-stand. "
      + "Turn the others to any angle about +Y, scale them about 0.85 to 1.2 and tint each placement; overlap reed stands into beds and leave gaps elsewhere. "
      + "The game owns where and how densely they stand. coverM2 is the ground a patch covers; trianglesPerCoveredM2 its full-detail triangles over that.",
    collision: "Walk-through marsh plants: every piece declares `collision: \"none\"`.",
    tint: "Leaves, stems, pads and the marigold leaves are greyscale in the atlas and take their colour from COLOR_0, so a material colour multiplies over them; "
      + "the reed plumes, cattail and rush heads and the marigold and water-lily flowers carry their own colour, also times COLOR_0.",
    lodSelection: SCATTER_LOD_SELECTION,
    assets,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: MARSH_DESCRIPTOR_ATTACHMENT, mediaType: "application/json" })).asset;

  log("encode the atlas as KTX2 (ktx create)");
  const delivered = await ktx2Assets(root, MARSH_RELEASE, built.map((part) => part.asset));
  const selections = built.map((part, index) => ({
    key: marshKey(part.piece), variant: part.variant, ...(index === 0 ? { attachments: [{ name: MARSH_DESCRIPTOR_ATTACHMENT }] } : {}),
  }));
  const packed = await exportKitBundle(root, {
    tarName: MARSH_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(built.map((part) => [`${part.piece}.${part.variant}`, part.document])),
    lineage: {
      recipe: {
        script: "adapters/blender/greyhaven_marsh.py", sha256: source.sha256, blenderVersion: source.blenderVersion,
        meadow: { script: "adapters/blender/greyhaven_meadow.py", sha256: meadow.sha256 },
      },
      sources: Object.fromEntries(Object.entries(MARSH_SOURCES).map(([name, id]) => [name, { id, license: "CC0-1.0", asset: imported[name as keyof typeof MARSH_SOURCES].asset }])),
      release: MARSH_RELEASE, descriptor: descriptorAsset,
      observations: Object.fromEntries(built.map((part) => [`${marshKey(part.piece)}#${part.variant}`, part.observations])),
    },
  };
}

if (import.meta.main) {
  await runKitCli("scripts/build-greyhaven-marsh-plants.ts", MARSH_RELEASE, buildGreyhavenMarshPlants, { descriptorFile: true });
}
