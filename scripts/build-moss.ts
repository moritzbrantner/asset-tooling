// Build the moss kit (docs/moss.md, #554) from the scripted recipe adapters/blender/moss.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-moss.ts [--textures full|half] --out <directory>
// Each piece's level is one external.blender.script@1 run, imported through scene.import.gltf@2, all on one atlas.
// <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and packed to
// <directory>/moss.kit.tar. No game places the kit yet.
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO, type Document } from "@gltf-transform/core";
import { KHRTextureBasisu } from "@gltf-transform/extensions";
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
import { withLightingAttributes } from "./baked-rock-kit.ts";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const MOSS_PIECES = ["top-cap", "edge-drape", "foot-ring", "step-strip", "corner-strip", "ground-mat", "scatter"] as const;
export type MossPiece = (typeof MOSS_PIECES)[number];
export const MOSS_VARIANTS = ["default", "lod1", "lod2"] as const;
export const MOSS_KEY_PREFIX = "moss.kit";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const MOSS_RELEASE = "moss";
export const MOSS_TAR_NAME = "moss.kit.tar";
export const MOSS_MATERIAL = "moss";
export const MOSS_DESCRIPTOR_SCHEMA = "moss-descriptor-v1";
export const MOSS_DESCRIPTOR_ATTACHMENT = "moss-descriptor";
export const MOSS_SOURCE = "poly-haven.mossy-rock-diff-2k-jpg";
/** Full-detail triangle ceiling: the kit standard's guide for small props. */
export const MOSS_TRIANGLE_BUDGET = 2000;
/** Where LOD0 and lod1 end for a piece up to 1 m across, in metres at the reference FOV; scaledLodDistances grows them for larger pieces. */
export const MOSS_LOD_DISTANCES = [60, 180] as const;
const LOD_REFERENCE_FOV_Y = 60;
/** The recipe exports no tangents: withLightingAttributes adds them after the import. */
const VALIDATOR_WARNINGS = ["MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"];

export const mossKey = (piece: MossPiece) => `${MOSS_KEY_PREFIX}.${piece}`;

