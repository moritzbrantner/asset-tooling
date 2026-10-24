// Greyhaven's ambient cat, dog and small rodent (#364, consumer mmorpg#419, docs/greyhaven-ambient-animals.md):
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-ambient-animals.ts --out <directory>
// Each animal is one external.blender.script@1 run of adapters/blender/ambient_animals.py over its hash-pinned CC0
// catalog payload (imported offline from hydrated LFS storage), checked through scene.import.gltf@2 and exported as
// a gltf-resources-v1 bundle packed to <directory>/greyhaven.ambient-animals.tar, next to the measured
// greyhaven-ambient-animals-descriptor-v1, lineage.json and export.ref.json.
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
export const AMBIENT_RELEASE = "greyhaven-ambient-animals";
export const AMBIENT_TAR_NAME = "greyhaven.ambient-animals.tar";
export const AMBIENT_DESCRIPTOR_SCHEMA = "greyhaven-ambient-animals-descriptor-v1";
export const AMBIENT_DESCRIPTOR_ATTACHMENT = "ambient-animals-descriptor";
export const AMBIENT_DESCRIPTOR_FILE = "greyhaven.ambient-animals.descriptor.json";
export const AMBIENT_CLIPS = ["Idle", "Walk"] as const;
export const AMBIENT_ANIMALS = [
  { animal: "cat", key: "greyhaven.ambient.cat", sourceId: "quaternius.animal-pack-vol2.cat-blend", file: "source.blend",
    pack: "Quaternius Animal Pack Vol.2", member: "Blends/Cat.blend", sourceClips: { Idle: "Idle", Walk: "Walking" } },
  { animal: "dog", key: "greyhaven.ambient.dog", sourceId: "quaternius.ultimate-animated-animals-shibainu-glb", file: "source.glb",
    pack: "Quaternius Ultimate Animated Animals", member: "ShibaInu.glb", sourceClips: { Idle: "Idle", Walk: "Walk" } },
  { animal: "rodent", key: "greyhaven.ambient.rodent", sourceId: "quaternius.easy-enemy-rat-glb", file: "source.glb",
    pack: "Quaternius Easy Enemy", member: "Rat.glb", sourceClips: { Idle: "Rat_Idle", Walk: "Rat_Walk" } },
] as const;
export type AmbientAnimal = (typeof AMBIENT_ANIMALS)[number]["animal"];
const POLICY = { allowedValidatorWarnings: [...GLTF_RESOURCES_BUNDLE_ALLOWED_VALIDATOR_WARNINGS] };

function single(result: AssetOperationResult): AssetRef {
  const output = result.outputs.output;
  if (!output || Array.isArray(output)) throw new Error("asset operation returned no single output");
  return output;
}

export function createAmbientAnimalAssetSpec({ animal, file, sourceSha256, scriptSha256, blenderVersion }:
  { animal: AmbientAnimal; file: string; sourceSha256: string; scriptSha256: string; blenderVersion: string }) {
  return parseAssetSpec({
    schemaVersion: 1, assetId: `greyhaven.ambient.${animal}`, generator: { id: "external.blender.script", version: "1" }, randomness: { mode: "none" },
    inputs: { script: { path: "ambient_animals.py", sha256: scriptSha256 }, source: { path: file, sha256: sourceSha256 } }, models: {},
    parameters: { blenderVersion, arguments: { schemaVersion: 1, animal } }, output: { path: `${animal}.glb` }, reproducibility: { expected: "exact" },
  });
}

