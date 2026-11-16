// Greyhaven's farm animals (#659, docs/greyhaven-farm-animals.md), following the ambient animals' conventions:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-farm-animals.ts --out <directory>
// Each animal is one external.blender.script@1 run of adapters/blender/farm_animals.py: the cow, horse, donkey, pig
// and sheep over their hash-pinned CC0 Quaternius catalog payloads (imported offline from hydrated LFS storage), the
// goat and chicken authored by the recipe itself. Each GLB is checked through scene.import.gltf@2 and exported as a
// gltf-resources-v1 bundle packed to <directory>/greyhaven.farm-animals.tar, next to the measured
// greyhaven-farm-animals-descriptor-v1, lineage.json and export.ref.json.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { GLTF_RESOURCES_BUNDLE_ALLOWED_VALIDATOR_WARNINGS, GLTF_RESOURCES_BUNDLE_PROFILE, exportAssetBundle } from "../src/asset-bundle.js";
import { ASSET_BUNDLE_REF_FILE, readAssetBundleTar } from "../src/asset-bundle-pack.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { executeGltfProductionImportOperation } from "../src/gltf-production-operations.js";
import { generateAsset } from "../src/index.js";
import { parseAssetSpec } from "../src/schema.js";
import type { AssetOperationResult, AssetRef } from "../src/operations.js";

type Json = Record<string, any>;
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const FARM_RELEASE = "greyhaven-farm-animals";
export const FARM_TAR_NAME = "greyhaven.farm-animals.tar";
export const FARM_DESCRIPTOR_SCHEMA = "greyhaven-farm-animals-descriptor-v1";
export const FARM_DESCRIPTOR_ATTACHMENT = "farm-animals-descriptor";
export const FARM_DESCRIPTOR_FILE = "greyhaven.farm-animals.descriptor.json";
const UAA = { pack: "Quaternius Ultimate Animated Animals", file: "source.glb", sourceClips: { Idle: "Idle", Walk: "Walk", Eat: "Eating" } } as const;
const FARM = { pack: "Quaternius Farm Animals", file: "source.blend", sourceClips: { Idle: "Idle", Walk: "Walk" } } as const;
const AUTHORED = { pack: null, file: null, sourceClips: null } as const;
export const FARM_ANIMALS = [
  { animal: "cow", sourceId: "quaternius.ultimate-animated-animals-cow-glb", member: "Cow.glb", ...UAA },
  { animal: "horse", sourceId: "quaternius.ultimate-animated-animals-horse-glb", member: "Horse.glb", ...UAA },
  { animal: "donkey", sourceId: "quaternius.ultimate-animated-animals-donkey-glb", member: "Donkey.glb", ...UAA },
  { animal: "pig", sourceId: "quaternius.farm-animals-pig-blend", member: "Blends/Pig.blend", ...FARM },
  { animal: "sheep", sourceId: "quaternius.farm-animals-sheep-blend", member: "Blends/Sheep.blend", ...FARM },
  { animal: "goat", sourceId: null, member: null, ...AUTHORED },
  { animal: "chicken", sourceId: null, member: null, ...AUTHORED },
] as const;
export type FarmAnimal = (typeof FARM_ANIMALS)[number]["animal"];
/** Every animal has Idle and Walk; Eat (head down grazing) where the source has one, and on the authored animals. */
export const FARM_CLIPS: Record<FarmAnimal, readonly string[]> = Object.fromEntries(FARM_ANIMALS.map((entry) => [
  entry.animal, entry.sourceClips ? Object.keys(entry.sourceClips) : ["Idle", "Walk", "Eat"],
])) as Record<FarmAnimal, readonly string[]>;
export const farmKey = (animal: FarmAnimal) => `greyhaven.farm.${animal}`;
const POLICY = { allowedValidatorWarnings: [...GLTF_RESOURCES_BUNDLE_ALLOWED_VALIDATOR_WARNINGS] };

function single(result: AssetOperationResult): AssetRef {
  const output = result.outputs.output;
  if (!output || Array.isArray(output)) throw new Error("asset operation returned no single output");
  return output;
}

export function createFarmAnimalAssetSpec({ animal, file, sourceSha256, scriptSha256, blenderVersion }:
  { animal: FarmAnimal; file: string | null; sourceSha256: string | null; scriptSha256: string; blenderVersion: string }) {
  return parseAssetSpec({
    schemaVersion: 1, assetId: farmKey(animal), generator: { id: "external.blender.script", version: "1" }, randomness: { mode: "none" },
    inputs: { script: { path: "farm_animals.py", sha256: scriptSha256 }, ...(file && sourceSha256 ? { source: { path: file, sha256: sourceSha256 } } : {}) }, models: {},
    parameters: { blenderVersion, arguments: { schemaVersion: 1, animal } }, output: { path: `${animal}.glb` }, reproducibility: { expected: "exact" },
  });
}

