// Build the Greyhaven deadwood kit for mmorpg (docs/greyhaven-deadwood.md, #573):
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-deadwood.ts [--textures full|half] --out <directory>
// Each piece and level is one external.blender.script@1 run of adapters/blender/greyhaven_deadwood.py, which reuses the
// greyhaven-trees and greyhaven-pines bark cells and moss.py's moss grading (declared, hash-pinned inputs), imported
// through scene.import.gltf@2. Every level is built in the same frame from the same seed, all on one opaque atlas,
// which ships as KTX2. <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and
// packed to <directory>/greyhaven-deadwood.kit.tar. No game places the kit yet.
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
export const DEADWOOD_PIECES = ["log-oak", "log-pine", "log-hollow", "stump-oak", "stump-pine", "root-plate", "branch-pile", "branches-scatter"] as const;
export type DeadwoodPiece = (typeof DEADWOOD_PIECES)[number];
/** Walk-through pieces; every other piece is solid and carries `collisionMesh`. */
export const DEADWOOD_WALK_THROUGH: readonly DeadwoodPiece[] = ["branch-pile", "branches-scatter"];
export const DEADWOOD_VARIANTS = ["default", "lod1", "lod2"] as const;
export const DEADWOOD_KEY_PREFIX = "greyhaven-deadwood.kit";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const DEADWOOD_RELEASE = "greyhaven-deadwood";
export const DEADWOOD_TAR_NAME = "greyhaven-deadwood.kit.tar";
export const DEADWOOD_MATERIAL = "Greyhaven_Deadwood";
export const DEADWOOD_DESCRIPTOR_SCHEMA = "greyhaven-deadwood-descriptor-v1";
export const DEADWOOD_DESCRIPTOR_ATTACHMENT = "greyhaven-deadwood-descriptor";
/** The catalogued CC0 sources: the Quaternius bark (the trees' furrowed cell), the Poly Haven moss scan and forest ground. */
export const DEADWOOD_SOURCES = {
  bark: "quaternius.stylized-nature-megakit-standard.bark-normaltree-png",
  mossColour: "poly-haven.mossy-rock-diff-2k-jpg",
  soil: "poly-haven.forrest-ground-01-diff-2k-jpg",
} as const;
/** Props: no piece may exceed this many triangles at full detail (kit standard). */
export const DEADWOOD_TRIANGLES = 2000;
/** Where LOD0 and lod1 end for a piece up to 1 m across, in metres at the reference FOV; scaledLodDistances grows them for larger pieces. */
export const DEADWOOD_LOD_DISTANCES = [60, 180] as const;
const LOD_REFERENCE_FOV_Y = 60;

export const deadwoodKey = (piece: DeadwoodPiece) => `${DEADWOOD_KEY_PREFIX}.${piece}`;

const ORIGINS: Record<DeadwoodPiece, string> = {
  "log-oak": "log-centre-on-ground", "log-pine": "log-centre-on-ground", "log-hollow": "log-centre-on-ground",
  "stump-oak": "stump-centre-on-ground", "stump-pine": "stump-centre-on-ground", "root-plate": "plate-foot-on-ground",
  "branch-pile": "patch-centre-on-ground", "branches-scatter": "patch-centre-on-ground",
};

type Hashes = { script: string; trees: string; pines: string; moss: string; bark: string; mossColour: string; soil: string };

export function createDeadwoodSpec({ piece, level, hashes, blenderVersion }: { piece: DeadwoodPiece; level: number; blenderVersion: string; hashes: Hashes }) {
  return blenderScriptSpec({
    assetId: deadwoodKey(piece),
    inputs: {
      script: { path: "greyhaven_deadwood.py", sha256: hashes.script },
      trees: { path: "greyhaven_trees.py", sha256: hashes.trees },
      pines: { path: "greyhaven_pines.py", sha256: hashes.pines },
      moss: { path: "moss.py", sha256: hashes.moss },
      bark: { path: "bark.png", sha256: hashes.bark },
      mossColour: { path: "moss-colour.jpg", sha256: hashes.mossColour },
      soil: { path: "soil.jpg", sha256: hashes.soil },
    },
    blenderVersion, arguments: { schemaVersion: 1, piece, level }, output: `${DEADWOOD_VARIANTS[level]}.glb`,
  });
}

type Built = KitPart & { piece: DeadwoodPiece; variant: (typeof DEADWOOD_VARIANTS)[number] };

