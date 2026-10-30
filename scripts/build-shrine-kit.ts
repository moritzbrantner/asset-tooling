// Build the sunken shrine and cave kit bundle (#345, docs/shrine-kit.md) from the scripted Blender recipe
// adapters/blender/shrine.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-shrine-kit.ts --out <directory>
// Each module is one external.blender.script@1 run, imported through scene.import.gltf@2. The
// shrine-kit-descriptor-v1 attachment combines the recipe's observations (proxies, opening, relic, lights, tunnel, air pocket)
// with bounds measured on the imported GLBs. <directory> becomes the object-store root; the bundle is
// exported to <directory>/bundle and packed to <directory>/shrine.kit.tar (+ .sha256).
import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { Document } from "@gltf-transform/core";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec } from "../src/blender-recipe-run.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { buildKitPart, byKey, exportKitBundle, kitEntry, runKitCli, type KitPart } from "../src/kit-bundle.js";

export const SHRINE_PARTS = [
  "wall", "arch", "pillar", "pillar-broken", "floor", "altar", "cave-mouth", "cave-tunnel", "cave-end", "air-pocket",
  "fallen-blocks", "hanging-weed", "silt-drift", "shells",
] as const;
export type ShrinePart = (typeof SHRINE_PARTS)[number];
export const SHRINE_KEY_PREFIX = "shrine.kit";
export const SHRINE_VARIANT = "default";
export const SHRINE_DESCRIPTOR_SCHEMA = "shrine-kit-descriptor-v1";
export const SHRINE_DESCRIPTOR_ATTACHMENT = "shrine-descriptor";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const SHRINE_RELEASE = "shrine-kit";
export const SHRINE_TAR_NAME = "shrine.kit.tar";
export const SHRINE_GRID = { module: 4, wallHeight: 3, wallThickness: 0.6, floorTop: 0, caveWidth: 4, caveHeight: 3 } as const;
const CATEGORY: Record<ShrinePart, "structure" | "cave" | "prop"> = {
  wall: "structure", arch: "structure", pillar: "structure", "pillar-broken": "structure", floor: "structure", altar: "prop",
  "cave-mouth": "cave", "cave-tunnel": "cave", "cave-end": "cave", "air-pocket": "cave",
  "fallen-blocks": "prop", "hanging-weed": "prop", "silt-drift": "prop", shells: "prop",
};
/** Recipe observations copied into the descriptor when a module declares them. */
const EXTRAS = ["module", "opening", "relic", "lights", "tunnel", "airPocket", "anchor"] as const;

export const shrineKey = (part: ShrinePart) => `${SHRINE_KEY_PREFIX}.${part}`;

export function createShrineAssetSpec({ part, scriptSha256, commonSha256, blenderVersion }: { part: ShrinePart; scriptSha256: string; commonSha256: string; blenderVersion: string }) {
  return blenderScriptSpec({
    assetId: shrineKey(part), inputs: { script: { path: "shrine.py", sha256: scriptSha256 }, common: { path: "kit_common.py", sha256: commonSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, part }, output: "shrine.glb",
  });
}

export async function buildShrineKit({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("shrine.py");
  const common = await readBlenderRecipeSource("kit_common.py");
  const parts = {} as Record<ShrinePart, KitPart>;
  for (const part of SHRINE_PARTS) {
    log(`generate ${part} (external.blender.script@1 shrine recipe, scene.import.gltf@2)`);
    parts[part] = await buildKitPart(root, {
      workspace: path.join(root, "shrine", part), files: { "shrine.py": source.bytes, "kit_common.py": common.bytes },
      spec: createShrineAssetSpec({ part, scriptSha256: source.sha256, commonSha256: common.sha256, blenderVersion: source.blenderVersion }),
    });
  }

  log("measure the shrine-kit descriptor");
  const assets = SHRINE_PARTS.map((part) => kitEntry({
    key: shrineKey(part), role: part, fields: { category: CATEGORY[part], parentName: `shrine.${part}` }, extras: EXTRAS, ...parts[part],
  })).sort(byKey);
  const descriptor = {
    schema: SHRINE_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right", origin: "module-base-center",
    grid: SHRINE_GRID, assets,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "shrine-descriptor", mediaType: "application/json" })).asset;

  const selections = SHRINE_PARTS.map((part) => ({ key: shrineKey(part), variant: SHRINE_VARIANT, ...(part === "wall" ? { attachments: [{ name: SHRINE_DESCRIPTOR_ATTACHMENT }] } : {}) }));
  const packed = await exportKitBundle(root, {
    tarName: SHRINE_TAR_NAME, log,
    invocation: {
      parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections },
      inputs: { assets: SHRINE_PARTS.map((part) => parts[part].asset), attachments: [descriptorAsset] },
    },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(SHRINE_PARTS.map((part) => [part, parts[part].document])) as Record<ShrinePart, Document>,
    lineage: { recipe: { script: "adapters/blender/shrine.py", sha256: source.sha256, common: { script: "adapters/blender/kit_common.py", sha256: common.sha256 }, blenderVersion: source.blenderVersion }, release: SHRINE_RELEASE, parts: Object.fromEntries(SHRINE_PARTS.map((part) => [part, parts[part].asset])), descriptor: descriptorAsset },
  };
}

if (import.meta.main) await runKitCli("scripts/build-shrine-kit.ts", "shrine", buildShrineKit);
