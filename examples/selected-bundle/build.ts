import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { canonicalJson } from "../../src/canonical.js";
import { createAssetRef, type AssetRef } from "../../src/operations.js";
import { STATIC_ASSET_BUNDLE_PROFILE, exportAssetBundle, readAssetBundleAsset, verifyAssetBundle } from "../../src/asset-bundle.js";
import { writeIfChanged } from "../reconcile-file.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const directory=path.join(root,".artifacts/selected-bundle");
// These explicit existing example inventories carry AssetRefs. No private store paths are inferred.
const treeInventory:unknown=JSON.parse(await readFile(path.join(root,".artifacts/trees/assets.json"),"utf8"));
if(!treeInventory || typeof treeInventory!=="object" || !("assets" in treeInventory) || !treeInventory.assets || typeof treeInventory.assets!=="object") throw new Error("run the declared trees example to create its AssetRef inventory");
const treeAssets=treeInventory.assets as Record<string,unknown>;
const artwork:unknown=JSON.parse(await readFile(path.join(root,".artifacts/effect-artwork/evidence.json"),"utf8"));
if(!artwork || typeof artwork!=="object" || !("pngs" in artwork) || !artwork.pngs || typeof artwork.pngs!=="object") throw new Error("run the effect-artwork example to create its PNG AssetRefs");
const pngs=artwork.pngs as Record<string,unknown>;
const selected:{key:string;variant:string;source:AssetRef}[]=[
  {key:"tree.broadleaf",variant:"composed",source:createAssetRef(treeAssets["broadleaf.composed"])},
  {key:"tree.conifer",variant:"composed",source:createAssetRef(treeAssets["conifer.composed"])},
  {key:"feedback.puff",variant:"subtle",source:createAssetRef(pngs["puff.subtle"])},
  {key:"feedback.ring",variant:"strong",source:createAssetRef(pngs["ring.strong"])},
];
const invocation={parameters:{profile:STATIC_ASSET_BUNDLE_PROFILE,assets:selected.map(({key,variant})=>({key,variant}))},inputs:{assets:selected.map(s=>s.source)}};
const result=await exportAssetBundle(root,directory,invocation);
const verified=await verifyAssetBundle(directory,result.manifest);
for(const key of ["tree.broadleaf","tree.conifer"]) {
  const bytes=await readAssetBundleAsset(directory,verified.manifest,key,"composed");
  const document=await new NodeIO().setAllowNetwork(false).readBinary(bytes);
  if(document.getRoot().listMeshes().length!==3 || document.getRoot().listTextures().length!==0) throw new Error(`${key} package differs from its selected static master`);
}
const coldDirectory=path.join(root,".artifacts/selected-bundle-cold");
const cold=await exportAssetBundle(root,coldDirectory,invocation);
if(cold.manifest.sha256!==result.manifest.sha256) throw new Error("independent export directory disagrees");
await writeIfChanged(path.join(directory,"export.ref.json"),Buffer.from(`${canonicalJson(result.manifest)}\n`));
console.log(JSON.stringify({profile:STATIC_ASSET_BUNDLE_PROFILE,manifest:result.manifest.sha256,selected:verified.manifest.assets.map(e=>`${e.key}/${e.variant}`),
  files:result.files,assetsVerified:result.assetsVerified,blobsWritten:result.blobsWritten,blobsReused:result.blobsReused,bytesWritten:result.bytesWritten,consumerStoreRequired:false}));
