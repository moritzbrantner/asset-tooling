import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdir,mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {NodeIO} from "@gltf-transform/core";
import {createGrassAssetSpec,GRASS_PRESETS,readGrassRecipeSource} from "asset-tooling/recipes/grass";
import {type AssetRef,type CanonicalJsonObject} from "asset-tooling/operations";
import {resolveAssetObject,storeAssetObject} from "asset-tooling/operations/store";
import {prepareRenderDerivativeRecipe,readRenderDerivativeRecipeSource,RENDER_DERIVATIVE_PRESETS} from "asset-tooling/recipes/render-derivatives";
import {exportAssetBundle,verifyAssetBundle,readAssetBundleAsset,STATIC_ASSET_BUNDLE_PROFILE} from "asset-tooling/operations/bundle";
import {executeGltfProductionImportOperation} from "asset-tooling/operations/processing/gltf-production";
import {canonicalJson} from "../../src/canonical.js";
import {writeIfChanged} from "../reconcile-file.js";
const generationModule:string="asset-tooling";
const {generateAsset,verifyAsset}:{generateAsset:(p:string)=>Promise<{cache:{status:string};receipt:{spec:{sha256:string};observations:{script:CanonicalJsonObject}}}>;
 verifyAsset:(p:string)=>Promise<{status:string}>}=await import(generationModule);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),directory=path.join(root,".artifacts/grass-clumps");
