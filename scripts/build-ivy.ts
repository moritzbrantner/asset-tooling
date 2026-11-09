// Build the ivy kit (docs/ivy.md, #552) from the scripted recipe adapters/blender/ivy.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-ivy.ts [--textures full|half] --out <directory>
// Each piece's level is one external.blender.script@1 run, imported through scene.import.gltf@2, all on one leaf atlas.
// <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and packed to
// <directory>/ivy.kit.tar. No game places the kit yet.
import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { Document } from "@gltf-transform/core";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec } from "../src/blender-script-spec.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { sha256Bytes } from "../src/hash.js";
import { buildKitPart, documentBounds, exportKitBundle, ktx2Assets, round, runKitCli, scaledLodDistances, triangles, type KitPart } from "../src/kit-bundle.js";

export const IVY_PIECES = ["wall-patch", "curtain", "ground-creeper", "pedestal-patch", "column-wrap", "corner-wrap", "runner"] as const;
export type IvyPiece = (typeof IVY_PIECES)[number];
export const IVY_VARIANTS = ["default", "lod1", "lod2"] as const;
export const IVY_KEY_PREFIX = "ivy.kit";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const IVY_RELEASE = "ivy";
export const IVY_TAR_NAME = "ivy.kit.tar";
export const IVY_LEAF_MATERIAL = "ivy-leaves";
export const IVY_STEM_MATERIAL = "ivy-stem";
export const IVY_DESCRIPTOR_SCHEMA = "ivy-descriptor-v1";
export const IVY_DESCRIPTOR_ATTACHMENT = "ivy-descriptor";
/** Full-detail triangle ceiling: the kit standard's guide for small props. */
export const IVY_TRIANGLE_BUDGET = 2000;
/** Where LOD0 and lod1 end for a piece up to 1 m across, in metres at the reference FOV; scaledLodDistances grows them for larger pieces. */
export const IVY_LOD_DISTANCES = [60, 180] as const;
const LOD_REFERENCE_FOV_Y = 60;

export const ivyKey = (piece: IvyPiece) => `${IVY_KEY_PREFIX}.${piece}`;

export function createIvySpec({ piece, level, scriptSha256, blenderVersion }: { piece: IvyPiece; level: number; scriptSha256: string; blenderVersion: string }) {
  return blenderScriptSpec({
    assetId: ivyKey(piece), inputs: { script: { path: "ivy.py", sha256: scriptSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, piece, level }, output: "ivy.glb",
  });
}

type Built = KitPart & { piece: IvyPiece; variant: (typeof IVY_VARIANTS)[number] };

export async function buildIvy({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("ivy.py");
  const built: Built[] = [];
  for (const piece of IVY_PIECES) {
    for (const [level, variant] of IVY_VARIANTS.entries()) {
      log(`generate ${piece} ${variant}`);
      built.push({ piece, variant, ...await buildKitPart(root, {
        workspace: path.join(root, "pieces", `${piece}.${variant}`), files: { "ivy.py": source.bytes },
        spec: createIvySpec({ piece, level, scriptSha256: source.sha256, blenderVersion: source.blenderVersion }),
      }) });
    }
  }
  const atlas = new Map<string, string>();
  for (const part of built) for (const texture of part.document.getRoot().listTextures()) {
    const sha = sha256Bytes(texture.getImage()!);
    const name = texture.getName();
    if ((atlas.get(name) ?? sha) !== sha) throw new Error(`${part.piece} ${part.variant}: texture '${name}' differs from the shared atlas`);
    atlas.set(name, sha);
  }

  log("measure the descriptor");
  const tan = Math.tan((LOD_REFERENCE_FOV_Y / 2) * Math.PI / 180);
  const assets = IVY_PIECES.map((piece) => {
    const levels = built.filter((part) => part.piece === piece);
    const { document, observations } = levels[0]!;
    const bounds = documentBounds(document);
    const radius = round(Math.hypot(...[0, 1, 2].map((k) => bounds.max[k]! - bounds.min[k]!)) / 2);
    const distances = scaledLodDistances(IVY_LOD_DISTANCES, bounds);
    return {
      key: ivyKey(piece), role: piece, attach: observations.attach, triangles: triangles(document), cards: observations.cards, bounds, collision: "none",
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
    schema: IVY_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", handedness: "right",
    placement: "`attach` says where a piece's origin goes. wall: on the wall's face at the bottom centre, leaves towards +Z. wall-top: at the top of the wall's front face; `fit.over` metres cross the top behind it. ground: at the patch's centre, with the vines starting at the -Z edge. column: on the column's axis at its foot, facing +Z, sized for `fit.radius`. corner: on the corner's foot; `fit.front` metres run across a +Z face and the rest back along a +X face. Scale and turn each placement to fit.",
    collision: "Walk-through foliage: every piece declares `collision: \"none\"`.",
    lodSelection: {
      metric: "projected-bounding-sphere-height-fraction", referenceFovYDegrees: LOD_REFERENCE_FOV_Y,
      rule: "Use the first level whose minScreenSize is at most the asset's projected bounding-sphere diameter divided by the viewport height (radius / (distance * tan(fovY / 2)), scaled by the instance scale). referenceMaxDistance is the distance in metres at which that level ends for an unscaled instance at referenceFovYDegrees.",
    },
    assets,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: IVY_DESCRIPTOR_ATTACHMENT, mediaType: "application/json" })).asset;

  log("encode the atlas as KTX2 (ktx create)");
  const delivered = await ktx2Assets(root, IVY_RELEASE, built.map((part) => part.asset));
  const selections = built.map((part, index) => ({ key: ivyKey(part.piece), variant: part.variant, ...(index === 0 ? { attachments: [{ name: IVY_DESCRIPTOR_ATTACHMENT }] } : {}) }));
  const packed = await exportKitBundle(root, {
    tarName: IVY_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(built.filter((part) => part.variant === "default").map((part) => [part.piece, part.document])) as Record<IvyPiece, Document>,
    lineage: { recipe: { script: "adapters/blender/ivy.py", sha256: source.sha256, blenderVersion: source.blenderVersion }, release: IVY_RELEASE, descriptor: descriptorAsset },
  };
}

if (import.meta.main) await runKitCli("scripts/build-ivy.ts", IVY_RELEASE, buildIvy, { descriptorFile: true });
