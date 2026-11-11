// Build the Greyhaven trees kit for mmorpg (docs/greyhaven-trees.md, #568):
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-trees.ts [--textures full|half] --out <directory>
// Each piece and level is one external.blender.script@1 run of adapters/blender/greyhaven_trees.py, imported through
// scene.import.gltf@2. The recipe grows every level from the same seeded skeleton in the same frame, so no placement
// step is needed. Every texture ships as KTX2. <directory> becomes the object-store root; the bundle is exported to
// <directory>/bundle and packed to <directory>/greyhaven-trees.kit.tar. No game places the kit yet.
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
export const TREE_PIECES = ["oak", "oak-young", "beech", "beech-young", "birch", "alder", "dead-oak", "sapling"] as const;
export type TreePiece = (typeof TREE_PIECES)[number];
export const TREE_VARIANTS = ["default", "lod1", "lod2"] as const;
export const TREES_KEY_PREFIX = "greyhaven-trees.kit";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const TREES_RELEASE = "greyhaven-trees";
export const TREES_TAR_NAME = "greyhaven-trees.kit.tar";
export const TREES_MATERIALS = ["Greyhaven_Trees_Bark", "Greyhaven_Trees_Leaves"] as const;
export const TREES_DESCRIPTOR_SCHEMA = "greyhaven-trees-descriptor-v1";
export const TREES_DESCRIPTOR_ATTACHMENT = "greyhaven-trees-descriptor";
/** The catalogued CC0 Quaternius bark the furrowed bark cell is made from. */
export const TREES_BARK_SOURCE = "quaternius.stylized-nature-megakit-standard.bark-normaltree-png";
/**
 * Full-detail triangle ceiling: greyhaven-nature's broadleaf (7,217), which the game already had to push to far
 * levels sooner (mmorpg's TREE_MIN_SCREEN_SIZES). These trees stay well below it.
 */
export const TREE_TRIANGLES = 7200;
/**
 * Where LOD0 and lod1 end, in metres at the reference FOV: greyhaven-nature's tree distances (#534), as the issue asks,
 * the same for every piece. Both are past the kit standard's 60 m and 180 m floors.
 */
export const TREE_LOD_DISTANCES = NATURE_LOD_DISTANCES.tree;

export const treeKey = (piece: TreePiece) => `${TREES_KEY_PREFIX}.${piece}`;

export function createTreeSpec({ piece, level, scriptSha256, bushesSha256, lodSha256, barkSha256, blenderVersion }: {
  piece: TreePiece; level: number; scriptSha256: string; bushesSha256: string; lodSha256: string; barkSha256: string; blenderVersion: string;
}) {
  return blenderScriptSpec({
    assetId: treeKey(piece),
    inputs: {
      script: { path: "greyhaven_trees.py", sha256: scriptSha256 },
      bushes: { path: "woodland_bushes.py", sha256: bushesSha256 },
      lod: { path: "nature_lod.py", sha256: lodSha256 },
      bark: { path: "bark.png", sha256: barkSha256 },
    },
    blenderVersion, arguments: { schemaVersion: 1, piece, level }, output: `${TREE_VARIANTS[level]}.glb`,
  });
}

type Built = KitPart & { piece: TreePiece; variant: (typeof TREE_VARIANTS)[number] };

