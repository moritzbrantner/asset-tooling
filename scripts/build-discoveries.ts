// Build the Greyhaven discoveries kit (docs/discoveries.md, #764) from the scripted recipe adapters/blender/discoveries.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-discoveries.ts [--textures full|half] --out <directory>
// Each piece's level is one external.blender.script@1 run, imported through scene.import.gltf@2, all on one atlas.
// <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and packed to
// <directory>/discoveries.kit.tar.
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { NodeIO, type Document } from "@gltf-transform/core";
import { KHRTextureBasisu } from "@gltf-transform/extensions";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec } from "../src/blender-script-spec.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { sha256Bytes } from "../src/hash.js";
import { buildKitPart, documentBounds, exportKitBundle, ktx2Assets, round, runKitCli, scaledLodDistances, triangles, type KitPart } from "../src/kit-bundle.js";
import type { AssetRef } from "../src/operations.js";
import { withLightingAttributes } from "./baked-rock-kit.ts";

export const DISCOVERY_PIECES = [
  "hunter-lean-to", "hunter-chest", "hunter-chest-open", "skinning-rack", "fire-ring", "hunter-clue",
  "lookout-platform", "lookout-ladder", "signal-brazier", "signal-brazier-lit", "lookout-banner", "weapon-rack",
  "fen-punt", "supply-crates", "supply-crates-open", "fen-marker",
] as const;
export type DiscoveryPiece = (typeof DISCOVERY_PIECES)[number];
export const DISCOVERY_SITES = ["wolfrun-hunter-cache", "greyfang-lookout", "eastwater-fen-cache"] as const;
/** The site each piece belongs to; a state's other half belongs to the same site. */
export const DISCOVERY_SITE_OF: Record<DiscoveryPiece, (typeof DISCOVERY_SITES)[number]> = {
  "hunter-lean-to": "wolfrun-hunter-cache", "hunter-chest": "wolfrun-hunter-cache", "hunter-chest-open": "wolfrun-hunter-cache",
  "skinning-rack": "wolfrun-hunter-cache", "fire-ring": "wolfrun-hunter-cache", "hunter-clue": "wolfrun-hunter-cache",
  "lookout-platform": "greyfang-lookout", "lookout-ladder": "greyfang-lookout", "signal-brazier": "greyfang-lookout",
  "signal-brazier-lit": "greyfang-lookout", "lookout-banner": "greyfang-lookout", "weapon-rack": "greyfang-lookout",
  "fen-punt": "eastwater-fen-cache", "supply-crates": "eastwater-fen-cache", "supply-crates-open": "eastwater-fen-cache",
  "fen-marker": "eastwater-fen-cache",
};
/** The environmental clue of each site: what tells a player from the game camera that something is there. */
export const DISCOVERY_CLUES: Record<(typeof DISCOVERY_SITES)[number], DiscoveryPiece> = {
  "wolfrun-hunter-cache": "hunter-clue", "greyfang-lookout": "lookout-banner", "eastwater-fen-cache": "fen-marker",
};
export const DISCOVERY_VARIANTS = ["default", "lod1", "lod2"] as const;
export const DISCOVERY_KEY_PREFIX = "discoveries.kit";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const DISCOVERY_RELEASE = "discoveries";
export const DISCOVERY_TAR_NAME = "discoveries.kit.tar";
export const DISCOVERY_MATERIAL = "discoveries";
export const DISCOVERY_DESCRIPTOR_SCHEMA = "discoveries-descriptor-v1";
export const DISCOVERY_DESCRIPTOR_ATTACHMENT = "discoveries-descriptor";
/** Full-detail triangle ceiling: the kit standard's guide for small props. */
export const DISCOVERY_TRIANGLE_BUDGET = 2000;
/** Where LOD0 and lod1 end for a piece up to 1 m across, in metres at the reference FOV; scaledLodDistances grows them for larger pieces. */
export const DISCOVERY_LOD_DISTANCES = [60, 180] as const;
const LOD_REFERENCE_FOV_Y = 60;
/** The recipe exports no tangents: withLightingAttributes adds them after the import. */
const VALIDATOR_WARNINGS = ["MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"];

export const discoveryKey = (piece: DiscoveryPiece) => `${DISCOVERY_KEY_PREFIX}.${piece}`;

