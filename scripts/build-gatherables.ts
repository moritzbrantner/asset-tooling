// Build the Greyhaven gatherables kit (docs/gatherables.md, #762) from the scripted recipe adapters/blender/gatherables.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-gatherables.ts [--textures full|half] --out <directory>
// Each piece's level is one external.blender.script@1 run, imported through scene.import.gltf@2, all on one atlas. The items'
// level-0 runs also render their inventory icons, which ship as the gatherables-icons attachment. <directory> becomes the
// object-store root; the bundle is exported to <directory>/bundle and packed to <directory>/gatherables.kit.tar.
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

export const GATHERABLE_PIECES = ["ore-vein", "ore-vein-depleted", "iron-ore", "boar-hide", "boar-tusk"] as const;
export type GatherablePiece = (typeof GATHERABLE_PIECES)[number];
/** The pieces a player picks up, each with an inventory icon; the others are gathering nodes placed in the world. */
export const GATHERABLE_ITEMS = ["iron-ore", "boar-hide", "boar-tusk"] as const satisfies readonly GatherablePiece[];
export const GATHERABLE_VARIANTS = ["default", "lod1", "lod2"] as const;
export const GATHERABLE_KEY_PREFIX = "gatherables.kit";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const GATHERABLE_RELEASE = "gatherables";
export const GATHERABLE_TAR_NAME = "gatherables.kit.tar";
export const GATHERABLE_MATERIAL = "gatherables";
export const GATHERABLE_DESCRIPTOR_SCHEMA = "gatherables-descriptor-v1";
export const GATHERABLE_DESCRIPTOR_ATTACHMENT = "gatherables-descriptor";
export const GATHERABLE_ICONS_SCHEMA = "gatherables-icons-v1";
export const GATHERABLE_ICONS_ATTACHMENT = "gatherables-icons";
/** The recipe's icon edge, in pixels. */
export const GATHERABLE_ICON_EDGE = 256;
/** Full-detail triangle ceiling: the kit standard's guide for small props. */
export const GATHERABLE_TRIANGLE_BUDGET = 2000;
/** Where LOD0 and lod1 end for a piece up to 1 m across, in metres at the reference FOV; scaledLodDistances grows them for larger pieces. */
export const GATHERABLE_LOD_DISTANCES = [60, 180] as const;
const LOD_REFERENCE_FOV_Y = 60;
/** The recipe exports no tangents: withLightingAttributes adds them after the import. */
const VALIDATOR_WARNINGS = ["MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"];
/** The two states of a gathering node, by piece: a consumer swaps the mesh when the node is gathered and back when it refills. */
const NODE_STATES: Partial<Record<GatherablePiece, { node: string; state: "full" | "depleted" }>> = {
  "ore-vein": { node: "ore-vein", state: "full" }, "ore-vein-depleted": { node: "ore-vein", state: "depleted" },
};

export const gatherableKey = (piece: GatherablePiece) => `${GATHERABLE_KEY_PREFIX}.${piece}`;
const isItem = (piece: GatherablePiece) => (GATHERABLE_ITEMS as readonly string[]).includes(piece);

