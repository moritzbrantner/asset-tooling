import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { storeAssetObject, resolveAssetObject } from "../src/asset-store.js";
import { createAssetRef } from "../src/operations.js";
import { encodeLinearRgba8Image, LINEAR_RGBA8_IMAGE_MEDIA_TYPE } from "../src/image-linear-rgba8.js";
import { parseRgba8Image } from "../src/image-rgba8.js";
import { executeImageEncodePngOperation, executeImageDecodeOperation, createImageEncodePngOperationBuildIdentity } from "../src/image-codec-operations.js";
const codecAvailable = ["ffmpeg","ffprobe"].every(tool=>spawnSync(tool,["-version"],{timeout:30_000,windowsHide:true}).status===0);

test("linear ORM PNG transport preserves data channel bytes without an sRGB transfer",{skip:!codecAvailable},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"gltf-pbr-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const pixels=Buffer.from([0,64,128,255,255,128,0,255,13,29,241,255]);
  const source=(await storeAssetObject(root,{bytes:encodeLinearRgba8Image({width:3,height:1,pixels}),kind:"image",mediaType:LINEAR_RGBA8_IMAGE_MEDIA_TYPE})).asset;
  const invocation={inputs:{source},parameters:{compressionLevel:9}};
  const build=await createImageEncodePngOperationBuildIdentity(root,invocation);
  assert.equal(build.implementation.version,"3");
  const encoded=createAssetRef((await executeImageEncodePngOperation(root,invocation)).outputs.output);
  assert.equal(encoded.metadata.sourceColorSpace,"linear-srgb");assert.equal(encoded.metadata.sourceSha256,source.sha256);
  const decoded=createAssetRef((await executeImageDecodeOperation(root,{inputs:{source:encoded}})).outputs.output);
  assert.deepEqual(parseRgba8Image(await resolveAssetObject(root,decoded)).pixels,pixels);
  assert.deepEqual(createAssetRef((await executeImageEncodePngOperation(root,invocation)).outputs.output),encoded);
});

