// Zoo's existing animated zebra and giraffe, packaged as authored (#128, Atlas Decisions 8.1.2 and 8.1.4,
// docs/quadruped-rigid.md):
//   bun scripts/build-zoo-animals.ts --out <directory>
// Each animal is a hash-pinned MIT catalog payload imported offline from hydrated LFS storage, checked against the
// shared quadruped-rigid profile, and exported as a gltf-resources-v1 bundle packed to <directory>/zoo-animals.tar,
// next to the measured zoo-animals-descriptor-v1, the licence text, lineage.json and export.ref.json. It models and
// animates nothing, and needs no Blender.
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
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
  return packageQuadrupedRigidFamily(root, {
    release: ZOO_ANIMALS_RELEASE, tarName: ZOO_ANIMALS_TAR_NAME, descriptorFile: ZOO_ANIMALS_DESCRIPTOR_FILE,
    descriptorSchema: ZOO_ANIMALS_DESCRIPTOR_SCHEMA, descriptorAttachment: ZOO_ANIMALS_DESCRIPTOR_ATTACHMENT,
    conventions: ZOO_CONVENTIONS, members, license: { ...license, text: licenseText }, log,
  });
}

if (import.meta.main) await runKitCli("scripts/build-zoo-animals.ts", "zoo-animals", buildZooAnimals);
