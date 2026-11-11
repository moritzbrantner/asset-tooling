// Build the Greyhaven meadow kit for mmorpg (docs/greyhaven-meadow.md, #570):
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-meadow.ts [--textures full|half] --out <directory>
// Each piece and level is one external.blender.script@1 run of adapters/blender/greyhaven_meadow.py, imported through
// scene.import.gltf@2, all on one cut-out atlas. Every level is built in the same frame from the same seeded layout.
// The atlas ships as KTX2. <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and
// packed to <directory>/greyhaven-meadow.kit.tar. No game places the kit yet.
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
export const MEADOW_PIECES = ["grass-short", "grass-tall", "grass-clump", "grass-dry", "flowers-yellow", "flowers-white", "flowers-red", "flowers-mixed"] as const;
export type MeadowPiece = (typeof MEADOW_PIECES)[number];
/** Full detail and the reduced level: scatter is not drawn beyond 60 m, so it needs no far card (#586). */
export const MEADOW_VARIANTS = ["default", "lod1"] as const;
export const MEADOW_KEY_PREFIX = "greyhaven-meadow.kit";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const MEADOW_RELEASE = "greyhaven-meadow";
export const MEADOW_TAR_NAME = "greyhaven-meadow.kit.tar";
export const MEADOW_MATERIAL = "Greyhaven_Meadow";
export const MEADOW_DESCRIPTOR_SCHEMA = "greyhaven-meadow-descriptor-v1";
export const MEADOW_DESCRIPTOR_ATTACHMENT = "greyhaven-meadow-descriptor";
/** The catalogued CC0 Quaternius Stylized Nature MegaKit textures: the blade shading strip and the flower heads. */
export const MEADOW_SOURCES = {
  grass: "quaternius.stylized-nature-megakit-standard.grass-png",
  flowers: "quaternius.stylized-nature-megakit-standard.flowers-png",
} as const;
/** Dense scatter: no piece may exceed a few hundred triangles at full detail. */
export const MEADOW_TRIANGLES = 300;

export const meadowKey = (piece: MeadowPiece) => `${MEADOW_KEY_PREFIX}.${piece}`;

export function createMeadowSpec({ piece, level, hashes, blenderVersion }: {
  piece: MeadowPiece; level: number; blenderVersion: string; hashes: { script: string; grass: string; flowers: string };
}) {
  return blenderScriptSpec({
    assetId: meadowKey(piece),
    inputs: {
      script: { path: "greyhaven_meadow.py", sha256: hashes.script },
      grass: { path: "grass.png", sha256: hashes.grass },
      flowers: { path: "flowers.png", sha256: hashes.flowers },
    },
    blenderVersion, arguments: { schemaVersion: 1, piece, level }, output: `${MEADOW_VARIANTS[level]}.glb`,
  });
}

type Built = KitPart & { piece: MeadowPiece; variant: (typeof MEADOW_VARIANTS)[number] };

