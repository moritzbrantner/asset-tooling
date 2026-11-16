// Greyhaven's wildlife (#667, docs/greyhaven-wildlife.md), following the farm animals' conventions:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-wildlife.ts --out <directory>
// Each animal is one external.blender.script@1 run of adapters/blender/wildlife.py, with the farm-animals recipe
// (adapters/blender/farm_animals.py) as its declared Python input `farm`: the stag, doe and fox over their hash-pinned
// CC0 Quaternius catalog payloads (imported offline from hydrated LFS storage), the rabbit, boar and four birds
// authored by the recipe itself. Each GLB is checked through scene.import.gltf@2 and exported as a gltf-resources-v1
// bundle packed to <directory>/greyhaven.wildlife.tar, next to the measured greyhaven-wildlife-descriptor-v1,
// lineage.json and export.ref.json.
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
export const WILD_RELEASE = "greyhaven-wildlife";
export const WILD_TAR_NAME = "greyhaven.wildlife.tar";
export const WILD_DESCRIPTOR_SCHEMA = "greyhaven-wildlife-descriptor-v1";
export const WILD_DESCRIPTOR_ATTACHMENT = "wildlife-descriptor";
export const WILD_DESCRIPTOR_FILE = "greyhaven.wildlife.descriptor.json";
const UAA = { pack: "Quaternius Ultimate Animated Animals", file: "source.glb", sourceClips: { Idle: "Idle", Walk: "Walk", Eat: "Eating" } } as const;
const AUTHORED = { pack: null, file: null, sourceClips: null } as const;
export const WILD_ANIMALS = [
  { animal: "stag", sourceId: "quaternius.ultimate-animated-animals-stag-glb", member: "Stag.glb", bird: false, ...UAA },
  { animal: "doe", sourceId: "quaternius.ultimate-animated-animals-deer-glb", member: "Deer.glb", bird: false, ...UAA },
  { animal: "fox", sourceId: "quaternius.ultimate-animated-animals-fox-glb", member: "Fox.glb", bird: false, ...UAA },
  { animal: "rabbit", sourceId: null, member: null, bird: false, ...AUTHORED },
  { animal: "boar", sourceId: null, member: null, bird: false, ...AUTHORED },
  { animal: "crow", sourceId: null, member: null, bird: true, ...AUTHORED },
  { animal: "duck", sourceId: null, member: null, bird: true, ...AUTHORED },
  { animal: "heron", sourceId: null, member: null, bird: true, ...AUTHORED },
  { animal: "songbird", sourceId: null, member: null, bird: true, ...AUTHORED },
] as const;
export type WildAnimal = (typeof WILD_ANIMALS)[number]["animal"];
/** Every animal has Idle, Walk and Eat (grazing, rooting, pecking); the birds also a looping wingbeat, Fly. */
export const WILD_CLIPS: Record<WildAnimal, readonly string[]> = Object.fromEntries(WILD_ANIMALS.map((entry) => [
  entry.animal, entry.bird ? ["Idle", "Walk", "Eat", "Fly"] : ["Idle", "Walk", "Eat"],
])) as Record<WildAnimal, readonly string[]>;
export const wildKey = (animal: WildAnimal) => `greyhaven.wild.${animal}`;
const POLICY = { allowedValidatorWarnings: [...GLTF_RESOURCES_BUNDLE_ALLOWED_VALIDATOR_WARNINGS] };

function single(result: AssetOperationResult): AssetRef {
  const output = result.outputs.output;
  if (!output || Array.isArray(output)) throw new Error("asset operation returned no single output");
  return output;
}

export function createWildAnimalAssetSpec({ animal, file, sourceSha256, scriptSha256, farmSha256, blenderVersion }:
  { animal: WildAnimal; file: string | null; sourceSha256: string | null; scriptSha256: string; farmSha256: string; blenderVersion: string }) {
  return parseAssetSpec({
    schemaVersion: 1, assetId: wildKey(animal), generator: { id: "external.blender.script", version: "1" }, randomness: { mode: "none" },
    inputs: {
      script: { path: "wildlife.py", sha256: scriptSha256 }, farm: { path: "farm_animals.py", sha256: farmSha256 },
      ...(file && sourceSha256 ? { source: { path: file, sha256: sourceSha256 } } : {}),
    }, models: {},
    parameters: { blenderVersion, arguments: { schemaVersion: 1, animal } }, output: { path: `${animal}.glb` }, reproducibility: { expected: "exact" },
  });
}