export async function buildGreyhavenAmbientAnimals({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const read = async (file: string) => JSON.parse(await readFile(path.join(ROOT, file), "utf8"));
  const [providers, sources, storage] = await Promise.all(["catalog/providers.json", "catalog/sources.json", "catalog/storage.json"].map(read));
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const recipe = await readBlenderRecipeSource("ambient_animals.py");
  const io = new NodeIO();
  const built = [];
  for (const entry of AMBIENT_ANIMALS) {
    log(`import ${entry.sourceId} and generate ${entry.key} (external.blender.script@1 ambient-animals recipe)`);
    const source = (await importAssetCatalogStorageSource({ catalog, storage, sourceId: entry.sourceId, storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
    const workspace = path.join(root, "animals", entry.animal);
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "ambient_animals.py"), recipe.bytes);
    await writeFile(path.join(workspace, entry.file), await resolveAssetObject(root, source));
    const specPath = path.join(workspace, "asset.json");
    const spec = createAmbientAnimalAssetSpec({ animal: entry.animal, file: entry.file, sourceSha256: source.sha256, scriptSha256: recipe.sha256, blenderVersion: recipe.blenderVersion });
    await writeFile(specPath, `${canonicalJson(spec)}\n`);
    const generated = await generateAsset(specPath);
    const observations = (generated.receipt.observations as Json).script as Json;
    const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, `${entry.animal}.glb`)), kind: "mesh", mediaType: "model/gltf-binary" })).asset;
    const imported = single(await executeGltfProductionImportOperation(root, { inputs: { source: glb }, parameters: { policy: POLICY } }));
    const document = await io.readBinary(new Uint8Array(await resolveAssetObject(root, imported)));
    built.push({ entry, source, glb, imported, document, observations });
  }

  log("measure the ambient-animals descriptor");
  const descriptor = {
    schema: AMBIENT_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right", origin: "footprint-ground-center",
    placement: "Non-interactive cosmetic ambience. The consumer owns world placement, wandering, collision and gameplay; none is implied here.",
    clips: { names: AMBIENT_CLIPS, rootMotion: "in-place", loop: true },
    assets: built.map(({ entry, source, observations, document }) => ({
      key: entry.key, variant: "default", animal: entry.animal,
      idleBounds: observations.idleBounds,
      size: Object.fromEntries((["width", "height", "depth"] as const).map((name, axis) => [name, +(observations.idleBounds.max[axis] - observations.idleBounds.min[axis]).toFixed(5)])),
      triangles: document.getRoot().listMeshes().reduce((sum, mesh) => sum + mesh.listPrimitives().reduce((n, p) => n + (p.getIndices()?.getCount() ?? 0) / 3, 0), 0),
      joints: observations.joints,
      clips: Object.fromEntries(document.getRoot().listAnimations().map((a) => [a.getName(), {
        seconds: +Math.max(...a.listSamplers().map((s) => s.getInput()!.getMax([])[0]!)).toFixed(5),
        source: entry.sourceClips[a.getName() as (typeof AMBIENT_CLIPS)[number]],
      }])),
      walkTravel: observations.walkTravel,
      provenance: { pack: entry.pack, member: entry.member, catalogSource: entry.sourceId, license: "CC0-1.0", source, recipe: { script: "adapters/blender/ambient_animals.py", sha256: recipe.sha256 } },
    })),
  };
  const descriptorBytes = Buffer.from(`${canonicalJson(descriptor)}\n`);
  await writeFile(path.join(root, AMBIENT_DESCRIPTOR_FILE), descriptorBytes);
  const attachment = (await storeAssetObject(root, { bytes: descriptorBytes, kind: "descriptor", mediaType: "application/json", metadata: { schema: AMBIENT_DESCRIPTOR_SCHEMA } })).asset;

  log("export gltf-resources-v1 bundle (asset.bundle@1) and pack the release tar");
  const bundleDir = path.join(root, "bundle");
  const exported = await exportAssetBundle(root, bundleDir, {
    parameters: {
      profile: GLTF_RESOURCES_BUNDLE_PROFILE,
      assets: built.map(({ entry }, index) => ({ key: entry.key, variant: "default", ...(index === 0 ? { attachments: [{ name: AMBIENT_DESCRIPTOR_ATTACHMENT }] } : {}) })),
    },
    inputs: { assets: built.map(({ imported }) => imported), attachments: [attachment] },
  });
  const tar = path.join(root, AMBIENT_TAR_NAME);
  const pack = Bun.spawnSync(["bun", path.join(ROOT, "scripts/pack-asset-bundle.ts"), bundleDir, tar], { stdout: "pipe", stderr: "pipe" });
  if (pack.exitCode !== 0) throw new Error(`bundle packing failed: ${pack.stderr.toString()}`);
  const packed = JSON.parse(pack.stdout.toString());
  const ref = readAssetBundleTar(await readFile(tar)).find((item) => item.path === ASSET_BUNDLE_REF_FILE);
  if (!ref) throw new Error("packed ambient-animals bundle has no export ref");
  await writeFile(path.join(root, ASSET_BUNDLE_REF_FILE), ref.bytes);
  const lineage = {
    release: AMBIENT_RELEASE, recipe: { script: "adapters/blender/ambient_animals.py", sha256: recipe.sha256, blenderVersion: recipe.blenderVersion },
    animals: Object.fromEntries(built.map(({ entry, source, glb, imported, observations }) => [entry.animal, { key: entry.key, catalogSource: entry.sourceId, license: "CC0-1.0", source, generated: glb, imported, observations }])),
  };
  await writeFile(path.join(root, "lineage.json"), `${JSON.stringify(lineage, null, 2)}\n`);
  return {
    bundleDir, tar, tarSha256: packed.sha256 as string, tarByteLength: packed.byteLength as number, descriptor, manifest: exported.manifest,
    exportRef: JSON.parse(ref.bytes.toString("utf8")) as Json, lineage, glbs: Object.fromEntries(built.map(({ entry, glb }) => [entry.animal, glb])) as Record<AmbientAnimal, AssetRef>,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") {
    console.error("Usage: ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-ambient-animals.ts --out <directory>");
    process.exit(2);
  }
  try {
    const result = await buildGreyhavenAmbientAnimals({ outDir: args[1]!, log: (line) => console.error(`[ambient] ${line}`) });
    console.log(JSON.stringify({ tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength, exportRef: result.exportRef }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}
