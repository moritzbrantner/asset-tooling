import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdir,mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {SURFACE_TEXTURE_PRESETS,executeSurfaceTextureRecipe,executePreservedSurfaceTextureRecipe} from "asset-tooling/recipes/surface-textures";
import {createAssetRef,type AssetRef} from "asset-tooling/operations";
import {resolveAssetObject,storeAssetObject} from "asset-tooling/operations/store";
import {createImageEncodePngOperationBuildIdentity,executeImageEncodePngOperation} from "asset-tooling/operations/image/codecs";
import {exportAssetBundle,verifyAssetBundle,readAssetBundleAsset,STATIC_ASSET_BUNDLE_PROFILE} from "asset-tooling/operations/bundle";
import {canonicalJson} from "../../src/canonical.js";
import {writeIfChanged} from "../reconcile-file.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),directory=path.join(root,".artifacts/paper-grain");
const names=["paper-fine","paper-coarse","paper-fibers"] as const;
const outputs:{id:string;image:AssetRef}[]=[],evidence:Record<string,unknown>={};
const cold=await mkdtemp(path.join(tmpdir(),"paper-grain-example-"));
async function encode(id:string,result:Awaited<ReturnType<typeof executeSurfaceTextureRecipe>>) {
 const source=result.outputs.color!;
 const invocation={inputs:{source},parameters:{compressionLevel:9}};
 const build=await createImageEncodePngOperationBuildIdentity(root,invocation);
 const encodedResult=await executeImageEncodePngOperation(root,invocation);
 assert.deepEqual(await executeImageEncodePngOperation(cold,invocation),encodedResult);
 const encoded=createAssetRef(encodedResult.outputs.output);
 const bytes=await resolveAssetObject(root,encoded);
 const image=createAssetRef({...encoded,metadata:{...encoded.metadata,source:{...source},surface:{...result},encoding:{...build}}});
 assert.deepEqual((await storeAssetObject(root,{bytes,kind:image.kind,mediaType:image.mediaType,metadata:image.metadata})).asset,image);
 assert.deepEqual((await storeAssetObject(cold,{bytes:await resolveAssetObject(cold,encoded),kind:image.kind,mediaType:image.mediaType,metadata:image.metadata})).asset,image);
 await writeIfChanged(path.join(directory,`${id}.png`),bytes);
 await writeIfChanged(path.join(directory,`${id}.rgba.json`),await resolveAssetObject(root,source));
 outputs.push({id,image});
}
try {
 await mkdir(directory,{recursive:true});
 for(const id of names) {
  const result=await executeSurfaceTextureRecipe(root,SURFACE_TEXTURE_PRESETS[id],{channels:["color"]});
  assert.deepEqual(await executeSurfaceTextureRecipe(cold,SURFACE_TEXTURE_PRESETS[id],{channels:["color"]}),result);
  await encode(id,result);
  const height=result.steps.find(s=>s.output.metadata.field==="height");assert.ok(height);
  const recolored=await executePreservedSurfaceTextureRecipe(root,{...result.recipe,low:[220,228,235],high:[238,244,249]},
   {channels:["color"],preserve:{height}});
  const {execution,...canonical}=recolored;
  assert.equal(execution.executedOperations,1);assert.equal(execution.reusedOperations,3);
  assert.deepEqual(await executeSurfaceTextureRecipe(cold,canonical.recipe,{channels:["color"]}),canonical);
  await encode(`${id}-cool`,canonical);
  evidence[id]={result,recolored:canonical,recolorExecution:execution};
 }
 const invocation={parameters:{profile:STATIC_ASSET_BUNDLE_PROFILE,assets:outputs.map(o=>({key:"paper.grain",variant:o.id}))},inputs:{assets:outputs.map(o=>o.image)}};
 const packaged=await exportAssetBundle(root,path.join(directory,"package"),invocation);
 const coldPackage=await exportAssetBundle(cold,path.join(cold,"package"),invocation);
 assert.deepEqual(coldPackage.manifest,packaged.manifest);
 await rm(path.join(cold,".asset-tooling"),{recursive:true,force:true});
 const checked=await verifyAssetBundle(path.join(cold,"package"),coldPackage.manifest);
 for(const output of outputs) {
  assert.deepEqual(await readAssetBundleAsset(path.join(cold,"package"),checked.manifest,"paper.grain",output.id),await readFile(path.join(directory,`${output.id}.png`)));
 }
 await writeIfChanged(path.join(directory,"package.ref.json"),Buffer.from(canonicalJson(packaged.manifest)+"\n"));
 await writeIfChanged(path.join(directory,"outputs.json"),Buffer.from(canonicalJson({schemaVersion:1,outputs})+"\n"));
 await writeIfChanged(path.join(directory,"evidence.json"),Buffer.from(canonicalJson({schemaVersion:1,evidence,distributionFiles:packaged.files,coldReplayMatches:true,packageOnlyMatches:true,
  channels:["color"],geometryStagesExecuted:0,normalStagesExecuted:0,roughnessStagesExecuted:0})+"\n"));
 console.log(JSON.stringify({variants:outputs.length,packageFiles:packaged.files.length,packageBytesWritten:packaged.bytesWritten,
  coldReplayMatches:true,packageOnlyMatches:true,recolorOperationsExecuted:3,recolorOperationsReused:9,geometryStagesExecuted:0,normalStagesExecuted:0,roughnessStagesExecuted:0}));
} finally {await rm(cold,{recursive:true,force:true});}
