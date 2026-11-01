// Build the climbing kit (#394, docs/climbing-kit.md) from the scripted Blender recipe adapters/blender/climbing.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-climbing-kit.ts --out <directory>
// Timber ladders, a knotted hanging rope and climbing ivy for mmorpg's climbable surfaces (mmorpg#490), sized to the
// Ranger's Ladder_*, Rope_* and Climb_* clips. Each part and level of detail is one external.blender.script@1 run,
// imported through scene.import.gltf@2. The ivy's leaf cards use the CC0 Quaternius T_VineLeaf cluster from the
// hydrated catalog. The climbing-kit-descriptor-v1 attachment carries each part's climb metadata (grip, grip line,
// rungs or knots, stand-off), its box collision proxies and its LOD chain in the greyhaven-nature #449 format.
// <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and packed to
// <directory>/climbing.kit.tar.
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Document } from "@gltf-transform/core";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec, type BlenderSpecInput } from "../src/blender-script-spec.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { sha256Bytes } from "../src/hash.js";
import { buildKitPart, documentBounds, exportKitBundle, round, runKitCli, triangles, type KitPart } from "../src/kit-bundle.js";
import type { AssetRef } from "../src/operations.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const CLIMBING_RELEASE = "climbing-kit";
export const CLIMBING_TAR_NAME = "climbing.kit.tar";
export const CLIMBING_KEY_PREFIX = "climbing.kit";
export const CLIMBING_DESCRIPTOR_SCHEMA = "climbing-kit-descriptor-v1";
export const CLIMBING_DESCRIPTOR_ATTACHMENT = "climbing-descriptor";
export const CLIMBING_PARTS = [
  "ladder-3m", "ladder-6m", "ladder-9m", "ladder-section", "ladder-top",
  "rope-4m", "rope-8m", "rope-12m", "rope-section", "rope-anchor", "rope-end",
  "vine-strip", "vine-top", "vine-3m", "vine-6m",
] as const;
export type ClimbingPart = (typeof CLIMBING_PARTS)[number];
export type ClimbingFamily = "ladder" | "rope" | "vine";
export const climbingFamily = (part: ClimbingPart): ClimbingFamily => part.split("-")[0] as ClimbingFamily;
export const climbingKey = (part: ClimbingPart) => `${CLIMBING_KEY_PREFIX}.${part}`;
/** The CC0 Quaternius ivy-leaf cluster the vine cards cut out (catalog source). */
export const CLIMBING_LEAVES = "quaternius.medieval-village-megakit-standard.t-vineleaf-png-png";
/** The rung pitch of every ladder part: the Ranger's Ladder_* rungSpacingMeters. */
export const CLIMBING_RUNG_SPACING = 0.3;

/** Levels of detail: LOD0 is variant `default`; `lod1` and `lod2` come from the same recipe in the same frame. */
export const CLIMBING_LOD_VARIANTS = ["lod1", "lod2"] as const;
export const CLIMBING_LOD_METRIC = "projected-bounding-sphere-height-fraction";
export const CLIMBING_LOD_REFERENCE_FOV_Y = 60;
/**
 * Where each level ends, in metres at the reference FOV, by family. A part's minScreenSize follows from its own
 * bounding sphere, so a 1.2 m ladder section and a 9 m ladder switch at the same distance.
 */
export const CLIMBING_LOD_DISTANCES: Record<ClimbingFamily, readonly [number, number]> = { ladder: [15, 45], rope: [12, 35], vine: [20, 60] };

export function createClimbingAssetSpec({ part, lod, scriptSha256, commonSha256, leavesSha256, blenderVersion }: {
  part: ClimbingPart; lod: 0 | 1 | 2; scriptSha256: string; commonSha256: string; leavesSha256: string; blenderVersion: string;
}) {
  return blenderScriptSpec({
    assetId: climbingKey(part),
    inputs: {
      script: { path: "climbing.py", sha256: scriptSha256 }, common: { path: "kit_common.py", sha256: commonSha256 },
      leaves: { path: "leaves.png", sha256: leavesSha256 },
    } satisfies Record<string, BlenderSpecInput>,
    blenderVersion, arguments: { schemaVersion: 1, part, lod }, output: "climbing.glb",
  });
}

type Built = KitPart & { part: ClimbingPart; variant: string };

