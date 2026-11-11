// Build the Greyhaven pines kit for mmorpg (docs/greyhaven-pines.md, #569):
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-pines.ts [--textures full|half] --out <directory>
// Each piece and level is one external.blender.script@1 run of adapters/blender/greyhaven_pines.py, which reuses the
// greyhaven-trees recipe (skeleton, bark, clump crown) and the greyhaven-nature fir crown (conifer_crown.py), imported
// through scene.import.gltf@2. Every level grows from the same seeded skeleton in the same frame, so no placement step is
// needed. Every texture ships as KTX2. <directory> becomes the object-store root; the bundle is exported to
// <directory>/bundle and packed to <directory>/greyhaven-pines.kit.tar. No game places the kit yet.
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
import { buildKitPart, documentBounds, exportKitBundle, ktx2Assets, round, runKitCli, triangles, type KitPart } from "../src/kit-bundle.js";
import type { AssetRef } from "../src/operations.js";
import { NATURE_LOD_DISTANCES, NATURE_LOD_METRIC, NATURE_LOD_REFERENCE_FOV_Y } from "./build-greyhaven-nature.ts";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const PINE_PIECES = ["scots-pine", "scots-pine-windswept", "spruce", "spruce-young", "pine-dead", "pine-sapling"] as const;
export type PinePiece = (typeof PINE_PIECES)[number];
export const PINE_VARIANTS = ["default", "lod1", "lod2"] as const;
export const PINES_KEY_PREFIX = "greyhaven-pines.kit";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const PINES_RELEASE = "greyhaven-pines";
export const PINES_TAR_NAME = "greyhaven-pines.kit.tar";
export const PINES_MATERIALS = ["Greyhaven_Pines_Bark", "Greyhaven_Pines_Needles"] as const;
export const PINES_DESCRIPTOR_SCHEMA = "greyhaven-pines-descriptor-v1";
export const PINES_DESCRIPTOR_ATTACHMENT = "greyhaven-pines-descriptor";
/** The catalogued CC0 sources: the Quaternius bark (furrowed cell) and the Poly Haven fir twig atlas (sprig cells). */
export const PINES_SOURCES = {
  bark: "quaternius.stylized-nature-megakit-standard.bark-normaltree-png",
  needles: "poly-haven.fir-tree-01-twig-diff-2k-jpg",
  needleAlpha: "poly-haven.fir-tree-01-twig-alpha-2k-jpg",
} as const;
/**
 * Full-detail triangle ceiling: greyhaven-nature's conifer (7,115). Trees have blown the game's frame budget before
 * (mmorpg's TREE_MIN_SCREEN_SIZES), so no pine may exceed it.
 */
export const PINE_TRIANGLES = 7115;
/** Where LOD0 and lod1 end, in metres at the reference FOV: greyhaven-trees' (and greyhaven-nature's) 90 m and 300 m. */
export const PINE_LOD_DISTANCES = NATURE_LOD_DISTANCES.tree;

export const pineKey = (piece: PinePiece) => `${PINES_KEY_PREFIX}.${piece}`;

export function createPineSpec({ piece, level, hashes, blenderVersion }: {
  piece: PinePiece; level: number; blenderVersion: string;
  hashes: { script: string; trees: string; conifer: string; lod: string; bark: string; needles: string; needleAlpha: string };
}) {
  return blenderScriptSpec({
    assetId: pineKey(piece),
    inputs: {
      script: { path: "greyhaven_pines.py", sha256: hashes.script },
      trees: { path: "greyhaven_trees.py", sha256: hashes.trees },
      conifer: { path: "conifer_crown.py", sha256: hashes.conifer },
      lod: { path: "nature_lod.py", sha256: hashes.lod },
      bark: { path: "bark.png", sha256: hashes.bark },
      needles: { path: "needles.jpg", sha256: hashes.needles },
      needleAlpha: { path: "needle-alpha.jpg", sha256: hashes.needleAlpha },
    },
    blenderVersion, arguments: { schemaVersion: 1, piece, level }, output: `${PINE_VARIANTS[level]}.glb`,
  });
}

type Built = KitPart & { piece: PinePiece; variant: (typeof PINE_VARIANTS)[number] };

