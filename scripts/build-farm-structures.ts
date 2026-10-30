// Build the toy-like My Farm Farmhouse and Silo (#353, docs/farm-structures.md) from the scripted Blender
// recipe adapters/blender/farm_structures.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-farm-structures.ts --out <directory>
// Each structure is one external.blender.script@1 run, checked through scene.import.gltf@2. The GLBs are
// exported as the self-contained static-glb-png-v1 package My Farm already stages, packed to
// <directory>/farm-structures.tar (+ .sha256), next to the measured farm-structures-descriptor-v1
// (<directory>/farm-structures.descriptor.json), lineage.json and export.ref.json.
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { Document } from "@gltf-transform/core";
import { STATIC_ASSET_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { blenderScriptSpec } from "../src/blender-script-spec.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { buildKitPart, documentBounds, exportKitBundle, runKitCli, triangles, type KitPart } from "../src/kit-bundle.js";

export const FARM_STRUCTURES = ["farmhouse", "silo"] as const;
export type FarmStructure = (typeof FARM_STRUCTURES)[number];
export const FARM_STRUCTURE_VARIANT = "toy";
export const FARM_DESCRIPTOR_SCHEMA = "farm-structures-descriptor-v1";
export const FARM_DESCRIPTOR_FILE = "farm-structures.descriptor.json";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const FARM_RELEASE = "farm-structures";
export const FARM_TAR_NAME = "farm-structures.tar";
/** My Farm's gameplay footprints in tiles (1 m each); the visuals may exceed them by about 40 % (owner, my-farm#234). */
export const FARM_GAMEPLAY_FOOTPRINT: Record<FarmStructure, { width: number; depth: number }> = { farmhouse: { width: 2, depth: 2 }, silo: { width: 2, depth: 2 } };
export const FARM_MAX_VISUAL_SCALE = 1.4;

export const farmMeshKey = (part: FarmStructure) => `${part}.mesh`;

export function createFarmStructureAssetSpec({ part, scriptSha256, blenderVersion }: { part: FarmStructure; scriptSha256: string; blenderVersion: string }) {
  return blenderScriptSpec({
    assetId: `farm.${part}`, inputs: { script: { path: "farm_structures.py", sha256: scriptSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, part }, output: `${part}.glb`,
  });
}

export async function buildFarmStructures({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("farm_structures.py");
  const parts = {} as Record<FarmStructure, KitPart>;
  for (const part of FARM_STRUCTURES) {
    log(`generate ${part} (external.blender.script@1 farm-structures recipe, scene.import.gltf@2)`);
    parts[part] = await buildKitPart(root, {
      workspace: path.join(root, "farm", part), files: { "farm_structures.py": source.bytes }, use: "source",
      spec: createFarmStructureAssetSpec({ part, scriptSha256: source.sha256, blenderVersion: source.blenderVersion }),
    });
  }

  log("measure the farm-structures descriptor");
  const descriptor = {
    schema: FARM_DESCRIPTOR_SCHEMA, units: "metre", tile: 1, up: "+Y", facing: "+Z", handedness: "right", origin: "footprint-ground-center",
    maxVisualScale: FARM_MAX_VISUAL_SCALE,
    assets: FARM_STRUCTURES.map((part) => {
      const { document, observations } = parts[part];
      const bounds = documentBounds(document);
      return {
        key: farmMeshKey(part), variant: FARM_STRUCTURE_VARIANT, role: part, triangles: triangles(document),
        gameplayFootprint: FARM_GAMEPLAY_FOOTPRINT[part],
        visual: { width: +(bounds.max[0] - bounds.min[0]).toFixed(6), depth: +(bounds.max[2] - bounds.min[2]).toFixed(6), height: +(bounds.max[1] - bounds.min[1]).toFixed(6) },
        bounds, structure: observations.structure,
      };
    }),
  };
  const descriptorPath = path.join(root, FARM_DESCRIPTOR_FILE);
  await writeFile(descriptorPath, `${canonicalJson(descriptor)}\n`);

  const packed = await exportKitBundle(root, {
    tarName: FARM_TAR_NAME, log,
    invocation: {
      parameters: { profile: STATIC_ASSET_BUNDLE_PROFILE, assets: FARM_STRUCTURES.map((part) => ({ key: farmMeshKey(part), variant: FARM_STRUCTURE_VARIANT })) },
      inputs: { assets: FARM_STRUCTURES.map((part) => parts[part].asset) },
    },
  });
  return {
    ...packed, descriptor, descriptorPath,
    documents: Object.fromEntries(FARM_STRUCTURES.map((part) => [part, parts[part].document])) as Record<FarmStructure, Document>,
    lineage: { recipe: { script: "adapters/blender/farm_structures.py", sha256: source.sha256, blenderVersion: source.blenderVersion }, release: FARM_RELEASE, parts: Object.fromEntries(FARM_STRUCTURES.map((part) => [part, parts[part].asset])) },
  };
}

if (import.meta.main) await runKitCli("scripts/build-farm-structures.ts", "farm", buildFarmStructures, { summary: (result) => ({ descriptor: result.descriptorPath }) });