export async function buildGreyhavenFarmAnimals({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const read = async (file: string) => JSON.parse(await readFile(path.join(ROOT, file), "utf8"));
  const [providers, sources, storage] = await Promise.all(["catalog/providers.json", "catalog/sources.json", "catalog/storage.json"].map(read));
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const recipe = await readBlenderRecipeSource("farm_animals.py");
  const io = new NodeIO();
  const built = [];
  for (const entry of FARM_ANIMALS) {
    log(`generate ${farmKey(entry.animal)} (external.blender.script@1 farm-animals recipe${entry.sourceId ? ` over ${entry.sourceId}` : ", authored"})`);
    const workspace = path.join(root, "animals", entry.animal);
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "farm_animals.py"), recipe.bytes);
    let source: AssetRef | null = null;
    if (entry.sourceId) {
      source = (await importAssetCatalogStorageSource({ catalog, storage, sourceId: entry.sourceId, storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
      await writeFile(path.join(workspace, entry.file!), await resolveAssetObject(root, source));
    }
    const specPath = path.join(workspace, "asset.json");
    const spec = createFarmAnimalAssetSpec({ animal: entry.animal, file: entry.file, sourceSha256: source?.sha256 ?? null, scriptSha256: recipe.sha256, blenderVersion: recipe.blenderVersion });
    await writeFile(specPath, `${canonicalJson(spec)}\n`);
    const generated = await generateAsset(specPath);
    const observations = (generated.receipt.observations as Json).script as Json;
    const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, `${entry.animal}.glb`)), kind: "mesh", mediaType: "model/gltf-binary" })).asset;
    const imported = single(await executeGltfProductionImportOperation(root, { inputs: { source: glb }, parameters: { policy: POLICY } }));
    const document = await io.readBinary(new Uint8Array(await resolveAssetObject(root, imported)));
    built.push({ entry, source, glb, imported, document, observations });
  }

  log("measure the farm-animals descriptor");
  const recipeRef = { script: "adapters/blender/farm_animals.py", sha256: recipe.sha256 };
  const descriptor = {
    schema: FARM_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right", origin: "footprint-ground-center",
    placement: "Non-interactive cosmetic farm animals. The consumer owns world placement, wandering, pens, collision and gameplay; none is implied here.",
    clips: { names: ["Idle", "Walk", "Eat"], required: ["Idle", "Walk"], rootMotion: "in-place", loop: true },
    assets: built.map(({ entry, source, observations, document }) => ({
      key: farmKey(entry.animal), variant: "default", animal: entry.animal,
      idleBounds: observations.idleBounds,
      size: Object.fromEntries((["width", "height", "depth"] as const).map((name, axis) => [name, +(observations.idleBounds.max[axis] - observations.idleBounds.min[axis]).toFixed(5)])),
      triangles: document.getRoot().listMeshes().reduce((sum, mesh) => sum + mesh.listPrimitives().reduce((n, p) => n + (p.getIndices()?.getCount() ?? 0) / 3, 0), 0),
      joints: observations.joints,
      clips: Object.fromEntries(document.getRoot().listAnimations().map((a) => [a.getName(), {
        seconds: +Math.max(...a.listSamplers().map((s) => s.getInput()!.getMax([])[0]!)).toFixed(5),
        source: entry.sourceClips ? (entry.sourceClips as Record<string, string>)[a.getName()] : "authored",
      }])),
      walkTravel: observations.walkTravel,
      provenance: source
        ? { pack: entry.pack, member: entry.member, catalogSource: entry.sourceId, license: "CC0-1.0", source, recipe: recipeRef }
        : { authored: "original scripted model, rig and clips", license: "original", recipe: recipeRef },
    })),
  };
  const descriptorBytes = Buffer.from(`${canonicalJson(descriptor)}\n`);
  await writeFile(path.join(root, FARM_DESCRIPTOR_FILE), descriptorBytes);
  const attachment = (await storeAssetObject(root, { bytes: descriptorBytes, kind: "descriptor", mediaType: "application/json", metadata: { schema: FARM_DESCRIPTOR_SCHEMA } })).asset;

  log("export gltf-resources-v1 bundle and pack the release tar");
  const bundleDir = path.join(root, "bundle");
  const exported = await exportAssetBundle(root, bundleDir, {
    parameters: {
      profile: GLTF_RESOURCES_BUNDLE_PROFILE,
      assets: built.map(({ entry }, index) => ({ key: farmKey(entry.animal), variant: "default", ...(index === 0 ? { attachments: [{ name: FARM_DESCRIPTOR_ATTACHMENT }] } : {}) })),
    },
    inputs: { assets: built.map(({ imported }) => imported), attachments: [attachment] },
  });
  const tar = path.join(root, FARM_TAR_NAME);
  const pack = Bun.spawnSync(["bun", path.join(ROOT, "scripts/pack-asset-bundle.ts"), bundleDir, tar], { stdout: "pipe", stderr: "pipe" });
  if (pack.exitCode !== 0) throw new Error(`bundle packing failed: ${pack.stderr.toString()}`);
  const packed = JSON.parse(pack.stdout.toString());
  const ref = readAssetBundleTar(await readFile(tar)).find((item) => item.path === ASSET_BUNDLE_REF_FILE);
  if (!ref) throw new Error("packed farm-animals bundle has no export ref");
  await writeFile(path.join(root, ASSET_BUNDLE_REF_FILE), ref.bytes);
  const lineage = {
    release: FARM_RELEASE, recipe: { ...recipeRef, blenderVersion: recipe.blenderVersion },
    animals: Object.fromEntries(built.map(({ entry, source, glb, imported, observations }) => [entry.animal, {
      key: farmKey(entry.animal), catalogSource: entry.sourceId, license: source ? "CC0-1.0" : "original", source, generated: glb, imported, observations,
    }])),
  };
  await writeFile(path.join(root, "lineage.json"), `${JSON.stringify(lineage, null, 2)}\n`);
  return {
    bundleDir, tar, tarSha256: packed.sha256 as string, tarByteLength: packed.byteLength as number, descriptor, manifest: exported.manifest,
    exportRef: JSON.parse(ref.bytes.toString("utf8")) as Json, lineage, glbs: Object.fromEntries(built.map(({ entry, glb }) => [entry.animal, glb])) as Record<FarmAnimal, AssetRef>,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") {
    console.error("Usage: ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-farm-animals.ts --out <directory>");
    process.exit(2);
  }
  try {
    const result = await buildGreyhavenFarmAnimals({ outDir: args[1]!, log: (line) => console.error(`[farm] ${line}`) });
    console.log(JSON.stringify({ tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength, exportRef: result.exportRef }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}