export async function buildGreyhavenMeadow({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("greyhaven_meadow.py");
  const sources = JSON.parse(await readFile(path.join(ROOT, "catalog/sources.json"), "utf8"));
  const providers = JSON.parse(await readFile(path.join(ROOT, "catalog/providers.json"), "utf8"));
  const storage = JSON.parse(await readFile(path.join(ROOT, "catalog/storage.json"), "utf8"));
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const imported = {} as Record<keyof typeof MEADOW_SOURCES, { asset: AssetRef; bytes: Uint8Array }>;
  for (const [name, sourceId] of Object.entries(MEADOW_SOURCES) as [keyof typeof MEADOW_SOURCES, string][]) {
    const asset = (await importAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
    imported[name] = { asset, bytes: new Uint8Array(await resolveAssetObject(root, asset)) };
  }
  const files = { "greyhaven_meadow.py": source.bytes, "grass.png": imported.grass.bytes, "flowers.png": imported.flowers.bytes };
  const hashes = { script: source.sha256, grass: sha256Bytes(imported.grass.bytes), flowers: sha256Bytes(imported.flowers.bytes) };

  const built: Built[] = [];
  for (const piece of MEADOW_PIECES) {
    for (const [level, variant] of MEADOW_VARIANTS.entries()) {
      log(`generate ${piece} ${variant}`);
      const part = await buildKitPart(root, {
        workspace: path.join(root, "pieces", `${piece}.${variant}`), files,
        spec: createMeadowSpec({ piece, level, hashes, blenderVersion: source.blenderVersion }),
      });
      built.push({ piece, variant, ...part });
    }
  }

  log("measure the descriptor");
  const assets = MEADOW_PIECES.map((piece) => {
    const levels = built.filter((part) => part.piece === piece);
    const { document, observations } = levels[0]!;
    const bounds = documentBounds(document);
    const count = triangles(document);
    return {
      key: meadowKey(piece), kind: piece, triangles: count, bounds, collision: "none",
      footprint: { width: round(bounds.max[0] - bounds.min[0]), depth: round(bounds.max[2] - bounds.min[2]), height: round(bounds.max[1]) },
      coverM2: observations.coverM2, trianglesPerCoveredM2: Math.round(count / Number(observations.coverM2)),
      flowers: observations.flowers,
      ...scatterLods(bounds, levels.map((level) => ({ variant: level.variant, triangles: triangles(level.document) }))),
    };
  });
  const descriptor = {
    schema: MEADOW_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", handedness: "right", origin: "patch-centre-on-ground",
    placement: "The origin is the patch's centre on the ground; card feet run 3 cm below it, so a patch stays rooted on uneven ground. "
      + "Each patch wanders along X with a ragged outline. Turn (any angle about +Y), scale (about 0.8 to 1.25) and tint each placement; "
      + "overlap patches and leave gaps, so a meadow never reads as an even carpet. The game owns where and how densely they stand. "
      + "coverM2 is the ground a patch covers; trianglesPerCoveredM2 its full-detail triangles over that.",
    collision: "Walk-through grass and flowers: every piece declares `collision: \"none\"`.",
    tint: "Grass, stems and clover heads are greyscale in the atlas and take their colour from COLOR_0, so a material colour multiplies over them; buttercup, campion and daisy heads carry their own colour.",
    lodSelection: SCATTER_LOD_SELECTION,
    assets,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: MEADOW_DESCRIPTOR_ATTACHMENT, mediaType: "application/json" })).asset;

  log("encode the atlas as KTX2 (ktx create)");
  const delivered = await ktx2Assets(root, MEADOW_RELEASE, built.map((part) => part.asset));
  const selections = built.map((part, index) => ({
    key: meadowKey(part.piece), variant: part.variant, ...(index === 0 ? { attachments: [{ name: MEADOW_DESCRIPTOR_ATTACHMENT }] } : {}),
  }));
  const packed = await exportKitBundle(root, {
    tarName: MEADOW_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(built.map((part) => [`${part.piece}.${part.variant}`, part.document])),
    lineage: {
      recipe: { script: "adapters/blender/greyhaven_meadow.py", sha256: source.sha256, blenderVersion: source.blenderVersion },
      sources: Object.fromEntries(Object.entries(MEADOW_SOURCES).map(([name, id]) => [name, { id, license: "CC0-1.0", asset: imported[name as keyof typeof MEADOW_SOURCES].asset }])),
      release: MEADOW_RELEASE, descriptor: descriptorAsset,
      observations: Object.fromEntries(built.map((part) => [`${meadowKey(part.piece)}#${part.variant}`, part.observations])),
    },
  };
}

if (import.meta.main) {
  await runKitCli("scripts/build-greyhaven-meadow.ts", MEADOW_RELEASE, buildGreyhavenMeadow, { descriptorFile: true });
}
