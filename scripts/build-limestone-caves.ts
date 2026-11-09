// Build the limestone cave kit (docs/limestone-caves.md, #559) from the scripted recipe adapters/blender/limestone_caves.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-limestone-caves.ts [--textures full|half] --out <directory>
// Each piece is one external.blender.script@1 run, imported through scene.import.gltf@2; adapters/blender/nature_lod.py makes lod1 and lod2
// from it in the same frame. <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and packed to
// <directory>/limestone-caves.kit.tar. No game places the kit yet.
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO, type Document } from "@gltf-transform/core";
import { KHRTextureBasisu } from "@gltf-transform/extensions";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec, type BlenderSpecInput } from "../src/blender-script-spec.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { sha256Bytes } from "../src/hash.js";
import { buildKitPart, documentBounds, exportKitBundle, ktx2Assets, round, runKitCli, scaledLodDistances, triangles, type KitPart } from "../src/kit-bundle.js";
import type { AssetRef } from "../src/operations.js";
import { withLightingAttributes } from "./baked-rock-kit.ts";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const CAVE_PIECES = ["tunnel", "bend", "junction", "ramp", "dead-end", "cap", "room-small", "room-medium", "room-large", "mouth", "spikes-floor", "spikes-roof"] as const;
export type CavePiece = (typeof CAVE_PIECES)[number];
export const CAVE_VARIANTS = ["default", "lod1", "lod2"] as const;
export const CAVE_KEY_PREFIX = "limestone-caves.kit";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const CAVE_RELEASE = "limestone-caves";
export const CAVE_TAR_NAME = "limestone-caves.kit.tar";
export const CAVE_MATERIALS = ["cave-floor", "cave-rock"] as const;
export const CAVE_DESCRIPTOR_SCHEMA = "limestone-caves-descriptor-v1";
export const CAVE_DESCRIPTOR_ATTACHMENT = "limestone-caves-descriptor";
export const CAVE_SOURCES = {
  rockColour: "poly-haven.rock-face-03-diff-2k-jpg",
  rockHeight: "poly-haven.rock-face-03-disp-2k-jpg",
  gravelColour: "poly-haven.rocks-ground-02-diff-2k-jpg",
  earthColour: "poly-haven.forrest-ground-01-diff-2k-jpg",
} as const;
/** Full-detail triangle ceiling: the kit standard's guide for hero objects. */
export const CAVE_TRIANGLE_BUDGET = 9000;
/** Where LOD0 and lod1 end for a piece up to 1 m across, in metres at the reference FOV; scaledLodDistances grows them for larger pieces. */
export const CAVE_LOD_DISTANCES = [60, 180] as const;
const CAVE_LOD_RATIOS = [0.35, 0.1] as const;
const LOD_REFERENCE_FOV_Y = 60;
/** The recipe exports no tangents: withLightingAttributes adds them after the import. */
const VALIDATOR_WARNINGS = ["MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"];

export const caveKey = (piece: CavePiece) => `${CAVE_KEY_PREFIX}.${piece}`;

export function createCaveSpec({ piece, recipeSha256, inputSha256, blenderVersion }: {
  piece: CavePiece; recipeSha256: Record<"script" | "outcrop" | "common", string>; inputSha256: Record<keyof typeof CAVE_SOURCES, string>; blenderVersion: string;
}) {
  const inputs: { script: BlenderSpecInput } & Record<string, BlenderSpecInput> = {
    script: { path: "limestone_caves.py", sha256: recipeSha256.script }, outcrop: { path: "cliff_outcrop.py", sha256: recipeSha256.outcrop }, common: { path: "kit_common.py", sha256: recipeSha256.common },
  };
  for (const name of Object.keys(CAVE_SOURCES) as (keyof typeof CAVE_SOURCES)[]) inputs[name] = { path: `${name}.jpg`, sha256: inputSha256[name] };
  return blenderScriptSpec({ assetId: caveKey(piece), inputs, blenderVersion, arguments: { schemaVersion: 1, piece }, output: "cave.glb" });
}