export function createMossSpec({ piece, level, scriptSha256, outcropSha256, scanSha256, blenderVersion }: { piece: MossPiece; level: number; scriptSha256: string; outcropSha256: string; scanSha256: string; blenderVersion: string }) {
  return blenderScriptSpec({
    assetId: mossKey(piece),
    inputs: { script: { path: "moss.py", sha256: scriptSha256 }, outcrop: { path: "cliff_outcrop.py", sha256: outcropSha256 }, mossColour: { path: "mossColour.jpg", sha256: scanSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, piece, level }, output: "moss.glb",
  });
}

type Built = KitPart & { piece: MossPiece; variant: (typeof MOSS_VARIANTS)[number] };

export async function buildMoss({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("moss.py");
  const outcrop = await readBlenderRecipeSource("cliff_outcrop.py");
  const sources = JSON.parse(await readFile(path.join(ROOT, "catalog/sources.json"), "utf8"));
  const providers = JSON.parse(await readFile(path.join(ROOT, "catalog/providers.json"), "utf8"));
  const storage = JSON.parse(await readFile(path.join(ROOT, "catalog/storage.json"), "utf8"));
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const scanAsset = (await importAssetCatalogStorageSource({ catalog, storage, sourceId: MOSS_SOURCE, storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
  const scan = new Uint8Array(await resolveAssetObject(root, scanAsset));
  const scanSha256 = sha256Bytes(scan);
  const built: Built[] = [];
  for (const piece of MOSS_PIECES) {
    for (const [level, variant] of MOSS_VARIANTS.entries()) {
      log(`generate ${piece} ${variant}`);
      built.push({ piece, variant, ...await buildKitPart(root, {
        workspace: path.join(root, "pieces", `${piece}.${variant}`), allowedValidatorWarnings: VALIDATOR_WARNINGS,
        files: { "moss.py": source.bytes, "cliff_outcrop.py": outcrop.bytes, "mossColour.jpg": scan },
        spec: createMossSpec({ piece, level, scriptSha256: source.sha256, outcropSha256: outcrop.sha256, scanSha256, blenderVersion: source.blenderVersion }),
      }) });
    }
  }

  log("add tangents and COLOR_0");
  const io = new NodeIO().registerExtensions([KHRTextureBasisu]);
  const finished: AssetRef[] = [];
  const atlas = new Map<string, string>();
  for (const part of built) {
    for (const texture of part.document.getRoot().listTextures()) {
      const sha = sha256Bytes(texture.getImage()!);
      const name = texture.getName();
      if ((atlas.get(name) ?? sha) !== sha) throw new Error(`${part.piece} ${part.variant}: texture '${name}' differs from the shared atlas`);
      atlas.set(name, sha);
    }
    await withLightingAttributes(part.document);
    finished.push((await storeAssetObject(root, { bytes: await io.writeBinary(part.document), kind: "scene", mediaType: "model/gltf-binary" })).asset);
  }

  log("measure the descriptor");
  const tan = Math.tan((LOD_REFERENCE_FOV_Y / 2) * Math.PI / 180);
  const assets = MOSS_PIECES.map((piece) => {
    const levels = built.filter((part) => part.piece === piece);
    const { document, observations } = levels[0]!;
    const bounds = documentBounds(document);
    const radius = round(Math.hypot(...[0, 1, 2].map((k) => bounds.max[k]! - bounds.min[k]!)) / 2);
    const distances = scaledLodDistances(MOSS_LOD_DISTANCES, bounds);
    return {
      key: mossKey(piece), role: piece, attach: observations.attach, triangles: triangles(document), bounds, collision: "none",
      footprint: { width: round(bounds.max[0] - bounds.min[0]), depth: round(bounds.max[2] - bounds.min[2]), height: round(bounds.max[1] - bounds.min[1]) },
      ...(observations.fit ? { fit: observations.fit } : {}),
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
    schema: MOSS_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", handedness: "right",
    placement: "`attach` says where a piece's origin goes. top and ground: at the patch's centre on the surface. foot: on the ground at the centre of a stone's foot, with the stone inside `fit.halfWidth` and `fit.halfDepth`. block-foot: on the step at the foot of a block's +Z face, spreading out along +Z. edge: on the front edge of a top surface, lying back along -Z for `fit.over` metres and folding down over the +Z face. Scale and turn each placement to fit.",
    collision: "Walk-on moss: every piece declares `collision: \"none\"`.",
    lodSelection: {
      metric: "projected-bounding-sphere-height-fraction", referenceFovYDegrees: LOD_REFERENCE_FOV_Y,
      rule: "Use the first level whose minScreenSize is at most the asset's projected bounding-sphere diameter divided by the viewport height (radius / (distance * tan(fovY / 2)), scaled by the instance scale). referenceMaxDistance is the distance in metres at which that level ends for an unscaled instance at referenceFovYDegrees.",
    },
    assets,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: MOSS_DESCRIPTOR_ATTACHMENT, mediaType: "application/json" })).asset;

  log("encode the atlas as KTX2 (ktx create)");
  const delivered = await ktx2Assets(root, MOSS_RELEASE, finished);
  const selections = built.map((part, index) => ({ key: mossKey(part.piece), variant: part.variant, ...(index === 0 ? { attachments: [{ name: MOSS_DESCRIPTOR_ATTACHMENT }] } : {}) }));
  const packed = await exportKitBundle(root, {
    tarName: MOSS_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(built.filter((part) => part.variant === "default").map((part) => [part.piece, part.document])) as Record<MossPiece, Document>,
    lineage: {
      recipe: { script: "adapters/blender/moss.py", sha256: source.sha256, outcrop: { script: "adapters/blender/cliff_outcrop.py", sha256: outcrop.sha256 }, blenderVersion: source.blenderVersion },
      release: MOSS_RELEASE, descriptor: descriptorAsset, sources: { mossColour: { sourceId: MOSS_SOURCE, license: "CC0-1.0", asset: scanAsset } },
    },
  };
}

if (import.meta.main) await runKitCli("scripts/build-moss.ts", MOSS_RELEASE, buildMoss, { descriptorFile: true });
