// Build the woodland-edge bush kit for mmorpg (docs/woodland-bushes.md, #532):
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-woodland-bushes.ts [--textures full|half] --out <directory>
// Each piece is one external.blender.script@1 run of adapters/blender/woodland_bushes.py, imported through
// scene.import.gltf@2 and placed on its footprint; adapters/blender/nature_lod.py then makes lod1 and lod2 from it in
// the same frame. Every texture ships as KTX2. <directory> becomes the object-store root; the bundle is exported to
// <directory>/bundle and packed to <directory>/woodland-bushes.kit.tar.
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec } from "../src/blender-script-spec.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { executeGltfPlaceOperation } from "../src/gltf-place-operations.js";
import { sha256Bytes } from "../src/hash.js";
import { buildKitPart, documentBounds, exportKitBundle, ktx2Assets, round, runKitCli, single, triangles } from "../src/kit-bundle.js";
import { NATURE_LOD_METRIC, NATURE_LOD_RECIPES, NATURE_LOD_REFERENCE_FOV_Y, NATURE_LOD_VARIANTS } from "./build-greyhaven-nature.ts";

export const WOODLAND_BUSH_KINDS = ["hazel", "holly", "bramble", "hawthorn", "juniper", "elder"] as const;
export const WOODLAND_BUSH_VARIANTS = [1, 2] as const;
export type WoodlandBushKind = (typeof WOODLAND_BUSH_KINDS)[number];
export const WOODLAND_BUSHES_KEY_PREFIX = "woodland-bushes.kit";
export const WOODLAND_BUSHES_DESCRIPTOR_SCHEMA = "woodland-bushes-descriptor-v1";
export const WOODLAND_BUSHES_DESCRIPTOR_ATTACHMENT = "woodland-bushes-descriptor";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const WOODLAND_BUSHES_RELEASE = "woodland-bushes";
export const WOODLAND_BUSHES_TAR_NAME = "woodland-bushes.kit.tar";
/** Triangles a piece may have at full detail: bushes are numerous, so they stay near the greyhaven-nature bushes. */
export const WOODLAND_BUSH_TRIANGLES = 780;
/** nature_lod.py arguments. lod1 thins harder than greyhaven-nature's bushes, so it is at most half of LOD0 despite the kept core. */
export const WOODLAND_BUSH_LODS = [{ ...NATURE_LOD_RECIPES.bush[0], keep: 0.33 }, { ...NATURE_LOD_RECIPES.bush[1], gain: 0.72 }] as const;
/**
 * Where LOD0 and lod1 end, in metres at the reference field of view. Fixed distances rather than screen sizes, so a small
 * bush doesn't drop to the plain hull sooner than a large one; at 180 m the hull is about 15 pixels tall at 1080p.
 */
export const WOODLAND_BUSH_LOD_DISTANCES = [60, 180] as const;

export const woodlandBushKey =(kind: WoodlandBushKind, variant: number) => `${WOODLAND_BUSHES_KEY_PREFIX}.${kind}-${variant}`;
export const WOODLAND_BUSH_PIECES = WOODLAND_BUSH_KINDS.flatMap((kind) => WOODLAND_BUSH_VARIANTS.map((variant) => ({ kind, variant, key: woodlandBushKey(kind, variant) })));

