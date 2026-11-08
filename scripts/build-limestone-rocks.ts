// Build the limestone rock kit for mmorpg's Greyhaven (docs/limestone-rocks.md, #536):
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-limestone-rocks.ts [--textures full|half] --out <directory>
// Each piece is one external.blender.script@1 run of adapters/blender/limestone_rocks.py, imported through
// scene.import.gltf@2; adapters/blender/nature_lod.py makes lod1 and lod2 from it in the same frame. A last run packs the
// baked maps into one atlas, every level moves onto it, and the textures ship as KTX2. <directory> becomes the
// object-store root; the bundle is exported to <directory>/bundle and packed to <directory>/limestone-rocks.kit.tar.
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
import { buildKitPart, documentBounds, exportKitBundle, ktx2Assets, round, runKitCli, triangles, type KitPart } from "../src/kit-bundle.js";
import type { AssetRef } from "../src/operations.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
/** In the order of the recipe's tables, which the atlas's numbered inputs follow. */
export const LIMESTONE_PARTS = ["outcrop-1", "outcrop-2", "ledge", "block-1", "block-2", "block-3", "scree-1", "scree-2"] as const;
export type LimestonePart = (typeof LIMESTONE_PARTS)[number];
export const LIMESTONE_KEY_PREFIX = "limestone-rocks.kit";
export const limestoneKey = (part: LimestonePart) => `${LIMESTONE_KEY_PREFIX}.${part}`;
export const LIMESTONE_MATERIAL = "limestone-rock";
export const LIMESTONE_DESCRIPTOR_SCHEMA = "limestone-rocks-descriptor-v1";
export const LIMESTONE_DESCRIPTOR_ATTACHMENT = "limestone-rocks-descriptor";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const LIMESTONE_RELEASE = "limestone-rocks";
export const LIMESTONE_TAR_NAME = "limestone-rocks.kit.tar";
/** The terrain's own scans, so the rock's foot and crown match the ground around it. */
export const LIMESTONE_SOURCES = {
  rockColour: "poly-haven.rock-face-03-diff-2k-jpg",
  rockHeight: "poly-haven.rock-face-03-disp-2k-jpg",
  grassColour: "poly-haven.forrest-ground-01-diff-2k-jpg",
  gravelColour: "poly-haven.rocks-ground-02-diff-2k-jpg",
  mossColour: "poly-haven.mossy-rock-diff-2k-jpg",
} as const;
export const LIMESTONE_LOD_VARIANTS = ["lod1", "lod2"] as const;
const LIMESTONE_LOD_RATIOS = [0.35, 0.1] as const;
const LIMESTONE_LOD_REFERENCE_FOV_Y = 60;
/** Where LOD0 and lod1 end, in metres at the reference FOV, for every piece. */
export const LIMESTONE_LOD_DISTANCES = [60, 180] as const;
/** The recipe exports no tangents: the normal map uses the generated tangent space, as the crag outcrops do. */
const VALIDATOR_WARNINGS = ["MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"];

export const limestoneKind = (part: LimestonePart) => part.split("-")[0] as "outcrop" | "ledge" | "block" | "scree";

export function createLimestoneSpec({ part, scriptSha256, outcropSha256, inputSha256, blenderVersion }: {
  part: LimestonePart; scriptSha256: string; outcropSha256: string; inputSha256: Record<keyof typeof LIMESTONE_SOURCES, string>; blenderVersion: string;
}) {
  const inputs: { script: BlenderSpecInput } & Record<string, BlenderSpecInput> = {
    script: { path: "limestone_rocks.py", sha256: scriptSha256 }, outcrop: { path: "cliff_outcrop.py", sha256: outcropSha256 },
  };
  for (const name of Object.keys(LIMESTONE_SOURCES) as (keyof typeof LIMESTONE_SOURCES)[]) inputs[name] = { path: `${name}.jpg`, sha256: inputSha256[name] };
  return blenderScriptSpec({ assetId: limestoneKey(part), inputs, blenderVersion, arguments: { schemaVersion: 1, part }, output: "rock.glb" });
}

