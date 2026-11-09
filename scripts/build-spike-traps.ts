// Build the wooden spike trap kit (docs/spike-traps.md) from the scripted recipe adapters/blender/spike_traps.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-spike-traps.ts [--textures full|half] --out <directory>
// Each piece's level is one external.blender.script@1 run, imported through scene.import.gltf@2, all on one wood atlas.
// <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and packed to
// <directory>/spike-traps.kit.tar. No game places the kit yet.
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

export const SPIKE_PIECES = ["stake-cluster", "stake-row", "cheval", "pit-bed", "spike-board", "swing-log"] as const;
export type SpikePiece = (typeof SPIKE_PIECES)[number];
export const SPIKE_VARIANTS = ["default", "lod1", "lod2"] as const;
export const SPIKE_KEY_PREFIX = "spike-traps.kit";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const SPIKE_RELEASE = "spike-traps";
export const SPIKE_TAR_NAME = "spike-traps.kit.tar";
export const SPIKE_MATERIAL = "spike-wood";
export const SPIKE_DESCRIPTOR_SCHEMA = "spike-traps-descriptor-v1";
export const SPIKE_DESCRIPTOR_ATTACHMENT = "spike-traps-descriptor";
/** Full-detail triangle ceiling: the kit standard's guide for small props. */
export const SPIKE_TRIANGLE_BUDGET = 2000;
/** Where LOD0 and lod1 end for a piece up to 1 m across, in metres at the reference FOV; scaledLodDistances grows them for larger pieces. */
export const SPIKE_LOD_DISTANCES = [60, 180] as const;
const LOD_REFERENCE_FOV_Y = 60;
/** The recipe exports no tangents: withLightingAttributes adds them after the import. */
const VALIDATOR_WARNINGS = ["MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"];
/** Recipe observations copied into the descriptor when a piece declares them. */
const EXTRAS = ["module", "pivot"] as const;

export const spikeKey = (piece: SpikePiece) => `${SPIKE_KEY_PREFIX}.${piece}`;

export function createSpikeSpec({ piece, level, scriptSha256, commonSha256, blenderVersion }: { piece: SpikePiece; level: number; scriptSha256: string; commonSha256: string; blenderVersion: string }) {
  return blenderScriptSpec({
    assetId: spikeKey(piece),
    inputs: { script: { path: "spike_traps.py", sha256: scriptSha256 }, common: { path: "kit_common.py", sha256: commonSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, piece, level }, output: "spike.glb",
  });
}

type Built = KitPart & { piece: SpikePiece; variant: (typeof SPIKE_VARIANTS)[number] };

export async function buildSpikeTraps({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("spike_traps.py");
  const common = await readBlenderRecipeSource("kit_common.py");
  const built: Built[] = [];
  for (const piece of SPIKE_PIECES) {
    for (const [level, variant] of SPIKE_VARIANTS.entries()) {
      log(`generate ${piece} ${variant}`);
      built.push({ piece, variant, ...await buildKitPart(root, {
        workspace: path.join(root, "pieces", `${piece}.${variant}`), allowedValidatorWarnings: VALIDATOR_WARNINGS,
        files: { "spike_traps.py": source.bytes, "kit_common.py": common.bytes },
        spec: createSpikeSpec({ piece, level, scriptSha256: source.sha256, commonSha256: common.sha256, blenderVersion: source.blenderVersion }),
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
  const assets = SPIKE_PIECES.map((piece) => {
    const levels = built.filter((part) => part.piece === piece);
    const { document, observations } = levels[0]!;
    const bounds = documentBounds(document);
    const radius = round(Math.hypot(...[0, 1, 2].map((k) => bounds.max[k]! - bounds.min[k]!)) / 2);
    const distances = scaledLodDistances(SPIKE_LOD_DISTANCES, bounds);
    const entry: Record<string, unknown> = {
      key: spikeKey(piece), role: piece, triangles: triangles(document), bury: observations.bury, bounds,
      footprint: { width: round(bounds.max[0] - bounds.min[0]), depth: round(bounds.max[2] - bounds.min[2]), height: round(bounds.max[1]) },
      ...(observations.collisionProxies ? { collisionProxies: observations.collisionProxies } : { collision: observations.collision }),
      lods: {
        boundingSphere: { center: [0, 1, 2].map((k) => round((bounds.min[k]! + bounds.max[k]!) / 2)), radius },
        levels: levels.map((level, index) => {
          const distance = distances[index];
          return { variant: level.variant, triangles: triangles(level.document), minScreenSize: distance ? round(Number((radius / (distance * tan)).toFixed(4))) : 0, referenceMaxDistance: distance ?? null };
        }),
      },
    };
    for (const extra of EXTRAS) if (observations[extra] !== undefined) entry[extra] = observations[extra];
    return entry;
  });
  const descriptor = {
    schema: SPIKE_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right", origin: "footprint-base-center",
    placement: "Stake feet run `bury` metres below y = 0 for uneven ground. stake-row is a module along X, its spikes towards +Z. swing-log swings about the X axis through its pivot node, which is 3.6 m above its origin.",
    lodSelection: {
      metric: "projected-bounding-sphere-height-fraction", referenceFovYDegrees: LOD_REFERENCE_FOV_Y,
      rule: "Use the first level whose minScreenSize is at most the asset's projected bounding-sphere diameter divided by the viewport height (radius / (distance * tan(fovY / 2)), scaled by the instance scale). referenceMaxDistance is the distance in metres at which that level ends for an unscaled instance at referenceFovYDegrees.",
    },
    assets,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: SPIKE_DESCRIPTOR_ATTACHMENT, mediaType: "application/json" })).asset;

  log("encode the atlas as KTX2 (ktx create)");
  const delivered = await ktx2Assets(root, SPIKE_RELEASE, finished);
  const selections = built.map((part, index) => ({ key: spikeKey(part.piece), variant: part.variant, ...(index === 0 ? { attachments: [{ name: SPIKE_DESCRIPTOR_ATTACHMENT }] } : {}) }));
  const packed = await exportKitBundle(root, {
    tarName: SPIKE_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(built.filter((part) => part.variant === "default").map((part) => [part.piece, part.document])) as Record<SpikePiece, Document>,
    lineage: {
      recipe: { script: "adapters/blender/spike_traps.py", sha256: source.sha256, common: { script: "adapters/blender/kit_common.py", sha256: common.sha256 }, blenderVersion: source.blenderVersion },
      release: SPIKE_RELEASE, descriptor: descriptorAsset,
    },
  };
}

if (import.meta.main) await runKitCli("scripts/build-spike-traps.ts", SPIKE_RELEASE, buildSpikeTraps, { descriptorFile: true });
