import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { canonicalJson } from "../../src/canonical.js";
import { createAssetRef } from "../../src/operations.js";
import { resolveAssetObject, storeAssetObject, assetObjectPortablePath } from "../../src/asset-store.js";
import { parseRgba8Image, encodeRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "../../src/image-rgba8.js";
import { executeTextureOrmPackOperation, executePbrMaterialBundleOperation } from "../../src/material-operations.js";
import { executeGltfPbrMaterialOperation, type GltfPbrMaterialParameters } from "../../src/gltf-pbr-material-operations.js";
import { createRockVariantManifest, type RockVariant } from "../../src/rock-recipes.js";
import { exportAssetBundle, verifyAssetBundle, STATIC_ASSET_BUNDLE_PROFILE } from "../../src/asset-bundle.js";
import { writeIfChanged } from "../reconcile-file.js";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),directory=path.join(root,".artifacts/rock-pbr");
function object(value:unknown):Record<string,unknown> {if(!value || typeof value!=="object" || Array.isArray(value)) throw new Error("invalid declared example inventory");return value as Record<string,unknown>;}
const raw=object(JSON.parse(await readFile(path.join(root,".artifacts/rocks/variants.json"),"utf8")));
if(!Array.isArray(raw.variants)) throw new Error("run examples/rocks/build.ts first");
const masters=raw.variants.map(value=>{const entry=object(value);if(typeof entry.id!=="string") throw new Error("invalid master ID");return {id:entry.id,mesh:createAssetRef(entry.mesh)};});
assert.deepEqual(masters.map(m=>m.id).sort(),["angular","boulder","flat","rounded"]);
const surfaces=object(JSON.parse(await readFile(path.join(root,".artifacts/surface-textures/builds.json"),"utf8")));
const masterMtimes=await Promise.all(masters.map(m=>stat(path.join(root,assetObjectPortablePath(m.mesh))).then(s=>s.mtimeMs)));
const controls:GltfPbrMaterialParameters={materialName:"rock-surface",baseColorFactor:[1,1,1,1],texCoord:0,
  sampler:{magFilter:"linear",minFilter:"linear",wrapS:"repeat",wrapT:"repeat"},alpha:{mode:"OPAQUE"},normalScale:1,metallicFactor:1,roughnessFactor:1,occlusionStrength:1};
