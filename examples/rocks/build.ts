import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { canonicalJson } from "../../src/canonical.js";
import { generateAsset, verifyAsset } from "../../src/core.js";
import { storeAssetObject } from "../../src/asset-store.js";
import { createRockAssetSpec, createRockVariantManifest, readRockRecipeSource, ROCK_PRESETS, type RockVariant } from "../../src/rock-recipes.js";
import { writeIfChanged } from "../reconcile-file.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const directory=path.join(root,".artifacts/rocks");
const source=await readRockRecipeSource();
const variants: RockVariant[]=[];
const evidence: Record<string,unknown>={};
for(const [id,parameters] of Object.entries(ROCK_PRESETS)) {
  const workspace=path.join(directory,id);
  await mkdir(workspace,{recursive:true});
  await writeIfChanged(path.join(workspace,"rock.py"),source.bytes);
  const spec=createRockAssetSpec({assetId:`asset-tooling.rock.${id}`,parameters,scriptSha256:source.sha256,blenderVersion:source.blenderVersion});
  const specPath=path.join(workspace,"asset.json");
  await writeIfChanged(specPath,Buffer.from(canonicalJson(spec)+"\n"));
  const generated=await generateAsset(specPath);
  const verified=await verifyAsset(specPath);
  if(verified.status!=="exact") throw new Error(`${id}: rock replay failed`);
  const bytes=await readFile(path.join(workspace,"rock.glb"));
  const stored=await storeAssetObject(root,{kind:"mesh",mediaType:"model/gltf-binary",bytes,
    metadata:{generator:"external.blender.script@1",recipe:"rock-v1",scriptSha256:source.sha256,unit:"meter",axes:"right-handed-y-up",sourceSpecSha256:generated.receipt.spec.sha256,geometry:generated.receipt.observations.script}});
  variants.push({id,mesh:stored.asset});
  // Cache status is execution evidence and intentionally excluded from the stable manifest.
  evidence[id]={receipt:generated.receipt,verified};
}
await writeIfChanged(path.join(directory,"variants.json"),Buffer.from(canonicalJson(createRockVariantManifest(variants))+"\n"));
await writeIfChanged(path.join(directory,"evidence.json"),Buffer.from(canonicalJson(evidence)+"\n"));
console.log(JSON.stringify({directory,variants:variants.map(v=>v.id)}));