export async function buildGreyhavenWildlife({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const read = async (file: string) => JSON.parse(await readFile(path.join(ROOT, file), "utf8"));
  const [providers, sources, storage] = await Promise.all(["catalog/providers.json", "catalog/sources.json", "catalog/storage.json"].map(read));
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const recipe = await readBlenderRecipeSource("wildlife.py");
  const farm = await readBlenderRecipeSource("farm_animals.py");
  const io = new NodeIO();
  const built = [];
  for (const entry of WILD_ANIMALS) {
    log(`generate ${wildKey(entry.animal)} (external.blender.script@1 wildlife recipe${entry.sourceId ? ` over ${entry.sourceId}` : ", authored"})`);
    const workspace = path.join(root, "animals", entry.animal);
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "wildlife.py"), recipe.bytes);
    await writeFile(path.join(workspace, "farm_animals.py"), farm.bytes);
    let source: AssetRef | null = null;
    if (entry.sourceId) {
      source = (await importAssetCatalogStorageSource({ catalog, storage, sourceId: entry.sourceId, storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
      await writeFile(path.join(workspace, entry.file!), await resolveAssetObject(root, source));
    }
    const specPath = path.join(workspace, "asset.json");
    const spec = createWildAnimalAssetSpec({ animal: entry.animal, file: entry.file, sourceSha256: source?.sha256 ?? null, scriptSha256: recipe.sha256, farmSha256: farm.sha256, blenderVersion: recipe.blenderVersion });
    await writeFile(specPath, `${canonicalJson(spec)}\n`);
    const generated = await generateAsset(specPath);
    const observations = (generated.receipt.observations as Json).script as Json;
    const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, `${entry.animal}.glb`)), kind: "mesh", mediaType: "model/gltf-binary" })).asset;
    const imported = single(await executeGltfProductionImportOperation(root, { inputs: { source: glb }, parameters: { policy: POLICY } }));
    const document = await io.readBinary(new Uint8Array(await resolveAssetObject(root, imported)));
    built.push({ entry, source, glb, imported, document, observations });
  }

  log("measure the wildlife descriptor");
  const recipeRef = { script: "adapters/blender/wildlife.py", sha256: recipe.sha256, farm: { script: "adapters/blender/farm_animals.py", sha256: farm.sha256 } };
  const descriptor = {
    schema: WILD_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right", origin: "footprint-ground-center",
    placement: "Non-interactive cosmetic wildlife. The consumer owns world placement, wandering, flight paths, fleeing, collision and gameplay; none is implied here.",
    clips: { names: ["Idle", "Walk", "Eat", "Fly"], required: ["Idle", "Walk", "Eat"], birds: ["Fly"], rootMotion: "in-place", loop: true },
    assets: built.map(({ entry, source, observations, document }) => ({
      key: wildKey(entry.animal), variant: "default", animal: entry.animal, bird: entry.bird,
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
  await writeFile(path.join(root, WILD_DESCRIPTOR_FILE), descriptorBytes);
  const attachment = (await storeAssetObject(root, { bytes: descriptorBytes, kind: "descriptor", mediaType: "application/json", metadata: { schema: WILD_DESCRIPTOR_SCHEMA } })).asset;

  log("export gltf-resources-v1 bundle and pack the release tar");
  const bundleDir = path.join(root, "bundle");
  const exported = await exportAssetBundle(root, bundleDir, {
    parameters: {
      profile: GLTF_RESOURCES_BUNDLE_PROFILE,
      assets: built.map(({ entry }, index) => ({ key: wildKey(entry.animal), variant: "default", ...(index === 0 ? { attachments: [{ name: WILD_DESCRIPTOR_ATTACHMENT }] } : {}) })),
    },
    inputs: { assets: built.map(({ imported }) => imported), attachments: [attachment] },
  });
  const tar = path.join(root, WILD_TAR_NAME);
  const pack = Bun.spawnSync(["bun", path.join(ROOT, "scripts/pack-asset-bundle.ts"), bundleDir, tar], { stdout: "pipe", stderr: "pipe" });
  if (pack.exitCode !== 0) throw new Error(`bundle packing failed: ${pack.stderr.toString()}`);
  const packed = JSON.parse(pack.stdout.toString());
  const ref = readAssetBundleTar(await readFile(tar)).find((item) => item.path === ASSET_BUNDLE_REF_FILE);
  if (!ref) throw new Error("packed wildlife bundle has no export ref");
  await writeFile(path.join(root, ASSET_BUNDLE_REF_FILE), ref.bytes);
  const lineage = {
    release: WILD_RELEASE, recipe: { ...recipeRef, blenderVersion: recipe.blenderVersion },
    animals: Object.fromEntries(built.map(({ entry, source, glb, imported, observations }) => [entry.animal, {
      key: wildKey(entry.animal), catalogSource: entry.sourceId, license: source ? "CC0-1.0" : "original", source, generated: glb, imported, observations,
    }])),
  };
  await writeFile(path.join(root, "lineage.json"), `${JSON.stringify(lineage, null, 2)}\n`);
  return {
    bundleDir, tar, tarSha256: packed.sha256 as string, tarByteLength: packed.byteLength as number, descriptor, manifest: exported.manifest,
    exportRef: JSON.parse(ref.bytes.toString("utf8")) as Json, lineage, glbs: Object.fromEntries(built.map(({ entry, glb }) => [entry.animal, glb])) as Record<WildAnimal, AssetRef>,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") {
    console.error("Usage: ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-wildlife.ts --out <directory>");
    process.exit(2);
  }
  try {
    const result = await buildGreyhavenWildlife({ outDir: args[1]!, log: (line) => console.error(`[wildlife] ${line}`) });
    console.log(JSON.stringify({ tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength, exportRef: result.exportRef }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}