export async function buildClimbingKit({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("climbing.py");
  const common = await readBlenderRecipeSource("kit_common.py");
  const sources = JSON.parse(await readFile(path.join(ROOT, "catalog/sources.json"), "utf8"));
  const providers = JSON.parse(await readFile(path.join(ROOT, "catalog/providers.json"), "utf8"));
  const storage = JSON.parse(await readFile(path.join(ROOT, "catalog/storage.json"), "utf8"));
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const leaves = (await importAssetCatalogStorageSource({ catalog, storage, sourceId: CLIMBING_LEAVES, storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
  const leavesBytes = new Uint8Array(await resolveAssetObject(root, leaves));
  const files = { "climbing.py": source.bytes, "kit_common.py": common.bytes, "leaves.png": leavesBytes };

  const built: Built[] = [];
  for (const part of CLIMBING_PARTS) {
    for (const [lod, variant] of [[0, "default"], [1, "lod1"], [2, "lod2"]] as const) {
      log(`generate ${part} ${variant} (external.blender.script@1 climbing recipe, scene.import.gltf@2)`);
      built.push({ part, variant, ...await buildKitPart(root, {
        workspace: path.join(root, "climbing", `${part}.${variant}`), files,
        spec: createClimbingAssetSpec({ part, lod, scriptSha256: source.sha256, commonSha256: common.sha256, leavesSha256: sha256Bytes(leavesBytes), blenderVersion: source.blenderVersion }),
      }) });
    }
  }

  log("measure the climbing-kit descriptor");
  const tan = Math.tan((CLIMBING_LOD_REFERENCE_FOV_Y / 2) * Math.PI / 180);
  const assets = CLIMBING_PARTS.map((part) => {
    const [main, ...lods] = built.filter((b) => b.part === part);
    const bounds = documentBounds(main!.document);
    const radius = round(Math.hypot(...[0, 1, 2].map((k) => bounds.max[k]! - bounds.min[k]!)) / 2);
    const distances = CLIMBING_LOD_DISTANCES[climbingFamily(part)];
    const o = main!.observations;
    return {
      key: climbingKey(part), role: part, family: climbingFamily(part), triangles: triangles(main!.document),
      footprint: o.footprint, bounds, collisionProxies: o.collisionProxies, climb: o.climb,
      lods: {
        boundingSphere: { center: [0, 1, 2].map((k) => round((bounds.min[k]! + bounds.max[k]! ) / 2)), radius },
        levels: [main!, ...lods].map((level, index) => {
          const distance = distances[index];
          return { variant: level.variant, triangles: triangles(level.document),
            minScreenSize: distance ? round(Number((radius / (distance * tan)).toFixed(4))) : 0, referenceMaxDistance: distance ?? null };
        }),
      },
    };
  });
  const descriptor = {
    schema: CLIMBING_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right", origin: "back-base-center",
    placement: "Each part's back (z = 0) lies on the face it climbs, its origin on the ground or joint at the centre of that back; "
      + "the climber faces it from +Z. Gameplay owns the collision: the parts are presentation over a StaticCollider, and "
      + "collisionProxies are boxes for consumers without one. Stack ladder-section (1.2 m) and ladder-top, rope-end, "
      + "rope-section (1.2 m) and rope-anchor, or vine-strip (2 m) and vine-top along +Y to fit any height; sink the lowest "
      + "piece into the ground to absorb a remainder. Each part carries empty nodes climb.bottom and climb.top at the ends of "
      + "climb.gripLine.",
    rungSpacing: CLIMBING_RUNG_SPACING,
    lodSelection: {
      metric: CLIMBING_LOD_METRIC,
      rule: "Use the first level whose minScreenSize is at most the part's projected bounding-sphere diameter divided by the "
        + "viewport height (radius / (distance * tan(fovY / 2)), scaled by the instance scale). referenceMaxDistance is the "
        + "distance in metres at which that level ends for an unscaled instance at referenceFovYDegrees.",
      referenceFovYDegrees: CLIMBING_LOD_REFERENCE_FOV_Y,
    },
    assets,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "climbing-descriptor", mediaType: "application/json" })).asset;
  const selections = built.map((b) => ({
    key: climbingKey(b.part), variant: b.variant,
    ...(b.part === CLIMBING_PARTS[0] && b.variant === "default" ? { attachments: [{ name: CLIMBING_DESCRIPTOR_ATTACHMENT }] } : {}),
  }));
  const packed = await exportKitBundle(root, {
    tarName: CLIMBING_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: built.map((b) => b.asset), attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(built.map((b) => [`${b.part}.${b.variant}`, b.document])) as Record<string, Document>,
    lineage: {
      recipe: { script: "adapters/blender/climbing.py", sha256: source.sha256, common: { script: "adapters/blender/kit_common.py", sha256: common.sha256 }, blenderVersion: source.blenderVersion },
      release: CLIMBING_RELEASE, leaves: { sourceId: CLIMBING_LEAVES, license: "CC0-1.0", asset: leaves },
      parts: Object.fromEntries(built.map((b) => [`${b.part}.${b.variant}`, b.asset])), descriptor: descriptorAsset,
    },
  };
}

if (import.meta.main) await runKitCli("scripts/build-climbing-kit.ts", "climbing", buildClimbingKit, { descriptorFile: true });