export async function buildGreyhavenPines({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("greyhaven_pines.py");
  const trees = await readBlenderRecipeSource("greyhaven_trees.py");
  const conifer = await readBlenderRecipeSource("conifer_crown.py");
  const lod = await readBlenderRecipeSource("nature_lod.py");
  const sources = JSON.parse(await readFile(path.join(ROOT, "catalog/sources.json"), "utf8"));
  const providers = JSON.parse(await readFile(path.join(ROOT, "catalog/providers.json"), "utf8"));
  const storage = JSON.parse(await readFile(path.join(ROOT, "catalog/storage.json"), "utf8"));
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const imported = {} as Record<keyof typeof PINES_SOURCES, { asset: AssetRef; bytes: Uint8Array }>;
  for (const [name, sourceId] of Object.entries(PINES_SOURCES) as [keyof typeof PINES_SOURCES, string][]) {
    const asset = (await importAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
    imported[name] = { asset, bytes: new Uint8Array(await resolveAssetObject(root, asset)) };
  }
  const files = {
    "greyhaven_pines.py": source.bytes, "greyhaven_trees.py": trees.bytes, "conifer_crown.py": conifer.bytes, "nature_lod.py": lod.bytes,
    "bark.png": imported.bark.bytes, "needles.jpg": imported.needles.bytes, "needle-alpha.jpg": imported.needleAlpha.bytes,
  };
  const hashes = {
    script: source.sha256, trees: trees.sha256, conifer: conifer.sha256, lod: lod.sha256,
    bark: sha256Bytes(imported.bark.bytes), needles: sha256Bytes(imported.needles.bytes), needleAlpha: sha256Bytes(imported.needleAlpha.bytes),
  };

  const built: Built[] = [];
  for (const piece of PINE_PIECES) {
    for (const [level, variant] of PINE_VARIANTS.entries()) {
      log(`generate ${piece} ${variant}`);
      const part = await buildKitPart(root, {
        workspace: path.join(root, "pieces", `${piece}.${variant}`), files,
        spec: createPineSpec({ piece, level, hashes, blenderVersion: source.blenderVersion }),
      });
      built.push({ piece, variant, ...part });
    }
  }

  log("measure the descriptor");
  const tan = Math.tan((NATURE_LOD_REFERENCE_FOV_Y / 2) * Math.PI / 180);
  const assets = PINE_PIECES.map((piece) => {
    const levels = built.filter((part) => part.piece === piece);
    const { document, observations } = levels[0]!;
    const bounds = documentBounds(document);
    const radius = round(Math.hypot(...[0, 1, 2].map((k) => bounds.max[k]! - bounds.min[k]!)) / 2);
    return {
      key: pineKey(piece), kind: piece, triangles: triangles(document), bounds,
      footprint: { width: round(bounds.max[0] - bounds.min[0]), depth: round(bounds.max[2] - bounds.min[2]), height: round(bounds.max[1]) },
      collisionMesh: observations.collisionMesh,
      lods: {
        boundingSphere: { center: [0, 1, 2].map((k) => round((bounds.min[k]! + bounds.max[k]!) / 2)), radius },
        levels: levels.map((level, index) => {
          const distance = PINE_LOD_DISTANCES[index];
          return { variant: level.variant, triangles: triangles(level.document), minScreenSize: distance ? Number((radius / (distance * tan)).toFixed(4)) : 0, referenceMaxDistance: distance ?? null };
        }),
      },
    };
  });
  const descriptor = {
    schema: PINES_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", handedness: "right", origin: "trunk-foot",
    placement: "The origin is the trunk's foot on the ground; the root flare runs 0.3 m below it, so a placement on uneven ground stays rooted. "
      + "The windswept pine leans towards +X; turn it so it leans away from the prevailing wind. Turn and scale each placement; the game owns where trees stand.",
    collision: "Every piece carries `collisionMesh`, a closed, outward-wound tube around the trunk from below the ground to its first fork (at most 3 m). Crowns are walk-through.",
    lodSelection: {
      metric: NATURE_LOD_METRIC, referenceFovYDegrees: NATURE_LOD_REFERENCE_FOV_Y,
      rule: "Use the first level whose minScreenSize is at most the asset's projected bounding-sphere diameter divided by the viewport height "
        + "(radius / (distance * tan(fovY / 2)), scaled by the instance scale). referenceMaxDistance is the distance in metres at which that "
        + "level ends for an unscaled instance at referenceFovYDegrees.",
    },
    assets,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "greyhaven-pines-descriptor", mediaType: "application/json" })).asset;

  log("encode every texture as KTX2 (ktx create)");
  const delivered = await ktx2Assets(root, PINES_RELEASE, built.map((part) => part.asset));
  const selections = built.map((part, index) => ({
    key: pineKey(part.piece), variant: part.variant, ...(index === 0 ? { attachments: [{ name: PINES_DESCRIPTOR_ATTACHMENT }] } : {}),
  }));
  const packed = await exportKitBundle(root, {
    tarName: PINES_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    lineage: {
      recipe: {
        script: "adapters/blender/greyhaven_pines.py", sha256: source.sha256,
        trees: { script: "adapters/blender/greyhaven_trees.py", sha256: trees.sha256 },
        conifer: { script: "adapters/blender/conifer_crown.py", sha256: conifer.sha256 },
        lod: { script: "adapters/blender/nature_lod.py", sha256: lod.sha256 }, blenderVersion: source.blenderVersion,
      },
      sources: Object.fromEntries(Object.entries(PINES_SOURCES).map(([name, id]) => [name, { id, license: "CC0-1.0", asset: imported[name as keyof typeof PINES_SOURCES].asset }])),
      release: PINES_RELEASE, descriptor: descriptorAsset,
      observations: Object.fromEntries(built.map((part) => {
        const { collisionMesh: _collision, ...rest } = part.observations;
        return [`${pineKey(part.piece)}#${part.variant}`, rest];
      })),
    },
  };
}

if (import.meta.main) {
  await runKitCli("scripts/build-greyhaven-pines.ts", "greyhaven-pines", buildGreyhavenPines, { descriptorFile: true });
}
