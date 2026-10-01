/** Shared executable proof steps for the shrub and grass producer examples. */
import assert from "node:assert/strict";
import path from "node:path";
import {mkdir,mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {NodeIO} from "@gltf-transform/core";
import {type AssetRef,type CanonicalJsonObject} from "asset-tooling/operations";
import {resolveAssetObject,storeAssetObject} from "asset-tooling/operations/store";
import {prepareRenderDerivativeRecipe,readRenderDerivativeRecipeSource} from "asset-tooling/recipes/render-derivatives";
import {exportAssetBundle,verifyAssetBundle,readAssetBundleAsset,STATIC_ASSET_BUNDLE_PROFILE} from "asset-tooling/operations/bundle";
import {executeGltfProductionImportOperation} from "asset-tooling/operations/processing/gltf-production";
import {canonicalJson} from "../src/canonical.js";
import {writeIfChanged} from "./reconcile-file.js";
const generationModule:string="asset-tooling";
export const {generateAsset,verifyAsset}:{generateAsset:(p:string)=>Promise<{cache:{status:string};receipt:{spec:{sha256:string};observations:{script:CanonicalJsonObject}}}>;
 verifyAsset:(p:string)=>Promise<{status:string}>}=await import(generationModule);

export async function inspectNativeVegetationMesh(root:string,mesh:AssetRef,maxTriangles:number) {
 const imported=await executeGltfProductionImportOperation(root,{inputs:{source:mesh},parameters:{policy:{requireNormals:true,maxTriangles}}});
 const document=await new NodeIO().setAllowNetwork(false).readBinary(await resolveAssetObject(root,mesh));
 const positions=document.getRoot().listMeshes().flatMap(m=>m.listPrimitives().map(p=>p.getAttribute("POSITION")!));
 const bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
 for(const accessor of positions) {
  for(let i=0;i<accessor.getCount();i++) {
   const point:number[]=[];accessor.getElement(i,point);
   for(let axis=0;axis<3;axis++) {bounds.min[axis]=Math.min(bounds.min[axis]!,point[axis]!);bounds.max[axis]=Math.max(bounds.max[axis]!,point[axis]!);}
  }
 }
 assert.ok(bounds.min[1]!>=-1e-5);
 assert.ok(document.getRoot().listNodes().every(n=>n.getMatrix().every((v,i)=>Math.abs(v-(i%5===0?1:0))<1e-8)));
 return {imported,bounds};
}

export async function renderNativeVegetationPreview({root,directory,prefix,id,mesh,parameters,renderer}: {
 root:string;directory:string;prefix:string;id:string;mesh:AssetRef;parameters:unknown;renderer:Awaited<ReturnType<typeof readRenderDerivativeRecipeSource>>;
}) {
 const workspace=path.join(directory,`${id}-render`);await mkdir(workspace,{recursive:true});
 const prepared=await prepareRenderDerivativeRecipe(root,{assetId:`${prefix}.${id}.render`,source:mesh,scriptSha256:renderer.sha256,blenderVersion:renderer.blenderVersion,parameters});
 await writeIfChanged(path.join(workspace,"render_static_glb.py"),renderer.bytes);await writeIfChanged(path.join(workspace,"source.glb"),prepared.sourceBytes);
 const specPath=path.join(workspace,"asset.json");await writeIfChanged(specPath,Buffer.from(canonicalJson(prepared.spec)+"\n"));
 const rendered=await generateAsset(specPath);assert.equal((await verifyAsset(specPath)).status,"exact");
 const image=(await storeAssetObject(root,{bytes:await readFile(path.join(workspace,"render.png")),kind:"image",mediaType:"image/png",
  metadata:{source:{...mesh},sourceSpecSha256:rendered.receipt.spec.sha256,rendererScriptSha256:renderer.sha256,render:rendered.receipt.observations.script}})).asset;
 return {image,receipt:rendered.receipt,executed:rendered.cache.status!=="hit"};
}

export async function packageNativeVegetation(root:string,directory:string,prefix:string,meshes:Record<string,AssetRef>,images:Record<string,AssetRef>) {
 const cold=await mkdtemp(path.join(tmpdir(),`${prefix}-example-`));
 try {
  const entries=[...Object.entries(meshes).map(([variant,asset])=>({key:`${prefix}.mesh`,variant,asset})),...Object.entries(images).map(([variant,asset])=>({key:`${prefix}.preview`,variant,asset}))];
  for(const {asset} of entries) {
   assert.deepEqual((await storeAssetObject(cold,{kind:asset.kind,mediaType:asset.mediaType,metadata:asset.metadata,bytes:await resolveAssetObject(root,asset)})).asset,asset);
  }
  const invocation={parameters:{profile:STATIC_ASSET_BUNDLE_PROFILE,assets:entries.map(({key,variant})=>({key,variant}))},inputs:{assets:entries.map(e=>e.asset)}};
  const packaged=await exportAssetBundle(root,path.join(directory,"package"),invocation),coldPackage=await exportAssetBundle(cold,path.join(cold,"package"),invocation);
  assert.deepEqual(coldPackage.manifest,packaged.manifest);await rm(path.join(cold,".asset-tooling"),{recursive:true,force:true});
  const checked=await verifyAssetBundle(path.join(cold,"package"),coldPackage.manifest);
  for(const entry of entries) {assert.deepEqual(await readAssetBundleAsset(path.join(cold,"package"),checked.manifest,entry.key,entry.variant),await resolveAssetObject(root,entry.asset));}
  await writeIfChanged(path.join(directory,"assets.json"),Buffer.from(canonicalJson({meshes,images})+"\n"));
  await writeIfChanged(path.join(directory,"package.ref.json"),Buffer.from(canonicalJson(packaged.manifest)+"\n"));
  return packaged;
 } finally {await rm(cold,{recursive:true,force:true});}
}