export async function buildLimestoneRocks({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("limestone_rocks.py");
  const outcrop = await readBlenderRecipeSource("cliff_outcrop.py");
  const lodSource = await readBlenderRecipeSource("nature_lod.py");
  const sources = JSON.parse(await readFile(path.join(ROOT, "catalog/sources.json"), "utf8"));
  const providers = JSON.parse(await readFile(path.join(ROOT, "catalog/providers.json"), "utf8"));
  const storage = JSON.parse(await readFile(path.join(ROOT, "catalog/storage.json"), "utf8"));
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const files: Record<string, Uint8Array> = { "limestone_rocks.py": source.bytes, "cliff_outcrop.py": outcrop.bytes };
  const inputSha256 = {} as Record<keyof typeof LIMESTONE_SOURCES, string>;
  const inputAssets = {} as Record<keyof typeof LIMESTONE_SOURCES, AssetRef>;
  for (const name of Object.keys(LIMESTONE_SOURCES) as (keyof typeof LIMESTONE_SOURCES)[]) {
    const asset = (await importAssetCatalogStorageSource({ catalog, storage, sourceId: LIMESTONE_SOURCES[name], storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
    const bytes = new Uint8Array(await resolveAssetObject(root, asset));
    files[`${name}.jpg`] = bytes;
    inputSha256[name] = sha256Bytes(bytes);
    inputAssets[name] = asset;
  }

  const pieces: (KitPart & { part: LimestonePart; variant: string })[] = [];
  for (const part of LIMESTONE_PARTS) {
    log(`generate ${part}`);
    const main = await buildKitPart(root, {
      workspace: path.join(root, "limestone", `${part}.default`), files, allowedValidatorWarnings: VALIDATOR_WARNINGS,
      spec: createLimestoneSpec({ part, scriptSha256: source.sha256, outcropSha256: outcrop.sha256, inputSha256, blenderVersion: source.blenderVersion }),
    });
    pieces.push({ ...main, part, variant: "default" });
    const sourceBytes = new Uint8Array(await resolveAssetObject(root, main.asset));
    for (const [index, variant] of LIMESTONE_LOD_VARIANTS.entries()) {
      const level = await buildKitPart(root, {
        workspace: path.join(root, "limestone", `${part}.${variant}`), files: { "nature_lod.py": lodSource.bytes, "source.glb": sourceBytes }, allowedValidatorWarnings: VALIDATOR_WARNINGS,
        spec: blenderScriptSpec({
          assetId: limestoneKey(part), inputs: { script: { path: "nature_lod.py", sha256: lodSource.sha256 }, source: { path: "source.glb", sha256: sha256Bytes(sourceBytes) } },
          blenderVersion: lodSource.blenderVersion, arguments: { schemaVersion: 1, method: "decimate", ratio: LIMESTONE_LOD_RATIOS[index]! }, output: `${variant}.glb`,
        }),
      });
      pieces.push({ ...level, part, variant });
    }
  }

  log("pack the baked maps into one atlas");
  const atlasFiles: Record<string, Uint8Array> = { "limestone_rocks.py": source.bytes, "cliff_outcrop.py": outcrop.bytes };
  const atlasInputs: { script: BlenderSpecInput } & Record<string, BlenderSpecInput> = {
    script: { path: "limestone_rocks.py", sha256: source.sha256 }, outcrop: { path: "cliff_outcrop.py", sha256: outcrop.sha256 },
  };
  LIMESTONE_PARTS.forEach((part, index) => {
    const material = pieces.find((piece) => piece.part === part && piece.variant === "default")!.document.getRoot().listMaterials()[0]!;
    for (const [kind, texture] of [["colour", material.getBaseColorTexture()], ["normal", material.getNormalTexture()], ["rough", material.getMetallicRoughnessTexture()]] as const) {
      const bytes = texture!.getImage()!;
      atlasFiles[`${kind}${index}.png`] = bytes;
      atlasInputs[`${kind}${index}`] = { path: `${kind}${index}.png`, sha256: sha256Bytes(bytes) };
    }
  });
  const atlas = await buildKitPart(root, {
    workspace: path.join(root, "limestone", "atlas"), files: atlasFiles, allowedValidatorWarnings: VALIDATOR_WARNINGS,
    spec: blenderScriptSpec({ assetId: `${LIMESTONE_KEY_PREFIX}.atlas`, inputs: atlasInputs, blenderVersion: source.blenderVersion, arguments: { schemaVersion: 1, part: "atlas" }, output: "atlas.glb" }),
  });
  const atlasMaterial = atlas.document.getRoot().listMaterials()[0]!;
  const { edge: atlasEdge, rects } = atlas.observations as { edge: number; rects: Record<LimestonePart, { x: number; y: number; edge: number }> };
  const io = new NodeIO().registerExtensions([KHRTextureBasisu]);
  const atlased: AssetRef[] = [];
  for (const piece of pieces) {
    // Every level moves onto its piece's rectangle of the shared maps and takes the one material name.
    const rect = rects[piece.part];
    const point = [0, 0];
    for (const mesh of piece.document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
      const uv = primitive.getAttribute("TEXCOORD_0")!;
      for (let i = 0; i < uv.getCount(); i += 1) {
        uv.getElement(i, point);
        uv.setElement(i, [(rect.x + point[0]! * rect.edge) / atlasEdge, (rect.y + point[1]! * rect.edge) / atlasEdge]);
      }
    }
    for (const material of piece.document.getRoot().listMaterials()) {
      material.setName(LIMESTONE_MATERIAL);
      material.getBaseColorTexture()!.setImage(atlasMaterial.getBaseColorTexture()!.getImage()!);
      material.getNormalTexture()!.setImage(atlasMaterial.getNormalTexture()!.getImage()!);
      material.getMetallicRoughnessTexture()!.setImage(atlasMaterial.getMetallicRoughnessTexture()!.getImage()!);
    }
    atlased.push((await storeAssetObject(root, { bytes: await io.writeBinary(piece.document), kind: "scene", mediaType: "model/gltf-binary" })).asset);
  }

  log("measure the descriptor");
  const tan = Math.tan((LIMESTONE_LOD_REFERENCE_FOV_Y / 2) * Math.PI / 180);
  const assets = LIMESTONE_PARTS.map((part) => {
    const levels = pieces.filter((piece) => piece.part === part);
    const bounds = documentBounds(levels[0]!.document);
    const radius = round(Math.hypot(...[0, 1, 2].map((k) => bounds.max[k]! - bounds.min[k]!)) / 2);
    const { fit, bury, collisionMesh } = levels[0]!.observations;
    return {
      key: limestoneKey(part), role: part, kind: limestoneKind(part), triangles: triangles(levels[0]!.document), bounds, fit, bury,
      footprint: { width: round(bounds.max[0] - bounds.min[0]), depth: round(bounds.max[2] - bounds.min[2]), height: round(bounds.max[1]) },
      ...(collisionMesh ? { collisionMesh } : { collision: "none" }),
      lods: {
        boundingSphere: { center: [0, 1, 2].map((k) => round((bounds.min[k]! + bounds.max[k]!) / 2)), radius },
        levels: levels.map((level, index) => {
          const distance = LIMESTONE_LOD_DISTANCES[index];
          return { variant: level.variant, triangles: triangles(level.document), minScreenSize: distance ? round(Number((radius / (distance * tan)).toFixed(4))) : 0, referenceMaxDistance: distance ?? null };
        }),
      },
    };
  });
  const descriptor = {
    schema: LIMESTONE_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", handedness: "right", origin: "footprint-base-center",
    placement: "Each rock's foot runs `bury` metres below y = 0 so it meets uneven ground. Scree lies loose on any terrain and declares `collision: \"none\"`; every other piece carries `collisionMesh`, a closed outward-wound triangle mesh that leaves the soft apron out.",
    lodSelection: {
      metric: "projected-bounding-sphere-height-fraction", referenceFovYDegrees: LIMESTONE_LOD_REFERENCE_FOV_Y,
      rule: "Use the first level whose minScreenSize is at most the asset's projected bounding-sphere diameter divided by the viewport height (radius / (distance * tan(fovY / 2)), scaled by the instance scale). referenceMaxDistance is the distance in metres at which that level ends for an unscaled instance at referenceFovYDegrees.",
    },
    assets,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "limestone-rocks-descriptor", mediaType: "application/json" })).asset;

  log("encode every texture as KTX2 (ktx create)");
  const delivered = await ktx2Assets(root, LIMESTONE_RELEASE, atlased);
  const selections = pieces.map((piece, index) => ({ key: limestoneKey(piece.part), variant: piece.variant, ...(index === 0 ? { attachments: [{ name: LIMESTONE_DESCRIPTOR_ATTACHMENT }] } : {}) }));
  const packed = await exportKitBundle(root, {
    tarName: LIMESTONE_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(pieces.filter((piece) => piece.variant === "default").map((piece) => [piece.part, piece.document])) as Record<LimestonePart, Document>,
    lineage: {
      recipe: { script: "adapters/blender/limestone_rocks.py", sha256: source.sha256, outcrop: { script: "adapters/blender/cliff_outcrop.py", sha256: outcrop.sha256 }, lod: { script: "adapters/blender/nature_lod.py", sha256: lodSource.sha256 }, blenderVersion: source.blenderVersion },
      release: LIMESTONE_RELEASE, descriptor: descriptorAsset,
      sources: Object.fromEntries((Object.keys(LIMESTONE_SOURCES) as (keyof typeof LIMESTONE_SOURCES)[]).map((name) => [name, { sourceId: LIMESTONE_SOURCES[name], license: "CC0-1.0", asset: inputAssets[name] }])),
    },
  };
}

if (import.meta.main) {
  await runKitCli("scripts/build-limestone-rocks.ts", "limestone-rocks", buildLimestoneRocks, { descriptorFile: true });
}
