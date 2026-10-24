// Build the toy-like My Farm Farmhouse and Silo (#353, docs/farm-structures.md) from the scripted Blender
// recipe adapters/blender/farm_structures.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-farm-structures.ts --out <directory>
// Each structure is one external.blender.script@1 run, checked through scene.import.gltf@2. The GLBs are
// exported as the self-contained static-glb-png-v1 package My Farm already stages, packed to
// <directory>/farm-structures.tar (+ .sha256), next to the measured farm-structures-descriptor-v1
// (<directory>/farm-structures.descriptor.json), lineage.json and export.ref.json.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO, type Document } from "@gltf-transform/core";
import { STATIC_ASSET_BUNDLE_PROFILE, exportAssetBundle } from "../src/asset-bundle.js";
import { ASSET_BUNDLE_REF_FILE, readAssetBundleTar } from "../src/asset-bundle-pack.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { executeGltfProductionImportOperation } from "../src/gltf-production-operations.js";
import { generateAsset } from "../src/index.js";
import { parseAssetSpec } from "../src/schema.js";
import type { AssetOperationResult, AssetRef } from "../src/operations.js";
import { documentBounds } from "./build-shrine-kit.ts";

type Json = Record<string, any>;
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

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

function single(result: AssetOperationResult, port = "output"): AssetRef {
  const output = result.outputs[port];
  if (!output || Array.isArray(output)) throw new Error(`operation output '${port}' is missing`);
  return output;
}

export function createFarmStructureAssetSpec({ part, scriptSha256, blenderVersion }: { part: FarmStructure; scriptSha256: string; blenderVersion: string }) {
  return parseAssetSpec({
    schemaVersion: 1, assetId: `farm.${part}`, generator: { id: "external.blender.script", version: "1" }, randomness: { mode: "none" },
    inputs: { script: { path: "farm_structures.py", sha256: scriptSha256 } }, models: {},
    parameters: { blenderVersion, arguments: { schemaVersion: 1, part } }, output: { path: `${part}.glb` }, reproducibility: { expected: "exact" },
  });
}

function triangles(document: Document) {
  let count = 0;
  for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    count += (primitive.getIndices()?.getCount() ?? primitive.getAttribute("POSITION")!.getCount()) / 3;
  }
  return count;
}

export async function buildFarmStructures({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("farm_structures.py");
  const io = new NodeIO();
  const parts = {} as Record<FarmStructure, { asset: AssetRef; document: Document; observations: Json }>;
  for (const part of FARM_STRUCTURES) {
    log(`generate ${part} (external.blender.script@1 farm-structures recipe, scene.import.gltf@2)`);
    const workspace = path.join(root, "farm", part);
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "farm_structures.py"), source.bytes);
    const specPath = path.join(workspace, "asset.json");
    await writeFile(specPath, `${canonicalJson(createFarmStructureAssetSpec({ part, scriptSha256: source.sha256, blenderVersion: source.blenderVersion }))}\n`);
    const generated = await generateAsset(specPath);
    const observations = (generated.receipt.observations as Json).script as Json;
    const bytes = await readFile(path.join(workspace, `${part}.glb`));
    const glb = (await storeAssetObject(root, { bytes, kind: "mesh", mediaType: "model/gltf-binary" })).asset;
    // The import validates the GLB with no validator exceptions; the package ships the recipe's own GLB.
    single(await executeGltfProductionImportOperation(root, { inputs: { source: glb }, parameters: { policy: { allowedValidatorWarnings: [] } } }));
    parts[part] = { asset: glb, document: await io.readBinary(new Uint8Array(await resolveAssetObject(root, glb))), observations };
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

  log("export static-glb-png-v1 package (asset.bundle@1)");
  const bundleDir = path.join(root, "bundle");
  await exportAssetBundle(root, bundleDir, {
    parameters: { profile: STATIC_ASSET_BUNDLE_PROFILE, assets: FARM_STRUCTURES.map((part) => ({ key: farmMeshKey(part), variant: FARM_STRUCTURE_VARIANT })) },
    inputs: { assets: FARM_STRUCTURES.map((part) => parts[part].asset) },
  });
  const tarPath = path.join(root, FARM_TAR_NAME);
  log("pack release tar (scripts/pack-asset-bundle.ts)");
  const pack = Bun.spawnSync(["bun", path.join(REPOSITORY_ROOT, "scripts/pack-asset-bundle.ts"), bundleDir, tarPath], { stdout: "pipe", stderr: "pipe" });
  if (pack.exitCode !== 0) throw new Error(`pack-asset-bundle failed: ${pack.stderr.toString()}`);
  const packed = JSON.parse(pack.stdout.toString());
  const refEntry = readAssetBundleTar(await readFile(tarPath)).find((entry) => entry.path === ASSET_BUNDLE_REF_FILE);
  if (!refEntry) throw new Error(`packed tar has no ${ASSET_BUNDLE_REF_FILE}`);
  const exportRefPath = path.join(root, ASSET_BUNDLE_REF_FILE);
  await writeFile(exportRefPath, refEntry.bytes);
  return {
    bundleDir, tar: tarPath, tarSha256: packed.sha256 as string, tarByteLength: packed.byteLength as number, descriptor, descriptorPath,
    documents: Object.fromEntries(FARM_STRUCTURES.map((part) => [part, parts[part].document])) as Record<FarmStructure, Document>,
    exportRef: JSON.parse(Buffer.from(refEntry.bytes).toString("utf8")) as Json, exportRefPath,
    lineage: { recipe: { script: "adapters/blender/farm_structures.py", sha256: source.sha256, blenderVersion: source.blenderVersion }, release: FARM_RELEASE, parts: Object.fromEntries(FARM_STRUCTURES.map((part) => [part, parts[part].asset])) },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") {
    console.error("Usage: ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-farm-structures.ts --out <directory>");
    process.exit(2);
  }
  try {
    const result = await buildFarmStructures({ outDir: args[1]!, log: (line) => console.error(`[farm] ${line}`) });
    await writeFile(path.join(path.resolve(args[1]!), "lineage.json"), `${JSON.stringify(result.lineage, null, 2)}\n`);
    console.log(JSON.stringify({ bundle: result.bundleDir, tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength, descriptor: result.descriptorPath, exportRef: result.exportRef }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}