import { NodeIO } from "@gltf-transform/core";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { materialGlb } from "./fixtures/material-glb.js";
import { encodeRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "../src/image-rgba8.js";
import { executePbrMaterialBundleOperation, parsePbrMaterialDocument } from "../src/material-operations.js";
import { assetObjectPortablePath } from "../src/asset-store.js";
import { executeGltfPbrMaterialOperation, createGltfPbrMaterialOperationBuildIdentity, type GltfPbrMaterialParameters } from "../src/gltf-pbr-material-operations.js";
import { canonicalJson } from "../src/canonical.js";
import type { TestContext } from "node:test";
const controls:GltfPbrMaterialParameters={materialName:"paint",baseColorFactor:[1,1,1,1],texCoord:0,
  sampler:{magFilter:"linear",minFilter:"linear",wrapS:"repeat",wrapT:"repeat"},alpha:{mode:"MASK",cutoff:.4},
  normalScale:.7,metallicFactor:.8,roughnessFactor:.6,occlusionStrength:.5};
const colors=Buffer.from([13,80,220,0,200,151,31,255]),normals=Buffer.from([128,64,255,255,32,200,240,255]),orm=Buffer.from([255,80,0,255,99,180,35,255]);
async function fixture(t:TestContext) {
  const root=await mkdtemp(path.join(tmpdir(),"gltf-pbr-fixture-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=(await storeAssetObject(root,{bytes:materialGlb(),kind:"scene",mediaType:"model/gltf-binary",metadata:{license:"CC0-1.0",sourceId:"independent.paint"}})).asset;
  const image=async(pixels:Buffer,linear=false)=>(await storeAssetObject(root,{bytes:(linear?encodeLinearRgba8Image:encodeRgba8Image)({width:2,height:1,pixels}),kind:"image",mediaType:linear?LINEAR_RGBA8_IMAGE_MEDIA_TYPE:RGBA8_IMAGE_MEDIA_TYPE})).asset;
  const baseColor=await image(colors),normal=await image(normals),packed=await image(orm,true);
  const material=createAssetRef((await executePbrMaterialBundleOperation(root,{parameters:{normalYAxis:"negative"},inputs:{"base-color":baseColor,normal,orm:packed}})).outputs.output);
  return {root,invocation:{parameters:controls,inputs:{source,material,"base-color":baseColor,normal,orm:packed}},source,material,image};
}
async function decodedPixels(root:string,bytes:Uint8Array) {
  const source=(await storeAssetObject(root,{bytes,kind:"image",mediaType:"image/png"})).asset;
  const decoded=createAssetRef((await executeImageDecodeOperation(root,{inputs:{source}})).outputs.output);
  return parseRgba8Image(await resolveAssetObject(root,decoded)).pixels;
}
async function objects(root:string) {
  const directory=path.join(root,".asset-tooling/objects");
  const snapshot:Record<string,string>={};
  const walk=async(relative:string):Promise<void>=>{for(const entry of await readdir(path.join(directory,relative),{withFileTypes:true})) {const name=path.join(relative,entry.name);if(entry.isDirectory()) await walk(name);else snapshot[name.split(path.sep).join("/")]=(await readFile(path.join(directory,name))).toString("base64");}};
  await walk("");
  return snapshot;
}

test("complete PBR finishing preserves source geometry and unrelated meaning while embedding correct channel bytes",{skip:!codecAvailable},async t=>{
  const {root,invocation,source,material}=await fixture(t),io=new NodeIO().setAllowNetwork(false);
  const before=await io.readBinary(await resolveAssetObject(root,source));
  const build=await createGltfPbrMaterialOperationBuildIdentity(root,invocation);assert.equal(build.operation.id,"scene.material.pbr");assert.equal(build.inputs.material && createAssetRef(build.inputs.material).sha256,material.sha256);
  const result=await executeGltfPbrMaterialOperation(root,invocation),output=createAssetRef(result.outputs.output),after=await io.readBinary(await resolveAssetObject(root,output));
  for(const [i,mesh] of before.getRoot().listMeshes().entries()) for(const [j,primitive] of mesh.listPrimitives().entries()) {
    const next=after.getRoot().listMeshes()[i]!.listPrimitives()[j]!;
    assert.deepEqual(next.getIndices()!.getArray(),primitive.getIndices()!.getArray());assert.deepEqual(next.listSemantics(),primitive.listSemantics());
    for(const key of primitive.listSemantics()) {assert.deepEqual(next.getAttribute(key)!.getArray(),primitive.getAttribute(key)!.getArray());assert.equal(next.getAttribute(key)!.getComponentType(),primitive.getAttribute(key)!.getComponentType());}
  }
  assert.deepEqual(after.getRoot().listNodes().map(n=>[n.getName(),n.getWorldTranslation()]),before.getRoot().listNodes().map(n=>[n.getName(),n.getWorldTranslation()]));
  const paint=after.getRoot().listMaterials()[0]!,keep=after.getRoot().listMaterials()[1]!;
  assert.deepEqual(await decodedPixels(root,paint.getBaseColorTexture()!.getImage()!),colors);
  assert.deepEqual(await decodedPixels(root,paint.getNormalTexture()!.getImage()!),Buffer.from([128,191,255,255,32,55,240,255]));
  assert.deepEqual(await decodedPixels(root,paint.getMetallicRoughnessTexture()!.getImage()!),orm);
  assert.equal(paint.getOcclusionTexture(),paint.getMetallicRoughnessTexture(),"one ORM image supplies both native slots");
  assert.deepEqual([paint.getNormalScale(),paint.getMetallicFactor(),paint.getRoughnessFactor(),paint.getOcclusionStrength(),paint.getAlphaMode(),paint.getAlphaCutoff()],[.7,.8,.6,.5,"MASK",.4]);
  assert.deepEqual(paint.getEmissiveFactor(),[.1,.2,.3]);assert.equal(paint.getDoubleSided(),true);assert.deepEqual(paint.getEmissiveTexture()!.getImage(),before.getRoot().listMaterials()[0]!.getEmissiveTexture()!.getImage());
  assert.deepEqual([keep.getMetallicFactor(),keep.getRoughnessFactor(),keep.getBaseColorTextureInfo()!.getMagFilter(),keep.getBaseColorTextureInfo()!.getWrapS()],[.3,.7,9728,10497]);
  for(const info of [paint.getBaseColorTextureInfo(),paint.getNormalTextureInfo(),paint.getMetallicRoughnessTextureInfo(),paint.getOcclusionTextureInfo()]) assert.deepEqual([info!.getTexCoord(),info!.getMagFilter(),info!.getMinFilter(),info!.getWrapS(),info!.getWrapT()],[0,9729,9729,10497,10497]);
  assert.equal(result.observations.sourceChannelDecodedBytes,24);assert.equal(output.metadata.sourceSha256,source.sha256);assert.equal(output.metadata.materialSha256,material.sha256);
  assert.deepEqual(await resolveAssetObject(root,source),materialGlb());assert.deepEqual(parseRgba8Image(await resolveAssetObject(root,invocation.inputs.normal)).pixels,normals);
  const file=path.join(root,assetObjectPortablePath(output)),mtime=(await stat(file)).mtimeMs;
  assert.deepEqual(await executeGltfPbrMaterialOperation(root,invocation),result);assert.equal((await stat(file)).mtimeMs,mtime);
  const cold=await mkdtemp(path.join(tmpdir(),"gltf-pbr-cold-"));t.after(()=>rm(cold,{recursive:true,force:true}));
  for(const asset of Object.values(invocation.inputs)) await storeAssetObject(cold,{bytes:await resolveAssetObject(root,asset),kind:asset.kind,mediaType:asset.mediaType,metadata:asset.metadata});
  assert.deepEqual(await executeGltfPbrMaterialOperation(cold,invocation),result);
});

test("PBR closure, convention, controls and corrupt dependencies fail before any derived write",{skip:!codecAvailable},async t=>{
  const {root,invocation,material,image}=await fixture(t),before=await objects(root);
  for(const parameters of [{...controls,normalScale:Infinity},{...controls,normalScale:9},{...controls,roughnessFactor:-1},{...controls,texCoord:1},{...controls,materialName:"absent"},{...controls,extra:true}]) await assert.rejects(executeGltfPbrMaterialOperation(root,{...invocation,parameters}));
  assert.deepEqual(await objects(root),before);
  const wrong=await image(Buffer.from([128,128,255,255,128,128,255,255]));const accepted=await objects(root);
  await assert.rejects(executeGltfPbrMaterialOperation(root,{...invocation,inputs:{...invocation.inputs,normal:wrong}}),/bundle reference/);assert.deepEqual(await objects(root),accepted);
  const document=parsePbrMaterialDocument(await resolveAssetObject(root,material));
  assert.throws(()=>parsePbrMaterialDocument(Buffer.from(canonicalJson({...document,conventions:{...document.conventions,normal:{...document.conventions.normal,yAxis:"guess"}}}))),/normal convention/);
  assert.throws(()=>parsePbrMaterialDocument(Buffer.from(canonicalJson({...document,conventions:{...document.conventions,orm:{...document.conventions.orm,green:"metallic"}}}))),/ORM channel/);
  const bad=(await storeAssetObject(root,{bytes:Buffer.from(canonicalJson({...document,textures:{...document.textures,orm:{...document.textures.orm,width:3}}})),kind:material.kind,mediaType:material.mediaType})).asset;
  const pinned=await objects(root);await assert.rejects(executeGltfPbrMaterialOperation(root,{...invocation,inputs:{...invocation.inputs,material:bad}}),/dimensions/);assert.deepEqual(await objects(root),pinned);
  const missing:Partial<typeof invocation.inputs>={...invocation.inputs};delete missing.orm;
  await assert.rejects(executeGltfPbrMaterialOperation(root,{...invocation,inputs:missing}),/missing/);assert.deepEqual(await objects(root),pinned);
  const target=path.join(root,assetObjectPortablePath(invocation.inputs.normal));await writeFile(target,Buffer.alloc(invocation.inputs.normal.byteLength));const corrupt=await objects(root);
  await assert.rejects(executeGltfPbrMaterialOperation(root,invocation),/hash/);assert.deepEqual(await objects(root),corrupt);
});

test("positive-Y normals need no conversion and byte-identical texture roles reuse one native image",{skip:!codecAvailable},async t=>{
  const {root,invocation,image}=await fixture(t),same=await image(Buffer.from([128,128,255,255,128,128,255,255])),linear=await image(Buffer.from([128,128,255,255,128,128,255,255]),true);
  const material=createAssetRef((await executePbrMaterialBundleOperation(root,{inputs:{"base-color":same,normal:same,orm:linear},parameters:{normalYAxis:"positive"}})).outputs.output);
  const result=await executeGltfPbrMaterialOperation(root,{...invocation,inputs:{...invocation.inputs,material,"base-color":same,normal:same,orm:linear}});
  const document=await new NodeIO().readBinary(await resolveAssetObject(root,createAssetRef(result.outputs.output))),paint=document.getRoot().listMaterials()[0]!;
  assert.equal(paint.getBaseColorTexture(),paint.getNormalTexture());assert.equal(paint.getNormalTexture(),paint.getMetallicRoughnessTexture());
  const statistics=result.observations.selectedTextureBytes;assert.ok(statistics && typeof statistics==="object" && !Array.isArray(statistics));assert.equal(statistics.decodedRgba8Bytes,8);
  assert.equal(result.observations.imagesAdded,1);assert.equal(result.observations.imagesReused,2);
  assert.equal(result.observations.sourceNormalYAxis,"positive");assert.deepEqual(await decodedPixels(root,paint.getNormalTexture()!.getImage()!),Buffer.from([128,128,255,255,128,128,255,255]));
  const missingTangent=(await storeAssetObject(root,{bytes:materialGlb({meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1,TEXCOORD_0:2},indices:3,material:0}]}],materials:[{name:"paint"}]}),kind:"scene",mediaType:"model/gltf-binary"})).asset;
  const before=await objects(root);await assert.rejects(executeGltfPbrMaterialOperation(root,{...invocation,inputs:{...invocation.inputs,source:missingTangent}}),/source normals and tangents/);assert.deepEqual(await objects(root),before);
});