export function createWoodlandBushSpec({ kind, variant, scriptSha256, bushSha256, blenderVersion }: {
  kind: WoodlandBushKind; variant: number; scriptSha256: string; bushSha256: string; blenderVersion: string;
}) {
  return blenderScriptSpec({
    assetId: woodlandBushKey(kind, variant),
    inputs: { script: { path: "woodland_bushes.py", sha256: scriptSha256 }, bush: { path: "nature_bush.py", sha256: bushSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, kind, variant }, output: "bush.glb",
  });
}

export async function buildWoodlandBushes({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("woodland_bushes.py");
  const bush = await readBlenderRecipeSource("nature_bush.py");
  const lodRecipe = await readBlenderRecipeSource("nature_lod.py");
  const io = new NodeIO();
  const built = [];
  for (const { kind, variant, key } of WOODLAND_BUSH_PIECES) {
    log(`generate ${key}`);
    const part = await buildKitPart(root, {
      workspace: path.join(root, "bushes", `${kind}-${variant}`),
      files: { "woodland_bushes.py": source.bytes, "nature_bush.py": bush.bytes },
      spec: createWoodlandBushSpec({ kind, variant, scriptSha256: source.sha256, bushSha256: bush.sha256, blenderVersion: source.blenderVersion }),
    });
    const placed = single(await executeGltfPlaceOperation(root, { inputs: { source: part.asset }, parameters: { parentName: key, anchor: "footprint-base-center", policy: { allowedValidatorWarnings: [] } } }));
    const placedBytes = new Uint8Array(await resolveAssetObject(root, placed));
    const document = await io.readBinary(placedBytes);
    const lods = [];
    for (const [index, variantName] of NATURE_LOD_VARIANTS.entries()) {
      const level = await buildKitPart(root, {
        workspace: path.join(root, "lods", `${kind}-${variant}-${variantName}`),
        files: { "nature_lod.py": lodRecipe.bytes, "source.glb": placedBytes },
        spec: blenderScriptSpec({
          assetId: key, blenderVersion: lodRecipe.blenderVersion, output: `${variantName}.glb`, arguments: { schemaVersion: 1, ...WOODLAND_BUSH_LODS[index]! },
          inputs: { script: { path: "nature_lod.py", sha256: lodRecipe.sha256 }, source: { path: "source.glb", sha256: sha256Bytes(placedBytes) } },
        }),
      });
      lods.push({ variant: variantName, asset: level.asset, triangles: triangles(level.document), observations: level.observations });
    }
    built.push({ kind, variant, key, asset: placed, document, triangles: triangles(document), observations: part.observations, lods });
  }

  log("measure the descriptor");
  const tan = Math.tan((NATURE_LOD_REFERENCE_FOV_Y / 2) * Math.PI / 180);
  const assets = built.map((item) => {
    const bounds = documentBounds(item.document);
    const radius = Math.hypot(...[0, 1, 2].map((axis) => bounds.max[axis]! - bounds.min[axis]!)) / 2;
    const levels = [{ variant: "default", triangles: item.triangles }, ...item.lods.map(({ variant, triangles: count }) => ({ variant, triangles: count }))];
    return {
      key: item.key, kind: item.kind, shape: item.variant, bounds, collision: "none",
      footprint: { width: round(bounds.max[0] - bounds.min[0]), depth: round(bounds.max[2] - bounds.min[2]), height: round(bounds.max[1] - bounds.min[1]) },
      lods: {
        boundingSphere: { center: [0, 1, 2].map((axis) => round((bounds.min[axis]! + bounds.max[axis]!) / 2)), radius: round(radius) },
        levels: levels.map((level, index) => {
          const distance = WOODLAND_BUSH_LOD_DISTANCES[index];
          return { ...level, minScreenSize: distance ? Number((radius / (distance * tan)).toFixed(4)) : 0, referenceMaxDistance: distance ?? null };
        }),
      },
    };
  });
  const descriptor = {
    schema: WOODLAND_BUSHES_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", handedness: "right", origin: "footprint-base-center",
    collision: "Walk-through foliage: every piece declares `collision: \"none\"`. The consumer owns placement and any blocking volume.",
    lodSelection: {
      metric: NATURE_LOD_METRIC, referenceFovYDegrees: NATURE_LOD_REFERENCE_FOV_Y,
      rule: "Use the first level whose minScreenSize is at most the asset's projected bounding-sphere diameter divided by the viewport height "
        + "(radius / (distance * tan(fovY / 2)), scaled by the instance scale). referenceMaxDistance is the distance in metres at which that "
        + "level ends for an unscaled instance at referenceFovYDegrees.",
    },
    assets,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "woodland-bushes-descriptor", mediaType: "application/json" })).asset;

  log("encode every texture as KTX2 (ktx create)");
  const delivered = await ktx2Assets(root, WOODLAND_BUSHES_RELEASE, built.flatMap((item) => [item.asset, ...item.lods.map((lod) => lod.asset)]));
  const selections = built.flatMap((item, index) => [
    { key: item.key, variant: "default", ...(index === 0 ? { attachments: [{ name: WOODLAND_BUSHES_DESCRIPTOR_ATTACHMENT }] } : {}) },
    ...item.lods.map(({ variant }) => ({ key: item.key, variant })),
  ]);
  const packed = await exportKitBundle(root, {
    tarName: WOODLAND_BUSHES_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    lineage: {
      recipe: { script: "adapters/blender/woodland_bushes.py", sha256: source.sha256, bush: { script: "adapters/blender/nature_bush.py", sha256: bush.sha256 }, lod: { script: "adapters/blender/nature_lod.py", sha256: lodRecipe.sha256 }, blenderVersion: source.blenderVersion },
      release: WOODLAND_BUSHES_RELEASE, descriptor: descriptorAsset, observations: Object.fromEntries(built.map((item) => [item.key, item.observations])),
    },
  };
}

if (import.meta.main) {
  await runKitCli("scripts/build-woodland-bushes.ts", "woodland-bushes", buildWoodlandBushes, { descriptorFile: true });
}
