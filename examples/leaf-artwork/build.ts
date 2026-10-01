import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { executeLeafArtworkRecipe, executePreservedLeafArtworkRecipe, LEAF_ARTWORK_PRESETS } from "asset-tooling/recipes/leaf-artwork";
import { createAssetRef, type AssetRef } from "asset-tooling/operations";
import { resolveAssetObject } from "asset-tooling/operations/store";
import { executeImageEncodePngOperation } from "asset-tooling/operations/image/codecs";
import { exportAssetBundle, verifyAssetBundle, readAssetBundleAsset, STATIC_ASSET_BUNDLE_PROFILE } from "asset-tooling/operations/bundle";
import { canonicalJson } from "../../src/canonical.js";
import { writeIfChanged } from "../reconcile-file.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),directory=path.join(root,".artifacts/leaf-artwork");
const cold=await mkdtemp(path.join(tmpdir(),"leaf-artwork-example-"));
await mkdir(directory,{recursive:true});
const evidence:Record<string,unknown>={},pngs:Record<string,AssetRef>={},canonical:Record<string,AssetRef>={};
try {
  async function png(id:string,source:AssetRef) {
    const invocation={inputs:{source},parameters:{compressionLevel:9}},result=await executeImageEncodePngOperation(root,invocation),ref=createAssetRef(result.outputs.output);
    assert.deepEqual(await executeImageEncodePngOperation(cold,invocation),result);
    await writeIfChanged(path.join(directory,`${id}.png`),await resolveAssetObject(root,ref));pngs[id]=ref;canonical[id]=source;
  }
  for(const [name,preset] of Object.entries(LEAF_ARTWORK_PRESETS)) {
    const summer=await executeLeafArtworkRecipe(root,preset);
    assert.deepEqual(await executeLeafArtworkRecipe(cold,preset),summer);
    const autumnRecipe={...preset,low:[240,176,51],high:[120,49,14]};
    const partial=await executePreservedLeafArtworkRecipe(root,autumnRecipe,{mask:summer.maskStep});
    const {execution,...autumn}=partial;
    assert.deepEqual(await executeLeafArtworkRecipe(cold,autumnRecipe),autumn);
    assert.deepEqual(autumn.outputs.mask,summer.outputs.mask);
    await png(`${name}.summer`,summer.outputs.image);await png(`${name}.autumn`,autumn.outputs.image);await png(`${name}.mask`,summer.outputs.mask);
    evidence[name]={summer,autumn,execution,coldReplayMatches:true};
  }
  const selected=Object.entries(pngs),packageDirectory=path.join(directory,"package");
  const packaged=await exportAssetBundle(root,packageDirectory,{inputs:{assets:selected.map(([,ref])=>ref)},parameters:{profile:STATIC_ASSET_BUNDLE_PROFILE,assets:selected.map(([id])=>({key:id,variant:"png"}))}});
  const verified=await verifyAssetBundle(packageDirectory,packaged.manifest);
  for(const [id,ref] of selected) assert.deepEqual(await readAssetBundleAsset(packageDirectory,verified.manifest,id,"png"),await resolveAssetObject(root,ref));
  await writeIfChanged(path.join(directory,"package.ref.json"),Buffer.from(canonicalJson(packaged.manifest)+"\n"));
  await writeIfChanged(path.join(directory,"evidence.json"),Buffer.from(canonicalJson({schemaVersion:1,evidence,pngs,canonical})+"\n"));
  console.log(JSON.stringify({sprites:6,masks:3,coldRecipeReplays:6,preservedMaskReuses:3,packageFiles:packaged.files.length,packageBytesWritten:packaged.bytesWritten}));
} finally {await rm(cold,{recursive:true,force:true});}