export function createDiscoverySpec({ piece, level, scriptSha256, commonSha256, blenderVersion }: { piece: DiscoveryPiece; level: number; scriptSha256: string; commonSha256: string; blenderVersion: string }) {
  return blenderScriptSpec({
    assetId: discoveryKey(piece),
    inputs: { script: { path: "discoveries.py", sha256: scriptSha256 }, common: { path: "kit_common.py", sha256: commonSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, piece, level }, output: "discovery.glb",
  });
}

type Built = KitPart & { piece: DiscoveryPiece; variant: (typeof DISCOVERY_VARIANTS)[number] };

export async function buildDiscoveries({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("discoveries.py");
  const common = await readBlenderRecipeSource("kit_common.py");
  const built: Built[] = [];
  for (const piece of DISCOVERY_PIECES) {
    for (const [level, variant] of DISCOVERY_VARIANTS.entries()) {
      log(`generate ${piece} ${variant}`);
      built.push({ piece, variant, ...await buildKitPart(root, {
        workspace: path.join(root, "pieces", `${piece}.${variant}`), allowedValidatorWarnings: VALIDATOR_WARNINGS,
        files: { "discoveries.py": source.bytes, "kit_common.py": common.bytes },
        spec: createDiscoverySpec({ piece, level, scriptSha256: source.sha256, commonSha256: common.sha256, blenderVersion: source.blenderVersion }),
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
  const assets = DISCOVERY_PIECES.map((piece) => {
    const levels = built.filter((part) => part.piece === piece);
    const { document, observations } = levels[0]!;
    const bounds = documentBounds(document);
    const radius = round(Math.hypot(...[0, 1, 2].map((k) => bounds.max[k]! - bounds.min[k]!)) / 2);
    const distances = scaledLodDistances(DISCOVERY_LOD_DISTANCES, bounds);
    const proxies = observations.collisionProxies as unknown[] | undefined;
    const below = observations.draft !== undefined ? { draft: observations.draft } : bounds.min[1] < -0.05 ? { bury: round(-bounds.min[1]) } : {};
    return {
      key: discoveryKey(piece), role: piece, site: DISCOVERY_SITE_OF[piece], kind: proxies ? "structure" : "dressing",
      ...(observations.node ? { node: observations.node, state: observations.state } : {}),
      ...(DISCOVERY_CLUES[DISCOVERY_SITE_OF[piece]] === piece ? { clue: true } : {}),
      triangles: triangles(document), ...below, bounds,
      footprint: { width: round(bounds.max[0] - bounds.min[0]), depth: round(bounds.max[2] - bounds.min[2]), height: round(bounds.max[1]) },
      ...(proxies ? { collisionProxies: proxies } : { collision: observations.collision }),
      ...(observations.light ? { light: observations.light } : {}),
      lods: {
        boundingSphere: { center: [0, 1, 2].map((k) => round((bounds.min[k]! + bounds.max[k]!) / 2)), radius },
        levels: levels.map((level, index) => {
          const distance = distances[index];
          return { variant: level.variant, triangles: triangles(level.document), minScreenSize: distance ? round(Number((radius / (distance * tan)).toFixed(4))) : 0, referenceMaxDistance: distance ?? null };
        }),
      },
    };
  });
  const sites = built.find((part) => part.piece === DISCOVERY_PIECES[0] && part.variant === "default")!.observations.sites as Record<string, { piece: DiscoveryPiece; position: number[]; yaw: number }[]>;
  const descriptor = {
    schema: DISCOVERY_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right", origin: "footprint-base-center",
    placement: "Pieces with a `node` are one object's `state`s in the same frame (a chest closed and open, the brazier unlit and lit, the crates closed and open): swap the mesh in place. Structures (`kind: \"structure\"`) carry axis-aligned `collisionProxies` boxes in their frame (`walkable` on the lookout deck, `ladder` on the ladder); dressing declares `collision: \"none\"`. Posts and poles run `bury` metres below y = 0 for uneven ground; the punt's y = 0 is the water level and its hull runs `draft` metres under it. The lit brazier names a `light` (position in its frame, linear colour) for a consumer's point light. `clue: true` marks each site's environmental clue.",
    sites: Object.fromEntries(DISCOVERY_SITES.map((site) => [site, { clue: discoveryKey(DISCOVERY_CLUES[site]), items: sites[site]!.map((item) => ({ key: discoveryKey(item.piece), position: item.position, yaw: item.yaw })) }])),
    lodSelection: {
      metric: "projected-bounding-sphere-height-fraction", referenceFovYDegrees: LOD_REFERENCE_FOV_Y,
      rule: "Use the first level whose minScreenSize is at most the asset's projected bounding-sphere diameter divided by the viewport height (radius / (distance * tan(fovY / 2)), scaled by the instance scale). referenceMaxDistance is the distance in metres at which that level ends for an unscaled instance at referenceFovYDegrees.",
    },
    assets,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: DISCOVERY_DESCRIPTOR_ATTACHMENT, mediaType: "application/json" })).asset;

  log("encode the atlas as KTX2 (ktx create)");
  const delivered = await ktx2Assets(root, DISCOVERY_RELEASE, finished);
  const selections = built.map((part, index) => ({
    key: discoveryKey(part.piece), variant: part.variant,
    ...(index === 0 ? { attachments: [{ name: DISCOVERY_DESCRIPTOR_ATTACHMENT }] } : {}),
  }));
  const packed = await exportKitBundle(root, {
    tarName: DISCOVERY_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(built.filter((part) => part.variant === "default").map((part) => [part.piece, part.document])) as Record<DiscoveryPiece, Document>,
    lineage: {
      recipe: { script: "adapters/blender/discoveries.py", sha256: source.sha256, common: { script: "adapters/blender/kit_common.py", sha256: common.sha256 }, blenderVersion: source.blenderVersion },
      release: DISCOVERY_RELEASE, descriptor: descriptorAsset,
    },
  };
}

if (import.meta.main) await runKitCli("scripts/build-discoveries.ts", DISCOVERY_RELEASE, buildDiscoveries, { descriptorFile: true });