const variants:RockVariant[]=[],evidence:Record<string,unknown>={};
const cold=await mkdtemp(path.join(tmpdir(),"rock-pbr-replay-"));await mkdir(directory,{recursive:true});
try {
  for(const recipe of ["rock-grainy","rock-layered"] as const) {
    const outputs=object(object(surfaces[recipe]).outputs),baseColor=createAssetRef(outputs.color),normal=createAssetRef(outputs.normal),roughness=createAssetRef(outputs.roughness);
    if(normal.metadata.normalYAxis!=="negative" || roughness.metadata.field!=="roughness") throw new Error("saved surface channels must declare their semantics");
    const shape=parseRgba8Image(await resolveAssetObject(root,roughness));
    // Explicit neutral occlusion and dielectric metallic values, not inferred noise channels.
    const constant=async(value:number,field:string)=>{const pixels=Buffer.alloc(shape.width*shape.height*4,value);for(let i=3;i<pixels.length;i+=4) pixels[i]=255;
      return (await storeAssetObject(root,{bytes:encodeRgba8Image({...shape,pixels}),kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,metadata:{field,scalarEncoding:"unorm8",channelColorSpace:"linear",value}})).asset;};
    const ao=await constant(255,"neutral-unoccluded"),metallic=await constant(0,"dielectric-metallic");
    const orm=createAssetRef((await executeTextureOrmPackOperation(root,{inputs:{"ambient-occlusion":ao,roughness,metallic}})).outputs.output);
    const material=createAssetRef((await executePbrMaterialBundleOperation(root,{inputs:{"base-color":baseColor,normal,orm},parameters:{normalYAxis:"negative"}})).outputs.output);
    const review:Record<string,string>={},family=path.join(directory,recipe);await mkdir(path.join(family,"maps"),{recursive:true});
    for(const master of masters) {
      const invocation={parameters:controls,inputs:{source:master.mesh,material,"base-color":baseColor,normal,orm}};
      const result=await executeGltfPbrMaterialOperation(root,invocation),mesh=createAssetRef(result.outputs.output),bytes=await resolveAssetObject(root,mesh);
      for(const asset of Object.values(invocation.inputs)) await storeAssetObject(cold,{bytes:await resolveAssetObject(root,asset),kind:asset.kind,mediaType:asset.mediaType,metadata:asset.metadata});
      assert.deepEqual(await executeGltfPbrMaterialOperation(cold,invocation),result);
      const io=new NodeIO().setAllowNetwork(false),before=await io.readBinary(await resolveAssetObject(root,master.mesh)),after=await io.readBinary(bytes);
      for(const [i,original] of before.getRoot().listMeshes().entries()) for(const [j,primitive] of original.listPrimitives().entries()) {
        const next=after.getRoot().listMeshes()[i]!.listPrimitives()[j]!;assert.deepEqual(next.getIndices()!.getArray(),primitive.getIndices()!.getArray());
        for(const semantic of primitive.listSemantics()) assert.deepEqual(next.getAttribute(semantic)!.getArray(),primitive.getAttribute(semantic)!.getArray());
      }
      const inspected=after.getRoot().listMaterials().find(m=>m.getName()==="rock-surface")!;
      assert.equal(inspected.getOcclusionTexture(),inspected.getMetallicRoughnessTexture());
      const maps=object(result.observations.encodedTextures);
      for(const role of ["baseColor","normal","orm"]) await writeIfChanged(path.join(family,"maps",`${role}.png`),await resolveAssetObject(root,createAssetRef(maps[role])));
      const workspace=path.join(family,master.id);await mkdir(workspace,{recursive:true});await writeIfChanged(path.join(workspace,"rock.glb"),bytes);
      review[master.id]=`${master.id}/rock.glb`;variants.push({id:`${master.id}-${recipe}`,mesh,material});
      evidence[`${master.id}-${recipe}`]={master:master.mesh,result,geometryReused:true,coldReplayMatches:true,encodedBytes:bytes.length};
    }
    evidence[recipe]={baseColor,normal,roughness,ao,metallic,orm,material};
    await writeIfChanged(path.join(family,"review-inputs.json"),Buffer.from(`${canonicalJson({schemaVersion:1,meshes:review})}\n`));
  }
} finally {await rm(cold,{recursive:true,force:true});}
for(const [i,master] of masters.entries()) assert.equal((await stat(path.join(root,assetObjectPortablePath(master.mesh)))).mtimeMs,masterMtimes[i]);
await writeIfChanged(path.join(directory,"variants.json"),Buffer.from(`${canonicalJson(createRockVariantManifest(variants))}\n`));
await writeIfChanged(path.join(directory,"evidence.json"),Buffer.from(`${canonicalJson(evidence)}\n`));
const packaged=await exportAssetBundle(root,path.join(directory,"package"),{parameters:{profile:STATIC_ASSET_BUNDLE_PROFILE,assets:variants.map(v=>({key:v.id,variant:"pbr"}))},inputs:{assets:variants.map(v=>v.mesh)}});
await verifyAssetBundle(path.join(directory,"package"),packaged.manifest);
await writeIfChanged(path.join(directory,"package.ref.json"),Buffer.from(`${canonicalJson(packaged.manifest)}\n`));
console.log(JSON.stringify({variants:variants.length,geometryGeneratorsExecuted:0,coldReplays:variants.length,textureSets:2,masterObjectsUnchanged:true,packagedFiles:packaged.files,packageBytesWritten:packaged.bytesWritten}));