type Built = KitPart & { piece: CavePiece; variant: (typeof CAVE_VARIANTS)[number] };

export async function buildLimestoneCaves({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("limestone_caves.py");
  const outcrop = await readBlenderRecipeSource("cliff_outcrop.py");
  const common = await readBlenderRecipeSource("kit_common.py");
  const lodRecipe = await readBlenderRecipeSource("nature_lod.py");
  const sources = JSON.parse(await readFile(path.join(ROOT, "catalog/sources.json"), "utf8"));
  const providers = JSON.parse(await readFile(path.join(ROOT, "catalog/providers.json"), "utf8"));
  const storage = JSON.parse(await readFile(path.join(ROOT, "catalog/storage.json"), "utf8"));
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const files: Record<string, Uint8Array> = { "limestone_caves.py": source.bytes, "cliff_outcrop.py": outcrop.bytes, "kit_common.py": common.bytes };
  const inputSha256 = {} as Record<keyof typeof CAVE_SOURCES, string>;
  const scanAssets: Record<string, AssetRef> = {};
  for (const [name, sourceId] of Object.entries(CAVE_SOURCES) as [keyof typeof CAVE_SOURCES, string][]) {
    const asset = (await importAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
    const bytes = new Uint8Array(await resolveAssetObject(root, asset));
    files[`${name}.jpg`] = bytes;
    inputSha256[name] = sha256Bytes(bytes);
    scanAssets[name] = asset;
  }
  const recipeSha256 = { script: source.sha256, outcrop: outcrop.sha256, common: common.sha256 };

  const built: Built[] = [];
  for (const piece of CAVE_PIECES) {
    log(`generate ${piece}`);
    const main = await buildKitPart(root, {
      workspace: path.join(root, "pieces", `${piece}.default`), files, allowedValidatorWarnings: VALIDATOR_WARNINGS,
      spec: createCaveSpec({ piece, recipeSha256, inputSha256, blenderVersion: source.blenderVersion }),
    });
    built.push({ piece, variant: "default", ...main });
    const sourceBytes = new Uint8Array(await resolveAssetObject(root, main.asset));
    for (const [index, variant] of (["lod1", "lod2"] as const).entries()) {
      const level = await buildKitPart(root, {
        workspace: path.join(root, "pieces", `${piece}.${variant}`), files: { "nature_lod.py": lodRecipe.bytes, "source.glb": sourceBytes }, allowedValidatorWarnings: VALIDATOR_WARNINGS,
        spec: blenderScriptSpec({
          assetId: caveKey(piece), inputs: { script: { path: "nature_lod.py", sha256: lodRecipe.sha256 }, source: { path: "source.glb", sha256: sha256Bytes(sourceBytes) } },
          blenderVersion: lodRecipe.blenderVersion, arguments: { schemaVersion: 1, method: "decimate", ratio: CAVE_LOD_RATIOS[index]! }, output: `${variant}.glb`,
        }),
      });
      built.push({ piece, variant, ...level });
    }
  }

  log("add tangents");
  const io = new NodeIO().registerExtensions([KHRTextureBasisu]);
  const finished: AssetRef[] = [];
  for (const part of built) {
    await withLightingAttributes(part.document);
    finished.push((await storeAssetObject(root, { bytes: await io.writeBinary(part.document), kind: "scene", mediaType: "model/gltf-binary" })).asset);
  }

  log("measure the descriptor");
  const tan = Math.tan((LOD_REFERENCE_FOV_Y / 2) * Math.PI / 180);
  const assets = CAVE_PIECES.map((piece) => {
    const levels = built.filter((part) => part.piece === piece);
    const { document, observations } = levels[0]!;
    const bounds = documentBounds(document);
    const radius = round(Math.hypot(...[0, 1, 2].map((k) => bounds.max[k]! - bounds.min[k]!)) / 2);
    const distances = scaledLodDistances(CAVE_LOD_DISTANCES, bounds);
    return {
      key: caveKey(piece), role: piece, triangles: triangles(document), bounds,
      footprint: { width: round(bounds.max[0] - bounds.min[0]), depth: round(bounds.max[2] - bounds.min[2]), height: round(bounds.max[1] - bounds.min[1]) },
      ...(observations.openings ? { openings: observations.openings } : {}),
      ...(observations.collisionMesh ? { collisionMesh: observations.collisionMesh } : observations.collisionProxies ? { collisionProxies: observations.collisionProxies } : { collision: "none" }),
      lods: {
        boundingSphere: { center: [0, 1, 2].map((k) => round((bounds.min[k]! + bounds.max[k]!) / 2)), radius },
        levels: levels.map((level, index) => {
          const distance = distances[index];
          return { variant: level.variant, triangles: triangles(level.document), minScreenSize: distance ? round(Number((radius / (distance * tan)).toFixed(4))) : 0, referenceMaxDistance: distance ?? null };
        }),
      },
    };
  });
  const descriptor = {
    schema: CAVE_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", handedness: "right", origin: "module-centre-on-upper-floor", grid: 4,
    placement: "Join modules by matching `openings`: put two openings at the same point, facing opposite ways. Every opening is the same plain arch, 4 m wide and 3 m high. Turn modules in quarter turns. Close unused room openings with a cap. The ramp drops 4 m between its openings. The mouth's passage runs out at its north opening under its rocky mound, so the terrain needs a hole there.",
    collision: "Modules carry `collisionMesh`, a simplified shell of the cave's inner surface with faces looking into the cave; it is open at the openings. spikes-floor carries `collisionProxies`; spikes-roof declares `collision: \"none\"`.",
    lodSelection: {
      metric: "projected-bounding-sphere-height-fraction", referenceFovYDegrees: LOD_REFERENCE_FOV_Y,
      rule: "Use the first level whose minScreenSize is at most the asset's projected bounding-sphere diameter divided by the viewport height (radius / (distance * tan(fovY / 2)), scaled by the instance scale). referenceMaxDistance is the distance in metres at which that level ends for an unscaled instance at referenceFovYDegrees.",
    },
    assets,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: CAVE_DESCRIPTOR_ATTACHMENT, mediaType: "application/json" })).asset;

  log("encode the tiles as KTX2 (ktx create)");
  const delivered = await ktx2Assets(root, CAVE_RELEASE, finished);
  const selections = built.map((part, index) => ({ key: caveKey(part.piece), variant: part.variant, ...(index === 0 ? { attachments: [{ name: CAVE_DESCRIPTOR_ATTACHMENT }] } : {}) }));
  const packed = await exportKitBundle(root, {
    tarName: CAVE_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(built.filter((part) => part.variant === "default").map((part) => [part.piece, part.document])) as Record<CavePiece, Document>,
    lineage: {
      recipe: { script: "adapters/blender/limestone_caves.py", sha256: source.sha256, outcrop: { script: "adapters/blender/cliff_outcrop.py", sha256: outcrop.sha256 }, common: { script: "adapters/blender/kit_common.py", sha256: common.sha256 }, lod: { script: "adapters/blender/nature_lod.py", sha256: lodRecipe.sha256 }, blenderVersion: source.blenderVersion },
      release: CAVE_RELEASE, descriptor: descriptorAsset,
      sources: Object.fromEntries(Object.entries(CAVE_SOURCES).map(([name, sourceId]) => [name, { sourceId, license: "CC0-1.0", asset: scanAssets[name] }])),
    },
  };
}

if (import.meta.main) await runKitCli("scripts/build-limestone-caves.ts", CAVE_RELEASE, buildLimestoneCaves, { descriptorFile: true });
