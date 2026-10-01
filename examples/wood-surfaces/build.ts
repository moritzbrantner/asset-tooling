import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdir,mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {NodeIO,type Document} from "@gltf-transform/core";
import {SURFACE_TEXTURE_PRESETS,executeSurfaceTextureRecipe,executePreservedSurfaceTextureRecipe,type SurfaceTexturePreservation} from "asset-tooling/recipes/surface-textures";
import {createAssetRef,type AssetRef} from "asset-tooling/operations";
import {resolveAssetObject,storeAssetObject} from "asset-tooling/operations/store";
import {executeImageEncodePngOperation} from "asset-tooling/operations/image/codecs";
import {executeTextureOrmPackOperation,executePbrMaterialBundleOperation} from "asset-tooling/operations/material";
import {executeGltfProductionImportOperation} from "asset-tooling/operations/processing/gltf-production";
import {executeGltfPbrMaterialOperation} from "asset-tooling/operations/processing/gltf-pbr";
import {exportAssetBundle,verifyAssetBundle,STATIC_ASSET_BUNDLE_PROFILE} from "asset-tooling/operations/bundle";
import {encodeRgba8Image,RGBA8_IMAGE_MEDIA_TYPE} from "asset-tooling/image/rgba8";
import {canonicalJson} from "../../src/canonical.js";
import {writeIfChanged} from "../reconcile-file.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),directory=path.join(root,".artifacts/wood-surfaces");
const names=["wood-long-grain","wood-short-grain","wood-cross-grain"] as const;
function geometry(document:Document) {
 return {nodes:document.getRoot().listNodes().map(n=>({name:n.getName(),matrix:n.getMatrix(),children:n.listChildren().map(c=>c.getName())})),
  primitives:document.getRoot().listMeshes().flatMap(m=>m.listPrimitives().map(p=>({indices:[...p.getIndices()!.getArray()!],
   attributes:p.listSemantics().sort().map(s=>({semantic:s,type:p.getAttribute(s)!.getType(),values:[...p.getAttribute(s)!.getArray()!]}))})))};
}
await mkdir(directory,{recursive:true});
const cold=await mkdtemp(path.join(tmpdir(),"wood-surfaces-example-")),variants:Record<string,unknown>[]=[];
const assets:AssetRef[]=[],entries:{key:string;variant:string}[]=[];
try {
 // Reuse the existing independently authored neutral review quad, including its original slot name.
 const source=(await storeAssetObject(root,{kind:"scene",mediaType:"model/gltf+json",bytes:await readFile(new URL("../tilled-soil/plane.gltf",import.meta.url)),
  metadata:{source:"examples/tilled-soil/plane.gltf",units:"meters",purpose:"material-review-quad"}})).asset;
 const master=createAssetRef((await executeGltfProductionImportOperation(root,{inputs:{source},parameters:{policy:{requireNormals:true,maxTriangles:2}}})).outputs.output);
 const original=geometry(await new NodeIO().setAllowNetwork(false).readBinary(await resolveAssetObject(root,master)));
 for(const id of names) {
  const recipe=SURFACE_TEXTURE_PRESETS[id],result=await executeSurfaceTextureRecipe(root,recipe);
  assert.deepEqual(await executeSurfaceTextureRecipe(cold,recipe),result);
  const pngs:Record<string,AssetRef>={};
  for(const [channel,image] of Object.entries(result.outputs)) {
   const invocation={inputs:{source:image},parameters:{compressionLevel:9}},encoded=await executeImageEncodePngOperation(root,invocation);
   assert.deepEqual(await executeImageEncodePngOperation(cold,invocation),encoded);
   const png=createAssetRef(encoded.outputs.output);pngs[channel]=png;
   await writeIfChanged(path.join(directory,`${id}-${channel}.png`),await resolveAssetObject(root,png));
   await writeIfChanged(path.join(directory,`${id}-${channel}.rgba.json`),await resolveAssetObject(root,image));
  }
  const preserve:SurfaceTexturePreservation={};
  for(const channel of ["height","normal","roughness"] as const) {
   const step=result.steps.find(s=>s.output.metadata.field===channel);assert.ok(step);preserve[channel]=step;
  }
  const edited={...recipe,low:[80,45,20],high:[230,190,115]},partial=await executePreservedSurfaceTextureRecipe(root,edited,{preserve});
  const {execution,...canonical}=partial;assert.deepEqual(await executeSurfaceTextureRecipe(cold,edited),canonical);
  assert.equal(execution.executedOperations,1);assert.equal(execution.reusedOperations,5);
  for(const channel of ["height","normal","roughness"] as const) assert.deepEqual(partial.outputs[channel],result.outputs[channel]);
  const recolorInvocation={inputs:{source:partial.outputs.color!},parameters:{compressionLevel:9}},encodedRecolor=await executeImageEncodePngOperation(root,recolorInvocation);
  assert.deepEqual(await executeImageEncodePngOperation(cold,recolorInvocation),encodedRecolor);
  const recolored=createAssetRef(encodedRecolor.outputs.output);
  await writeIfChanged(path.join(directory,`${id}-recolored.png`),await resolveAssetObject(root,recolored));
  await writeIfChanged(path.join(directory,`${id}-recolored.rgba.json`),await resolveAssetObject(root,partial.outputs.color!));
  const constant=async(value:number,field:string)=>{
   const pixels=Buffer.alloc(recipe.width*recipe.height*4,value);for(let i=3;i<pixels.length;i+=4) pixels[i]=255;
   return (await storeAssetObject(root,{kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,bytes:encodeRgba8Image({width:recipe.width,height:recipe.height,pixels}),
    metadata:{field,scalarEncoding:"unorm8",channelColorSpace:"linear",value}})).asset;
  };
  const ao=await constant(255,"neutral-unoccluded"),metallic=await constant(0,"dielectric-metallic");
  const orm=createAssetRef((await executeTextureOrmPackOperation(root,{inputs:{"ambient-occlusion":ao,roughness:result.outputs.roughness!,metallic}})).outputs.output);
  const material=createAssetRef((await executePbrMaterialBundleOperation(root,{inputs:{"base-color":result.outputs.color!,normal:result.outputs.normal!,orm},parameters:{normalYAxis:"negative"}})).outputs.output);
  const invocation={inputs:{source:master,material,"base-color":result.outputs.color!,normal:result.outputs.normal!,orm},parameters:{materialName:"soil-surface",baseColorFactor:[1,1,1,1],texCoord:0,
   sampler:{magFilter:"linear",minFilter:"linear",wrapS:"repeat",wrapT:"repeat"},alpha:{mode:"OPAQUE"},normalScale:1,roughnessFactor:1,metallicFactor:1,occlusionStrength:1}};
  const finished=await executeGltfPbrMaterialOperation(root,invocation),mesh=createAssetRef(finished.outputs.output);
  for(const ref of Object.values(invocation.inputs)) await storeAssetObject(cold,{kind:ref.kind,mediaType:ref.mediaType,metadata:ref.metadata,bytes:await resolveAssetObject(root,ref)});
  assert.deepEqual(await executeGltfPbrMaterialOperation(cold,invocation),finished);
  assert.deepEqual(geometry(await new NodeIO().setAllowNetwork(false).readBinary(await resolveAssetObject(root,mesh))),original);
  await writeIfChanged(path.join(directory,`${id}.glb`),await resolveAssetObject(root,mesh));
  assets.push(mesh);entries.push({key:id,variant:"pbr"});
  variants.push({id,result,pngs,recolored,partial,source,master,ao,metallic,orm,material,finished,mesh,coldReplayMatches:true,geometryUnchanged:true,geometryGeneratorsExecuted:0});
 }
 const packaged=await exportAssetBundle(root,path.join(directory,"package"),{inputs:{assets},parameters:{profile:STATIC_ASSET_BUNDLE_PROFILE,assets:entries}});
 await verifyAssetBundle(path.join(directory,"package"),packaged.manifest);
 await writeIfChanged(path.join(directory,"package.ref.json"),Buffer.from(canonicalJson(packaged.manifest)+"\n"));
 await writeIfChanged(path.join(directory,"evidence.json"),Buffer.from(canonicalJson({schemaVersion:1,variants,geometryGeneratorsExecuted:0})+"\n"));
 console.log(JSON.stringify({variants:names,textureColdReplays:3,preservedRecolorColdReplays:3,pngColdReplays:15,materialColdReplays:3,packageBytesWritten:packaged.bytesWritten}));
} finally {await rm(cold,{recursive:true,force:true});}