const source=await readGrassRecipeSource(),renderer=await readRenderDerivativeRecipeSource();
const variants=GRASS_PRESETS;
const meshes:Record<string,AssetRef>={},images:Record<string,AssetRef>={},evidence:Record<string,unknown>={};
let geometryStagesExecuted=0,renderStagesExecuted=0;
const cold=await mkdtemp(path.join(tmpdir(),"grass-example-"));
async function copy(ref:AssetRef) {
 assert.deepEqual((await storeAssetObject(cold,{kind:ref.kind,mediaType:ref.mediaType,metadata:ref.metadata,bytes:await resolveAssetObject(root,ref)})).asset,ref);
}
try {
 await mkdir(directory,{recursive:true});
 for(const [id,parameters] of Object.entries(variants)) {
   const key=id,geometryWorkspace=path.join(directory,key);await mkdir(geometryWorkspace,{recursive:true});
   await writeIfChanged(path.join(geometryWorkspace,"grass.py"),source.bytes);await writeIfChanged(path.join(geometryWorkspace,"wheat.py"),source.authoring.bytes);
   const spec=createGrassAssetSpec({assetId:`grass.${key}`,parameters,scriptSha256:source.sha256,authoringSha256:source.authoring.sha256,blenderVersion:source.blenderVersion});
   const geometrySpecPath=path.join(geometryWorkspace,"asset.json");await writeIfChanged(geometrySpecPath,Buffer.from(canonicalJson(spec)+"\n"));
   const generated=await generateAsset(geometrySpecPath);assert.equal((await verifyAsset(geometrySpecPath)).status,"exact");
   if(generated.cache.status!=="hit") {geometryStagesExecuted++;}
   const geometry=generated.receipt.observations.script;
   const bytes=await readFile(path.join(geometryWorkspace,"grass.glb"));
   const mesh=(await storeAssetObject(root,{bytes,kind:"mesh",mediaType:"model/gltf-binary",metadata:{generator:"external.blender.script@1",recipe:"grass-v1",
    presetId:id,scriptSha256:source.sha256,authoringSha256:source.authoring.sha256,sourceSpecSha256:generated.receipt.spec.sha256,geometry}})).asset;
   const imported=await executeGltfProductionImportOperation(root,{inputs:{source:mesh},parameters:{policy:{requireNormals:true,maxTriangles:parameters.maxTriangles}}});
   const document=await new NodeIO().setAllowNetwork(false).readBinary(bytes);
   const positions=document.getRoot().listMeshes().flatMap(m=>m.listPrimitives().map(p=>p.getAttribute("POSITION")!));
   const bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
   for(const accessor of positions) {
    for(let i=0;i<accessor.getCount();i++) {
     const point:number[]=[];accessor.getElement(i,point);
     for(let axis=0;axis<3;axis++) {bounds.min[axis]=Math.min(bounds.min[axis]!,point[axis]!);bounds.max[axis]=Math.max(bounds.max[axis]!,point[axis]!);}
    }
   }
   assert.ok(bounds.min[1]!>=-1e-5);
   assert.ok(Math.abs(bounds.min[1]!)<1e-5);assert.ok(bounds.max[1]!<=parameters.bladeHeight+1e-5);
   assert.ok(document.getRoot().listNodes().every(n=>n.getMatrix().every((v,i)=>Math.abs(v-(i%5===0?1:0))<1e-8)));
   meshes[key]=mesh;evidence[key]={receipt:generated.receipt,imported,bounds};await copy(mesh);
  const workspace=path.join(directory,`${id}-render`);await mkdir(workspace,{recursive:true});
  const prepared=await prepareRenderDerivativeRecipe(root,{assetId:`grass.${id}.render`,source:mesh,scriptSha256:renderer.sha256,blenderVersion:renderer.blenderVersion,
   parameters:{...RENDER_DERIVATIVE_PRESETS.icon,width:384,height:384,samples:16,padding:.04,
    framing:{type:"shared-orthographic",center:[0,.22,0],horizontalSpan:1.25,pivot:[0,0,0]}}});
  await writeIfChanged(path.join(workspace,"render_static_glb.py"),renderer.bytes);await writeIfChanged(path.join(workspace,"source.glb"),prepared.sourceBytes);
  const specPath=path.join(workspace,"asset.json");await writeIfChanged(specPath,Buffer.from(canonicalJson(prepared.spec)+"\n"));
  const rendered=await generateAsset(specPath);assert.equal((await verifyAsset(specPath)).status,"exact");
  if(rendered.cache.status!=="hit") {renderStagesExecuted++;}
  images[id]=(await storeAssetObject(root,{bytes:await readFile(path.join(workspace,"render.png")),kind:"image",mediaType:"image/png",
   metadata:{source:{...mesh},sourceSpecSha256:rendered.receipt.spec.sha256,rendererScriptSha256:renderer.sha256,render:rendered.receipt.observations.script}})).asset;
  evidence[`${id}-render`]={receipt:rendered.receipt};await copy(images[id]!);
 }
 const entries=[...Object.entries(meshes).map(([variant,asset])=>({key:"grass.mesh",variant,asset})),...Object.entries(images).map(([variant,asset])=>({key:"grass.preview",variant,asset}))];
 const invocation={parameters:{profile:STATIC_ASSET_BUNDLE_PROFILE,assets:entries.map(({key,variant})=>({key,variant}))},inputs:{assets:entries.map(e=>e.asset)}};
 const packaged=await exportAssetBundle(root,path.join(directory,"package"),invocation),coldPackage=await exportAssetBundle(cold,path.join(cold,"package"),invocation);
 assert.deepEqual(coldPackage.manifest,packaged.manifest);await rm(path.join(cold,".asset-tooling"),{recursive:true,force:true});
 const checked=await verifyAssetBundle(path.join(cold,"package"),coldPackage.manifest);
 for(const entry of entries) {assert.deepEqual(await readAssetBundleAsset(path.join(cold,"package"),checked.manifest,entry.key,entry.variant),await resolveAssetObject(root,entry.asset));}
 await writeIfChanged(path.join(directory,"assets.json"),Buffer.from(canonicalJson({meshes,images})+"\n"));
 await writeIfChanged(path.join(directory,"package.ref.json"),Buffer.from(canonicalJson(packaged.manifest)+"\n"));
 await writeIfChanged(path.join(directory,"evidence.json"),Buffer.from(canonicalJson({schemaVersion:1,evidence,distributionFiles:packaged.files,packageOnlyMatches:true,
  unit:"meter",origin:"native-root-ground-anchor",consumerPlacementAuthority:false})+"\n"));
 console.log(JSON.stringify({geometryStagesExecuted,geometryReplayStages:Object.keys(meshes).length,renderStagesExecuted,renderReplayStages:Object.keys(images).length,packageBytesWritten:packaged.bytesWritten,packageFiles:packaged.files.length,
  packageOnlyMatches:true}));
} finally {await rm(cold,{recursive:true,force:true});}
