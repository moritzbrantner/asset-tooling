// The Zoo animals (docs/quadruped-rigid.md, docs/zoo-animals.md):
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-zoo-animals.ts --out <directory>
// Zoo's existing zebra and giraffe (#128, Atlas Decisions 8.1.2 and 8.1.4) are hash-pinned MIT catalog payloads
// imported offline from hydrated LFS storage, as authored, as the `default` variant. The expressive animals (#589)
// are generated here by the Blender recipe adapters/blender/zoo_animals.py, as the `expressive` variant. Every
// member is checked against the shared quadruped-rigid profile and exported as one gltf-resources-v1 bundle packed
// to <directory>/zoo-animals.tar, next to the measured zoo-animals-descriptor-v1, the licence text, lineage.json and
// export.ref.json.
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { blenderScriptSpec, runBlenderRecipe } from "../src/blender-recipe-run.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { runKitCli } from "../src/kit-bundle.js";
import { packageQuadrupedRigidFamily } from "../src/quadruped-rigid.js";
import type { AssetRef } from "../src/operations.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const ZOO_ANIMALS_RELEASE = "zoo-animals";
export const ZOO_ANIMALS_TAR_NAME = "zoo-animals.tar";
export const ZOO_ANIMALS_DESCRIPTOR_SCHEMA = "zoo-animals-descriptor-v1";
export const ZOO_ANIMALS_DESCRIPTOR_ATTACHMENT = "zoo-animals-descriptor";
export const ZOO_ANIMALS_DESCRIPTOR_FILE = "zoo-animals.descriptor.json";
export const ZOO_ANIMALS = [
  { animal: "giraffe", key: "zoo.animal.giraffe", sourceId: "zoo.giraffe-glb" },
  { animal: "zebra", key: "zoo.animal.zebra", sourceId: "zoo.zebra-glb" },
] as const;
/**
 * The expressive animals authored here by adapters/blender/zoo_animals.py (#589), packaged beside Zoo's own
 * models as the `expressive` variant of the same key, so the `default` members stay as they were.
 */
export const ZOO_EXPRESSIVE_VARIANT = "expressive";
export const ZOO_EXPRESSIVE_ANIMALS = [
  { animal: "zebra", key: "zoo.animal.zebra", issue: 589 },
  { animal: "giraffe", key: "zoo.animal.giraffe", issue: 596 },
  { animal: "tiger", key: "zoo.animal.tiger", issue: 590 },
  { animal: "elephant", key: "zoo.animal.elephant", issue: 599 },
  { animal: "capybara", key: "zoo.animal.capybara", issue: 600 },
] as const;
export const ZOO_ANIMALS_RECIPE = "adapters/blender/zoo_animals.py";

export function createZooAnimalAssetSpec({ species, scriptSha256, blenderVersion }: { species: string; scriptSha256: string; blenderVersion: string }) {
  return blenderScriptSpec({
    assetId: `zoo.animal.${species}.${ZOO_EXPRESSIVE_VARIANT}`, inputs: { script: { path: "zoo_animals.py", sha256: scriptSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, species }, output: `${species}.glb`,
  });
}
/** The conventions of Zoo's authored models. They are as authored, and differ from the Greyhaven animals' +Z facing. */
const ZOO_CONVENTIONS = { facing: "+X", origin: "rig-root-on-the-ground-plane" };

export async function buildZooAnimals({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const read = async (file: string) => JSON.parse(await readFile(path.join(ROOT, file), "utf8"));
  const [providers, sources, storage] = await Promise.all(["catalog/providers.json", "catalog/sources.json", "catalog/storage.json"].map(read));
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const licenseText = await readFile(path.join(ROOT, "licenses/zoo-animals-MIT.txt"), "utf8");
  const members = [];
  let license = null as null | { spdx: string; attribution: string; evidenceUrl: string };
  for (const entry of ZOO_ANIMALS) {
    log(`import ${entry.sourceId} from canonical storage`);
    const source = (await importAssetCatalogStorageSource({ catalog, storage, sourceId: entry.sourceId, storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
    const catalogEntry = sources.sources.find((candidate: { id: string }) => candidate.id === entry.sourceId);
    license = catalogEntry.license;
    members.push({
      key: entry.key, source,
      provenance: { catalogSource: entry.sourceId, animal: entry.animal, url: catalogEntry.source.url, revision: catalogEntry.source.revision, path: catalogEntry.source.path, generator: catalogEntry.metadata.generator },
    });
  }
  if (!license) throw new Error("no Zoo animal entries");
  const recipe = await readBlenderRecipeSource("zoo_animals.py");
  for (const entry of ZOO_EXPRESSIVE_ANIMALS) {
    log(`generate the ${ZOO_EXPRESSIVE_VARIANT} ${entry.animal} (external.blender.script@1 ${ZOO_ANIMALS_RECIPE})`);
    const { glb, observations } = await runBlenderRecipe(root, {
      workspace: path.join(root, "zoo-animals", entry.animal), files: { "zoo_animals.py": recipe.bytes },
      spec: createZooAnimalAssetSpec({ species: entry.animal, scriptSha256: recipe.sha256, blenderVersion: recipe.blenderVersion }),
    });
    members.push({
      key: entry.key, variant: ZOO_EXPRESSIVE_VARIANT, source: glb,
      provenance: {
        animal: entry.animal, issue: `https://github.com/moritzbrantner/asset-tooling/issues/${entry.issue}`,
        recipe: { script: ZOO_ANIMALS_RECIPE, sha256: recipe.sha256, blenderVersion: recipe.blenderVersion, name: (observations as { recipe: string }).recipe },
        generator: "procedural: original scripted geometry and clips in this repository; no imported meshes, no third-party assets, no textures",
      },
    });
  }
  return packageQuadrupedRigidFamily(root, {
    release: ZOO_ANIMALS_RELEASE, tarName: ZOO_ANIMALS_TAR_NAME, descriptorFile: ZOO_ANIMALS_DESCRIPTOR_FILE,
    descriptorSchema: ZOO_ANIMALS_DESCRIPTOR_SCHEMA, descriptorAttachment: ZOO_ANIMALS_DESCRIPTOR_ATTACHMENT,
    conventions: ZOO_CONVENTIONS, members, license: { ...license, text: licenseText }, log,
  });
}

if (import.meta.main) await runKitCli("scripts/build-zoo-animals.ts", "zoo-animals", buildZooAnimals);