export function createGatherableSpec({ piece, level, scriptSha256, commonSha256, blenderVersion }: { piece: GatherablePiece; level: number; scriptSha256: string; commonSha256: string; blenderVersion: string }) {
  return blenderScriptSpec({
    assetId: gatherableKey(piece),
    inputs: { script: { path: "gatherables.py", sha256: scriptSha256 }, common: { path: "kit_common.py", sha256: commonSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, piece, level }, output: "gatherable.glb",
  });
}

type Built = KitPart & { piece: GatherablePiece; variant: (typeof GATHERABLE_VARIANTS)[number] };

export async function buildGatherables({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("gatherables.py");
  const common = await readBlenderRecipeSource("kit_common.py");
  const built: Built[] = [];
  for (const piece of GATHERABLE_PIECES) {
    for (const [level, variant] of GATHERABLE_VARIANTS.entries()) {
      log(`generate ${piece} ${variant}`);
      built.push({ piece, variant, ...await buildKitPart(root, {
        workspace: path.join(root, "pieces", `${piece}.${variant}`), allowedValidatorWarnings: VALIDATOR_WARNINGS,
        files: { "gatherables.py": source.bytes, "kit_common.py": common.bytes },
        spec: createGatherableSpec({ piece, level, scriptSha256: source.sha256, commonSha256: common.sha256, blenderVersion: source.blenderVersion }),
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
  const assets = GATHERABLE_PIECES.map((piece) => {
    const levels = built.filter((part) => part.piece === piece);
    const { document, observations } = levels[0]!;
    const bounds = documentBounds(document);
    const radius = round(Math.hypot(...[0, 1, 2].map((k) => bounds.max[k]! - bounds.min[k]!)) / 2);
    const distances = scaledLodDistances(GATHERABLE_LOD_DISTANCES, bounds);
    const node = NODE_STATES[piece];
    return {
      key: gatherableKey(piece), role: piece, kind: isItem(piece) ? "item" : "node",
      ...(node ? { node: node.node, state: node.state } : {}),
      ...(isItem(piece) ? { icon: piece } : {}),
      triangles: triangles(document), ...(observations.bury !== undefined ? { bury: observations.bury } : {}), bounds,
      footprint: { width: round(bounds.max[0] - bounds.min[0]), depth: round(bounds.max[2] - bounds.min[2]), height: round(bounds.max[1]) },
      ...(observations.collisionMesh ? { collisionMesh: observations.collisionMesh } : { collision: observations.collision }),
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
    schema: GATHERABLE_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right", origin: "footprint-base-center",
    placement: "Nodes (`kind: \"node\"`) are gathering spots: `ore-vein` and `ore-vein-depleted` are one node's two `state`s in the same frame, so swap the mesh in place when it is gathered and back when it refills. The outcrop's foot runs `bury` metres below y = 0 for uneven ground, and its `collisionMesh` is a closed convex triangle mesh. Items (`kind: \"item\"`) are drops that lie on the ground and have no collision; `icon` names their inventory icon in the gatherables-icons attachment.",
    lodSelection: {
      metric: "projected-bounding-sphere-height-fraction", referenceFovYDegrees: LOD_REFERENCE_FOV_Y,
      rule: "Use the first level whose minScreenSize is at most the asset's projected bounding-sphere diameter divided by the viewport height (radius / (distance * tan(fovY / 2)), scaled by the instance scale). referenceMaxDistance is the distance in metres at which that level ends for an unscaled instance at referenceFovYDegrees.",
    },
    assets,
  };
  const icons = {
    schema: GATHERABLE_ICONS_SCHEMA, edge: GATHERABLE_ICON_EDGE, mediaType: "image/png", background: "transparent",
    icons: Object.fromEntries(GATHERABLE_ITEMS.map((piece) => {
      const png = Buffer.from(String(built.find((part) => part.piece === piece && part.variant === "default")!.observations.icon), "base64");
      return [piece, { key: gatherableKey(piece), sha256: sha256Bytes(png), byteLength: png.byteLength, base64: png.toString("base64") }];
    })),
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: GATHERABLE_DESCRIPTOR_ATTACHMENT, mediaType: "application/json" })).asset;
  const iconsAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(icons)}\n`), kind: GATHERABLE_ICONS_ATTACHMENT, mediaType: "application/json" })).asset;

  log("encode the atlas as KTX2 (ktx create)");
  const delivered = await ktx2Assets(root, GATHERABLE_RELEASE, finished);
  const selections = built.map((part, index) => ({
    key: gatherableKey(part.piece), variant: part.variant,
    ...(index === 0 ? { attachments: [{ name: GATHERABLE_DESCRIPTOR_ATTACHMENT }, { name: GATHERABLE_ICONS_ATTACHMENT }] } : {}),
  }));
  const packed = await exportKitBundle(root, {
    tarName: GATHERABLE_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset, iconsAsset] } },
  });
  return {
    ...packed, descriptor, icons,
    documents: Object.fromEntries(built.filter((part) => part.variant === "default").map((part) => [part.piece, part.document])) as Record<GatherablePiece, Document>,
    lineage: {
      recipe: { script: "adapters/blender/gatherables.py", sha256: source.sha256, common: { script: "adapters/blender/kit_common.py", sha256: common.sha256 }, blenderVersion: source.blenderVersion },
      release: GATHERABLE_RELEASE, descriptor: descriptorAsset, icons: iconsAsset,
    },
  };
}

if (import.meta.main) await runKitCli("scripts/build-gatherables.ts", GATHERABLE_RELEASE, buildGatherables, { descriptorFile: true });