export async function buildGreyhavenDeadwood({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("greyhaven_deadwood.py");
  const trees = await readBlenderRecipeSource("greyhaven_trees.py");
  const pines = await readBlenderRecipeSource("greyhaven_pines.py");
  const moss = await readBlenderRecipeSource("moss.py");
  const sources = JSON.parse(await readFile(path.join(ROOT, "catalog/sources.json"), "utf8"));
  const providers = JSON.parse(await readFile(path.join(ROOT, "catalog/providers.json"), "utf8"));
  const storage = JSON.parse(await readFile(path.join(ROOT, "catalog/storage.json"), "utf8"));
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const imported = {} as Record<keyof typeof DEADWOOD_SOURCES, { asset: AssetRef; bytes: Uint8Array }>;
  for (const [name, sourceId] of Object.entries(DEADWOOD_SOURCES) as [keyof typeof DEADWOOD_SOURCES, string][]) {
    const asset = (await importAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
    imported[name] = { asset, bytes: new Uint8Array(await resolveAssetObject(root, asset)) };
  }
  const files = {
    "greyhaven_deadwood.py": source.bytes, "greyhaven_trees.py": trees.bytes, "greyhaven_pines.py": pines.bytes, "moss.py": moss.bytes,
    "bark.png": imported.bark.bytes, "moss-colour.jpg": imported.mossColour.bytes, "soil.jpg": imported.soil.bytes,
  };
  const hashes: Hashes = {
    script: source.sha256, trees: trees.sha256, pines: pines.sha256, moss: moss.sha256,
    bark: sha256Bytes(imported.bark.bytes), mossColour: sha256Bytes(imported.mossColour.bytes), soil: sha256Bytes(imported.soil.bytes),
  };

  const built: Built[] = [];
  for (const piece of DEADWOOD_PIECES) {
    for (const [level, variant] of DEADWOOD_VARIANTS.entries()) {
      log(`generate ${piece} ${variant}`);
      const part = await buildKitPart(root, {
        workspace: path.join(root, "pieces", `${piece}.${variant}`), files,
        spec: createDeadwoodSpec({ piece, level, hashes, blenderVersion: source.blenderVersion }),
      });
      built.push({ piece, variant, ...part });
    }
  }

  log("measure the descriptor");
  const tan = Math.tan((LOD_REFERENCE_FOV_Y / 2) * Math.PI / 180);
  const assets = DEADWOOD_PIECES.map((piece) => {
    const levels = built.filter((part) => part.piece === piece);
    const { document, observations } = levels[0]!;
    const bounds = documentBounds(document);
    const radius = round(Math.hypot(...[0, 1, 2].map((k) => bounds.max[k]! - bounds.min[k]!)) / 2);
    const distances = scaledLodDistances(DEADWOOD_LOD_DISTANCES, bounds);
    return {
      key: deadwoodKey(piece), kind: piece, triangles: triangles(document), bounds, origin: ORIGINS[piece],
      footprint: { width: round(bounds.max[0] - bounds.min[0]), depth: round(bounds.max[2] - bounds.min[2]), height: round(bounds.max[1]) },
      ...(observations.collisionMesh ? { collisionMesh: observations.collisionMesh } : { collision: "none" }),
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
    schema: DEADWOOD_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", handedness: "right",
    placement: "Logs lie along X with the origin at the centre of their footprint on the ground; each sinks a few centimetres into it. "
      + "Stumps stand on the origin with their root flare 0.25 m below the ground. The root plate stands across X with its foot on the origin, 0.25 m buried, "
      + "and the torn stub of its trunk leaving towards +X: place a log beyond it to finish the fallen tree, and dig a hollow on the -X side if the terrain allows. "
      + "Branch piles and scatters centre on the origin on the ground. Turn every piece about +Y and scale it about 0.85 to 1.2; the game owns where deadwood lies.",
    collision: "Logs, stumps and the root plate carry `collisionMesh`, a closed, outward-wound mesh of at most 240 triangles that follows the wood at or just inside "
      + "its surface, so a character can step or climb onto it. The branch pile and scatter are walk-through and declare `collision: \"none\"`.",
    material: `One opaque material, ${DEADWOOD_MATERIAL}, on one atlas. The atlas carries the colour (bark, moss, end grain, rotten wood, earth); COLOR_0 only darkens it near the ground and underneath.`,
    lodSelection: {
      metric: "projected-bounding-sphere-height-fraction", referenceFovYDegrees: LOD_REFERENCE_FOV_Y,
      rule: "Use the first level whose minScreenSize is at most the asset's projected bounding-sphere diameter divided by the viewport height "
        + "(radius / (distance * tan(fovY / 2)), scaled by the instance scale). referenceMaxDistance is the distance in metres at which that "
        + "level ends for an unscaled instance at referenceFovYDegrees.",
    },
    assets,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: DEADWOOD_DESCRIPTOR_ATTACHMENT, mediaType: "application/json" })).asset;

  log("encode the atlas as KTX2 (ktx create)");
  const delivered = await ktx2Assets(root, DEADWOOD_RELEASE, built.map((part) => part.asset));
  const selections = built.map((part, index) => ({
    key: deadwoodKey(part.piece), variant: part.variant, ...(index === 0 ? { attachments: [{ name: DEADWOOD_DESCRIPTOR_ATTACHMENT }] } : {}),
  }));
  const packed = await exportKitBundle(root, {
    tarName: DEADWOOD_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    lineage: {
      recipe: {
        script: "adapters/blender/greyhaven_deadwood.py", sha256: source.sha256, blenderVersion: source.blenderVersion,
        trees: { script: "adapters/blender/greyhaven_trees.py", sha256: trees.sha256 },
        pines: { script: "adapters/blender/greyhaven_pines.py", sha256: pines.sha256 },
        moss: { script: "adapters/blender/moss.py", sha256: moss.sha256 },
      },
      sources: Object.fromEntries(Object.entries(DEADWOOD_SOURCES).map(([name, id]) => [name, { id, license: "CC0-1.0", asset: imported[name as keyof typeof DEADWOOD_SOURCES].asset }])),
      release: DEADWOOD_RELEASE, descriptor: descriptorAsset,
      observations: Object.fromEntries(built.map((part) => {
        const { collisionMesh: _collision, ...rest } = part.observations;
        return [`${deadwoodKey(part.piece)}#${part.variant}`, rest];
      })),
    },
  };
}

if (import.meta.main) {
  await runKitCli("scripts/build-greyhaven-deadwood.ts", DEADWOOD_RELEASE, buildGreyhavenDeadwood, { descriptorFile: true });
}
