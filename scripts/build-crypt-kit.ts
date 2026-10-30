// Build the undead crypt environment kit bundle (#269, docs/crypt-kit.md) from the scripted Blender recipe
// adapters/blender/crypt.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-crypt-kit.ts --out <directory>
// Each module is one external.blender.script@1 run, imported through scene.import.gltf@2. The
// crypt-kit-descriptor-v1 attachment combines the recipe's observations (proxies, doorway, hinge, lights)
// with bounds measured on the imported GLBs. <directory> becomes the object-store root; the bundle is
// exported to <directory>/bundle and packed to <directory>/crypt.kit.tar (+ .sha256).
import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { Document } from "@gltf-transform/core";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec } from "../src/blender-script-spec.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { buildKitPart, byKey, exportKitBundle, kitEntry, runKitCli, type KitPart } from "../src/kit-bundle.js";

export const CRYPT_PARTS = ["wall", "doorway-narrow", "doorway-wide", "door", "floor", "pillar", "sarcophagus", "candles", "bones"] as const;
export type CryptPart = (typeof CRYPT_PARTS)[number];
export const CRYPT_KEY_PREFIX = "crypt.kit";
export const CRYPT_VARIANT = "default";
export const CRYPT_DESCRIPTOR_SCHEMA = "crypt-kit-descriptor-v1";
export const CRYPT_DESCRIPTOR_ATTACHMENT = "crypt-descriptor";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const CRYPT_RELEASE = "crypt-kit";
export const CRYPT_TAR_NAME = "crypt.kit.tar";
export const CRYPT_GRID = { module: 2, wallHeight: 3, wallThickness: 0.5, floorTop: 0 } as const;
const CATEGORY: Record<CryptPart, "structure" | "prop"> = {
  wall: "structure", "doorway-narrow": "structure", "doorway-wide": "structure", door: "structure", floor: "structure",
  pillar: "structure", sarcophagus: "prop", candles: "prop", bones: "prop",
};
/** Recipe observations copied into the descriptor when a module declares them. */
const EXTRAS = ["module", "doorway", "hinge", "mount", "lights", "lid"] as const;

export const cryptKey = (part: CryptPart) => `${CRYPT_KEY_PREFIX}.${part}`;

export function createCryptAssetSpec({ part, scriptSha256, commonSha256, blenderVersion }: { part: CryptPart; scriptSha256: string; commonSha256: string; blenderVersion: string }) {
  return blenderScriptSpec({
    assetId: cryptKey(part), inputs: { script: { path: "crypt.py", sha256: scriptSha256 }, common: { path: "kit_common.py", sha256: commonSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, part }, output: "crypt.glb",
  });
}

export async function buildCryptKit({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("crypt.py");
  const common = await readBlenderRecipeSource("kit_common.py");
  const parts = {} as Record<CryptPart, KitPart>;
  for (const part of CRYPT_PARTS) {
    log(`generate ${part} (external.blender.script@1 crypt recipe, scene.import.gltf@2)`);
    parts[part] = await buildKitPart(root, {
      workspace: path.join(root, "crypt", part), files: { "crypt.py": source.bytes, "kit_common.py": common.bytes },
      spec: createCryptAssetSpec({ part, scriptSha256: source.sha256, commonSha256: common.sha256, blenderVersion: source.blenderVersion }),
    });
  }

  log("measure the crypt-kit descriptor");
  const assets = CRYPT_PARTS.map((part) => kitEntry({
    key: cryptKey(part), role: part, fields: { category: CATEGORY[part], parentName: `crypt.${part}` }, extras: EXTRAS, ...parts[part],
  })).sort(byKey);
  const descriptor = {
    schema: CRYPT_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right", origin: "module-base-center",
    grid: CRYPT_GRID, assets,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "crypt-descriptor", mediaType: "application/json" })).asset;

  const selections = CRYPT_PARTS.map((part) => ({ key: cryptKey(part), variant: CRYPT_VARIANT, ...(part === "wall" ? { attachments: [{ name: CRYPT_DESCRIPTOR_ATTACHMENT }] } : {}) }));
  const packed = await exportKitBundle(root, {
    tarName: CRYPT_TAR_NAME, log,
    invocation: {
      parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections },
      inputs: { assets: CRYPT_PARTS.map((part) => parts[part].asset), attachments: [descriptorAsset] },
    },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(CRYPT_PARTS.map((part) => [part, parts[part].document])) as Record<CryptPart, Document>,
    lineage: { recipe: { script: "adapters/blender/crypt.py", sha256: source.sha256, common: { script: "adapters/blender/kit_common.py", sha256: common.sha256 }, blenderVersion: source.blenderVersion }, release: CRYPT_RELEASE, parts: Object.fromEntries(CRYPT_PARTS.map((part) => [part, parts[part].asset])), descriptor: descriptorAsset },
  };
}

if (import.meta.main) await runKitCli("scripts/build-crypt-kit.ts", "crypt", buildCryptKit);
