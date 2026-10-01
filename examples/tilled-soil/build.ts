import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { canonicalJson } from "../../src/canonical.js";
import { createAssetRef, type AssetRef } from "../../src/operations.js";
import { resolveAssetObject, storeAssetObject } from "../../src/asset-store.js";
import { encodeRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "../../src/image-rgba8.js";
import { executeSurfaceTextureRecipe, SURFACE_TEXTURE_PRESETS } from "../../src/surface-texture-recipes.js";
import { executeImageEncodePngOperation } from "../../src/image-codec-operations.js";
import { executeTextureOrmPackOperation, executePbrMaterialBundleOperation } from "../../src/material-operations.js";
import { executeGltfProductionImportOperation } from "../../src/gltf-production-operations.js";
import { executeGltfPbrMaterialOperation } from "../../src/gltf-pbr-material-operations.js";
import { exportAssetBundle, verifyAssetBundle, STATIC_ASSET_BUNDLE_PROFILE } from "../../src/asset-bundle.js";
import { writeIfChanged } from "../reconcile-file.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),directory=path.join(root,".artifacts/tilled-soil");
const names=["soil-tilled-shallow","soil-tilled-deep","soil-tilled-crosswise"] as const;
const cold=await mkdtemp(path.join(tmpdir(),"tilled-soil-example-"));
const evidence:Record<string,unknown>={},meshes:Record<string,string>={},assets:AssetRef[]=[],entries:{key:string;variant:string}[]=[];
await mkdir(directory,{recursive:true});
try {
  // Review geometry is authored content, not the production Field Plot or displaced terrain.
  const source=(await storeAssetObject(root,{kind:"scene",mediaType:"model/gltf+json",bytes:await readFile(new URL("./plane.gltf",import.meta.url)),
    metadata:{source:"examples/tilled-soil/plane.gltf",units:"meters",purpose:"material-review-quad"}})).asset;
  const master=createAssetRef((await executeGltfProductionImportOperation(root,{inputs:{source},parameters:{policy:{requireNormals:true,maxTriangles:2}}})).outputs.output);
  for(const name of names) {
    const recipe=SURFACE_TEXTURE_PRESETS[name],result=await executeSurfaceTextureRecipe(root,recipe);
    assert.deepEqual(await executeSurfaceTextureRecipe(cold,recipe),result);
    const pngs:Record<string,AssetRef>={};
    for(const [channel,image] of Object.entries(result.outputs)) {
      const png=createAssetRef((await executeImageEncodePngOperation(root,{inputs:{source:image},parameters:{compressionLevel:9}})).outputs.output);
      await writeIfChanged(path.join(directory,`${name}-${channel}.png`),await resolveAssetObject(root,png));pngs[channel]=png;
    }
    const constant=async(value:number,field:string)=>{
      const pixels=Buffer.alloc(recipe.width*recipe.height*4,value);for(let i=3;i<pixels.length;i+=4)pixels[i]=255;
      return (await storeAssetObject(root,{kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,bytes:encodeRgba8Image({width:recipe.width,height:recipe.height,pixels}),
        metadata:{field,scalarEncoding:"unorm8",channelColorSpace:"linear",value}})).asset;
    };
    const ao=await constant(255,"neutral-unoccluded"),metallic=await constant(0,"dielectric-metallic");
    const orm=createAssetRef((await executeTextureOrmPackOperation(root,{inputs:{"ambient-occlusion":ao,roughness:result.outputs.roughness!,metallic}})).outputs.output);
    const material=createAssetRef((await executePbrMaterialBundleOperation(root,{inputs:{"base-color":result.outputs.color!,normal:result.outputs.normal!,orm},parameters:{normalYAxis:"negative"}})).outputs.output);
    const invocation={inputs:{source:master,material,"base-color":result.outputs.color!,normal:result.outputs.normal!,orm},parameters:{
      materialName:"soil-surface",baseColorFactor:[1,1,1,1],texCoord:0,sampler:{magFilter:"linear",minFilter:"linear",wrapS:"repeat",wrapT:"repeat"},
      alpha:{mode:"OPAQUE"},normalScale:1,roughnessFactor:1,metallicFactor:1,occlusionStrength:1}};
    const finished=await executeGltfPbrMaterialOperation(root,invocation),mesh=createAssetRef(finished.outputs.output);
    for(const ref of Object.values(invocation.inputs)) await storeAssetObject(cold,{kind:ref.kind,mediaType:ref.mediaType,metadata:ref.metadata,bytes:await resolveAssetObject(root,ref)});
    assert.deepEqual(await executeGltfPbrMaterialOperation(cold,invocation),finished);
    await writeIfChanged(path.join(directory,`${name}.glb`),await resolveAssetObject(root,mesh));meshes[name]=`${name}.glb`;
    assets.push(mesh);entries.push({key:name,variant:"pbr"});
    evidence[name]={result,pngs,master,ao,metallic,orm,material,finished,coldReplayMatches:true};
  }
  await writeIfChanged(path.join(directory,"builds.json"),Buffer.from(canonicalJson(evidence)+"\n"));
  await writeIfChanged(path.join(directory,"review-inputs.json"),Buffer.from(canonicalJson({schemaVersion:1,meshes})+"\n"));
  const packaged=await exportAssetBundle(root,path.join(directory,"package"),{inputs:{assets},parameters:{profile:STATIC_ASSET_BUNDLE_PROFILE,assets:entries}});
  await verifyAssetBundle(path.join(directory,"package"),packaged.manifest);
  await writeIfChanged(path.join(directory,"package.ref.json"),Buffer.from(canonicalJson(packaged.manifest)+"\n"));
  console.log(JSON.stringify({variants:names,textureColdReplays:3,materialColdReplays:3,packageBytesWritten:packaged.bytesWritten}));
} finally {await rm(cold,{recursive:true,force:true});}
