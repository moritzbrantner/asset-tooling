import assert from "node:assert/strict";
import path from "node:path";
import {mkdir,mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {NodeIO,type Document} from "@gltf-transform/core";
import {createAssetRef,type AssetRef,type AssetOperationResult,type AssetOperationBuildIdentity,type CanonicalJsonObject} from "asset-tooling/operations";
import {resolveAssetObject,storeAssetObject} from "asset-tooling/operations/store";
import {executeImageEncodePngOperation} from "asset-tooling/operations/image/codecs";
import {executeGltfBaseColorOperation,createGltfBaseColorOperationBuildIdentity,type GltfBaseColorParameters} from "asset-tooling/operations/processing/gltf-material";
import {exportAssetBundle,verifyAssetBundle,readAssetBundleAsset,STATIC_ASSET_BUNDLE_PROFILE} from "asset-tooling/operations/bundle";
import {prepareRenderDerivativeRecipe,readRenderDerivativeRecipeSource,RENDER_DERIVATIVE_PRESETS} from "asset-tooling/recipes/render-derivatives";
import {canonicalJson} from "../src/canonical.js";
import {writeIfChanged} from "./reconcile-file.js";
import {type AssetSpec} from "../src/schema.js";
type Receipt={spec:{sha256:string};observations:{script:CanonicalJsonObject}};
const generationModule:string="asset-tooling";
const {generateAsset,verifyAsset}:{generateAsset:(p:string)=>Promise<{receipt:Receipt}>;verifyAsset:(p:string)=>Promise<{status:string}>}=await import(generationModule);
type GradientInvocation={parameters:{width:number;height:number;direction:"vertical";startColor:number[];endColor:number[]}};
const gradientModule:string="asset-tooling/operations/generation/procedural-image";
const {executeProceduralImageGradientOperation,createProceduralImageGradientOperationBuildIdentity}:{
 executeProceduralImageGradientOperation:(root:string,p:GradientInvocation)=>Promise<AssetOperationResult>;
 createProceduralImageGradientOperationBuildIdentity:(p:GradientInvocation)=>Promise<AssetOperationBuildIdentity>;
}=await import(gradientModule);
export async function buildCropAppearanceExample({root,directory,crop,stages,files,sourceMetadata,footprint}:{
 root:string;directory:string;crop:"wheat"|"corn";stages:{id:string;spec:AssetSpec}[];files:{path:string;bytes:Uint8Array}[];
 sourceMetadata:CanonicalJsonObject;footprint:{width:number;depth:number};
}) {
const renderer=await readRenderDerivativeRecipeSource(),io=new NodeIO();
const meshes:Record<string,AssetRef>={},icons:Record<string,AssetRef>={},evidence:Record<string,unknown>={};
const cold=await mkdtemp(path.join(tmpdir(),`${crop}-example-`));
function geometry(document:Document) {
 return document.getRoot().listNodes().map(node=>({name:node.getName(),matrix:node.getMatrix(),primitives:node.getMesh()!.listPrimitives().map(p=>({
  indices:[...p.getIndices()!.getArray()!],attributes:Object.fromEntries(p.listSemantics().map(s=>[s,[...p.getAttribute(s)!.getArray()!]])),
 }))}));
}
function retainedMaterials(document:Document) {
 return document.getRoot().listMaterials().filter(m=>m.getName()!==`${crop}-foliage`).map(m=>({name:m.getName(),factor:m.getBaseColorFactor(),
  roughness:m.getRoughnessFactor(),metallic:m.getMetallicFactor(),alpha:m.getAlphaMode(),doubleSided:m.getDoubleSided()}));
}
async function copy(ref:AssetRef) {
 const result=await storeAssetObject(cold,{bytes:await resolveAssetObject(root,ref),kind:ref.kind,mediaType:ref.mediaType,metadata:ref.metadata});
 assert.deepEqual(result.asset,ref);
}
try {
 await mkdir(directory,{recursive:true});
 for(const {id,spec} of stages) {
  const workspace=path.join(directory,id);await mkdir(workspace,{recursive:true});
  for(const file of files) {await writeIfChanged(path.join(workspace,file.path),file.bytes);}
  await writeIfChanged(path.join(workspace,"asset.json"),Buffer.from(canonicalJson(spec)+"\n"));
  const generated=await generateAsset(path.join(workspace,"asset.json"));assert.equal((await verifyAsset(path.join(workspace,"asset.json"))).status,"exact");
  const bytes=await readFile(path.join(workspace,spec.output.path));
  meshes[id]=(await storeAssetObject(root,{bytes,kind:"mesh",mediaType:"model/gltf-binary",metadata:{generator:"external.blender.script@1",
   ...sourceMetadata,sourceSpecSha256:generated.receipt.spec.sha256,geometry:generated.receipt.observations.script}})).asset;
  evidence[id]={receipt:generated.receipt};await copy(meshes[id]!);
 }
 const mature=meshes.mature!;
 const original=await io.readBinary(await resolveAssetObject(root,mature));
 const controls:GltfBaseColorParameters={materialName:`${crop}-foliage`,baseColorFactor:[1,1,1,1],texCoord:0,
  sampler:{magFilter:"linear",minFilter:"linear",wrapS:"clamp-to-edge",wrapT:"clamp-to-edge"},alpha:{mode:"OPAQUE"}};
 async function leafVariant(store:string,startColor:number[],endColor:number[]) {
  const gradient={parameters:{width:8,height:32,direction:"vertical",startColor,endColor}} satisfies GradientInvocation;
  const gradientBuild=await createProceduralImageGradientOperationBuildIdentity(gradient),artwork=await executeProceduralImageGradientOperation(store,gradient);
  const png=createAssetRef((await executeImageEncodePngOperation(store,{parameters:{compressionLevel:9},inputs:{source:artwork.outputs.output}})).outputs.output);
  const invocation={parameters:controls,inputs:{source:mature,"base-color":png}};
  const build=await createGltfBaseColorOperationBuildIdentity(store,invocation),result=await executeGltfBaseColorOperation(store,invocation);
  return {output:createAssetRef(result.outputs.output),png,gradientBuild,artwork,build,result};
 }
 const green=await leafVariant(root,[21,61,8,255],[86,128,24,255]);
 const straw=await leafVariant(root,[103,66,14,255],[215,177,66,255]);
 assert.deepEqual(await leafVariant(cold,[21,61,8,255],[86,128,24,255]),green);
 assert.deepEqual(await leafVariant(cold,[103,66,14,255],[215,177,66,255]),straw);
 for(const [id,result] of Object.entries({"mature-green":green,"mature-straw":straw})) {
  const edited=await io.readBinary(await resolveAssetObject(root,result.output));
  assert.deepEqual(geometry(edited),geometry(original));assert.deepEqual(retainedMaterials(edited),retainedMaterials(original));
  meshes[id]=result.output;evidence[id]=result;
 }
 for(const [id,mesh] of Object.entries(meshes)) {
  const workspace=path.join(directory,`${id}-icon`);await mkdir(workspace,{recursive:true});
  const prepared=await prepareRenderDerivativeRecipe(root,{assetId:`${crop}.${id}.icon`,source:mesh,scriptSha256:renderer.sha256,blenderVersion:renderer.blenderVersion,
   parameters:{...RENDER_DERIVATIVE_PRESETS.icon,width:256,height:384,samples:16}});
  await writeIfChanged(path.join(workspace,"render_static_glb.py"),renderer.bytes);await writeIfChanged(path.join(workspace,"source.glb"),prepared.sourceBytes);
  await writeIfChanged(path.join(workspace,"asset.json"),Buffer.from(canonicalJson(prepared.spec)+"\n"));
  const generated=await generateAsset(path.join(workspace,"asset.json"));assert.equal((await verifyAsset(path.join(workspace,"asset.json"))).status,"exact");
  icons[id]=(await storeAssetObject(root,{bytes:await readFile(path.join(workspace,"render.png")),kind:"image",mediaType:"image/png",
   metadata:{source:{...mesh},sourceSpecSha256:generated.receipt.spec.sha256,rendererScriptSha256:renderer.sha256,width:256,height:384}})).asset;
  evidence[`${id}-icon`]={receipt:generated.receipt};await copy(mesh);await copy(icons[id]!);
 }
 // Select just one finished mature appearance and its icons for distribution.
 const selected=["early","mature-straw","harvested"];
 const entries=selected.flatMap(id=>[{key:`${crop}.mesh`,variant:id,asset:meshes[id]!},{key:`${crop}.icon`,variant:id,asset:icons[id]!}]);
 const invocation={parameters:{profile:STATIC_ASSET_BUNDLE_PROFILE,assets:entries.map(({key,variant})=>({key,variant}))},inputs:{assets:entries.map(e=>e.asset)}};
 const exported=await exportAssetBundle(root,path.join(directory,"package"),invocation),independent=await exportAssetBundle(cold,path.join(cold,"package"),invocation);
 assert.deepEqual(independent.manifest,exported.manifest);await rm(path.join(cold,".asset-tooling"),{recursive:true,force:true});
 const verified=await verifyAssetBundle(path.join(cold,"package"),independent.manifest);
 for(const entry of entries) {
  assert.deepEqual(await readAssetBundleAsset(path.join(cold,"package"),verified.manifest,entry.key,entry.variant),await resolveAssetObject(root,entry.asset));
 }
 await writeIfChanged(path.join(directory,"package.ref.json"),Buffer.from(canonicalJson(exported.manifest)+"\n"));
 await writeIfChanged(path.join(directory,"assets.json"),Buffer.from(canonicalJson({meshes,icons})+"\n"));
 await writeIfChanged(path.join(directory,"evidence.json"),Buffer.from(canonicalJson({evidence,geometryPreserved:true,stemGrainMaterialsPreserved:true,coldMaterialReplayMatches:true,
  selected,packageOnlyMatches:true,isolatedLeafEditGeometryGenerators:0,footprint,framing:"individually-auto-fit-icons"})+"\n"));
 console.log(JSON.stringify({stages:selected,meshes:Object.keys(meshes),files:exported.files.length,packageBytesWritten:exported.bytesWritten,
  geometryPreserved:true,coldMaterialReplayMatches:true,packageOnlyMatches:true}));
} finally {await rm(cold,{recursive:true,force:true});}

}