test("one roughness edit invalidates the bundle while unrelated encoded maps reconcile and match cold output",{skip:!codecAvailable},async t=>{
  const {root,invocation,image}=await fixture(t),first=await executeGltfPbrMaterialOperation(root,invocation);
  const original=first.observations.encodedTextures;assert.ok(original && typeof original==="object" && !Array.isArray(original));
  const stable=[createAssetRef(original.baseColor),createAssetRef(original.normal)];
  const mtimes=await Promise.all(stable.map(a=>stat(path.join(root,assetObjectPortablePath(a))).then(s=>s.mtimeMs)));
  const changedOrm=await image(Buffer.from([255,150,0,255,99,150,35,255]),true);
  const material=createAssetRef((await executePbrMaterialBundleOperation(root,{parameters:{normalYAxis:"negative"},inputs:{"base-color":invocation.inputs["base-color"],normal:invocation.inputs.normal,orm:changedOrm}})).outputs.output);
  const edit={...invocation,inputs:{...invocation.inputs,material,orm:changedOrm}},changed=await executeGltfPbrMaterialOperation(root,edit);
  assert.notEqual(createAssetRef(changed.outputs.output).sha256,createAssetRef(first.outputs.output).sha256);
  const encoded=changed.observations.encodedTextures;assert.ok(encoded && typeof encoded==="object" && !Array.isArray(encoded));
  assert.deepEqual(createAssetRef(encoded.baseColor),stable[0]);assert.deepEqual(createAssetRef(encoded.normal),stable[1]);assert.notEqual(createAssetRef(encoded.orm).sha256,createAssetRef(original.orm).sha256);
  for(const [i,a] of stable.entries()) assert.equal((await stat(path.join(root,assetObjectPortablePath(a)))).mtimeMs,mtimes[i]);
  const output=await new NodeIO().readBinary(await resolveAssetObject(root,createAssetRef(changed.outputs.output)));
  assert.deepEqual(await decodedPixels(root,output.getRoot().listMaterials()[0]!.getMetallicRoughnessTexture()!.getImage()!),Buffer.from([255,150,0,255,99,150,35,255]));
  const cold=await mkdtemp(path.join(tmpdir(),"gltf-pbr-edit-cold-"));t.after(()=>rm(cold,{recursive:true,force:true}));
  for(const asset of Object.values(edit.inputs)) await storeAssetObject(cold,{bytes:await resolveAssetObject(root,asset),kind:asset.kind,mediaType:asset.mediaType,metadata:asset.metadata});
  assert.deepEqual(await executeGltfPbrMaterialOperation(cold,edit),changed);
  const repeated=await executeGltfPbrMaterialOperation(root,{...edit,inputs:{...edit.inputs,source:createAssetRef(changed.outputs.output)}});
  assert.equal(repeated.observations.imagesAdded,0);assert.equal(repeated.observations.imagesReused,3);assert.equal(createAssetRef(repeated.outputs.output).sha256,createAssetRef(changed.outputs.output).sha256);
});