export async function buildGreyhavenTrees({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("greyhaven_trees.py");
  const bushes = await readBlenderRecipeSource("woodland_bushes.py");
  const lod = await readBlenderRecipeSource("nature_lod.py");
  const sources = JSON.parse(await readFile(path.join(ROOT, "catalog/sources.json"), "utf8"));
  const providers = JSON.parse(await readFile(path.join(ROOT, "catalog/providers.json"), "utf8"));
  const storage = JSON.parse(await readFile(path.join(ROOT, "catalog/storage.json"), "utf8"));
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const barkAsset = (await importAssetCatalogStorageSource({ catalog, storage, sourceId: TREES_BARK_SOURCE, storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
  const barkBytes = new Uint8Array(await resolveAssetObject(root, barkAsset));
  const files = { "greyhaven_trees.py": source.bytes, "woodland_bushes.py": bushes.bytes, "nature_lod.py": lod.bytes, "bark.png": barkBytes };
  const hashes = { scriptSha256: source.sha256, bushesSha256: bushes.sha256, lodSha256: lod.sha256, barkSha256: sha256Bytes(barkBytes) };

  const built: Built[] = [];
  for (const piece of TREE_PIECES) {
    for (const [level, variant] of TREE_VARIANTS.entries()) {
      log(`generate ${piece} ${variant}`);
      const part = await buildKitPart(root, {
        workspace: path.join(root, "pieces", `${piece}.${variant}`), files,
        spec: createTreeSpec({ piece, level, ...hashes, blenderVersion: source.blenderVersion }),
      });
      built.push({ piece, variant, ...part });
    }
  }

  log("measure the descriptor");
  const tan = Math.tan((NATURE_LOD_REFERENCE_FOV_Y / 2) * Math.PI / 180);
  const assets = TREE_PIECES.map((piece) => {
    const levels = built.filter((part) => part.piece === piece);
    const { document, observations } = levels[0]!;
    const bounds = documentBounds(document);
    const radius = round(Math.hypot(...[0, 1, 2].map((k) => bounds.max[k]! - bounds.min[k]!)) / 2);
    return {
      key: treeKey(piece), kind: piece, triangles: triangles(document), bounds,
      footprint: { width: round(bounds.max[0] - bounds.min[0]), depth: round(bounds.max[2] - bounds.min[2]), height: round(bounds.max[1]) },
      collisionMesh: observations.collisionMesh,
      lods: {
        boundingSphere: { center: [0, 1, 2].map((k) => round((bounds.min[k]! + bounds.max[k]!) / 2)), radius },
        levels: levels.map((level, index) => {
          const distance = TREE_LOD_DISTANCES[index];
          return { variant: level.variant, triangles: triangles(level.document), minScreenSize: distance ? Number((radius / (distance * tan)).toFixed(4)) : 0, referenceMaxDistance: distance ?? null };
        }),
      },
    };
  });
  const descriptor = {
    schema: TREES_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", handedness: "right", origin: "trunk-foot",
    placement: `The origin is the trunk's foot on the ground; the root flare runs 0.3 m below it, so a placement on uneven ground stays rooted. Turn and scale each placement; the game owns where trees stand.`,
    collision: "Every piece carries `collisionMesh`, a closed, outward-wound tube around the trunk from below the ground to its first fork (at most 3 m). Crowns are walk-through.",
    lodSelection: {
      metric: NATURE_LOD_METRIC, referenceFovYDegrees: NATURE_LOD_REFERENCE_FOV_Y,
      rule: "Use the first level whose minScreenSize is at most the asset's projected bounding-sphere diameter divided by the viewport height "
        + "(radius / (distance * tan(fovY / 2)), scaled by the instance scale). referenceMaxDistance is the distance in metres at which that "
        + "level ends for an unscaled instance at referenceFovYDegrees.",
    },
    assets,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "greyhaven-trees-descriptor", mediaType: "application/json" })).asset;

  log("encode every texture as KTX2 (ktx create)");
  const delivered = await ktx2Assets(root, TREES_RELEASE, built.map((part) => part.asset));
  const selections = built.map((part, index) => ({
    key: treeKey(part.piece), variant: part.variant, ...(index === 0 ? { attachments: [{ name: TREES_DESCRIPTOR_ATTACHMENT }] } : {}),
  }));
  const packed = await exportKitBundle(root, {
    tarName: TREES_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    lineage: {
      recipe: {
        script: "adapters/blender/greyhaven_trees.py", sha256: source.sha256,
        bushes: { script: "adapters/blender/woodland_bushes.py", sha256: bushes.sha256 },
        lod: { script: "adapters/blender/nature_lod.py", sha256: lod.sha256 }, blenderVersion: source.blenderVersion,
      },
      sources: { bark: { id: TREES_BARK_SOURCE, license: "CC0-1.0", asset: barkAsset } },
      release: TREES_RELEASE, descriptor: descriptorAsset,
      observations: Object.fromEntries(built.map((part) => {
        const { collisionMesh: _collision, ...rest } = part.observations;
        return [`${treeKey(part.piece)}#${part.variant}`, rest];
      })),
    },
  };
}

if (import.meta.main) {
  await runKitCli("scripts/build-greyhaven-trees.ts", "greyhaven-trees", buildGreyhavenTrees, { descriptorFile: true });
}
