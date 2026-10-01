/// <reference path="./gltf-validator.d.ts" />
import { readDependencyLockSha256 } from "./dependency-lock.js";
import { NodeIO, VERSION, type Texture } from "@gltf-transform/core";
import { version as validatorVersion } from "gltf-validator";
import path from "node:path";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { sha256Bytes } from "./hash.js";
import { captureToolIdentity } from "./tool.js";
import { createAssetOperationDescriptor, createAssetOperationBuildIdentity, createAssetRef, normalizeAssetOperationResult,
  type AssetRef } from "./operations.js";
import { PBR_MATERIAL_MEDIA_TYPE, parsePbrMaterialDocument } from "./material-operations.js";
import { RGBA8_IMAGE_MEDIA_TYPE, parseRgba8Image, encodeRgba8Image, type Rgba8Image } from "./image-rgba8.js";
import { LINEAR_RGBA8_IMAGE_MEDIA_TYPE, parseLinearRgba8Image } from "./image-linear-rgba8.js";
import { IMAGE_ENCODE_PNG_OPERATION, executeImageEncodePngOperation, probeImageCodecImplementation } from "./image-codec-operations.js";
import { extractRgba8Channel, combineRgba8Channels } from "./image-channels.js";
import { convolveRgba8 } from "./image-convolution.js";
import { GLTF_BASE_COLOR_OPERATION, normalizeGltfBaseColorParameters, selectNamedGltfMaterial, applyGltfTextureInfo,
  type GltfBaseColorParameters } from "./gltf-material-operations.js";
import { checkStaticGltfAccessorBudget, parseCheckedGltfBytes, validateGltf, gltfSummary } from "./gltf-processing.js";

type Invocation = { parameters?:unknown; inputs?:unknown; runtime?:unknown };
export type GltfPbrMaterialParameters = GltfBaseColorParameters & {normalScale:number;metallicFactor:number;roughnessFactor:number;occlusionStrength:number};
const ROLES = ["baseColor","normal","orm"] as const;
type Role = typeof ROLES[number];
const EXTRA = ["normalScale","metallicFactor","roughnessFactor","occlusionStrength"];
const UNIT = {type:"number",minimum:0,maximum:1};
const baseSchema=GLTF_BASE_COLOR_OPERATION.parameterSchema;
export const GLTF_PBR_MATERIAL_OPERATION = createAssetOperationDescriptor({
  schemaVersion:1,id:"scene.material.pbr",version:"1",label:"Apply an existing complete PBR texture set",category:"material.composition",
  inputs:[{id:"source",assetKinds:["scene","mesh"],mediaTypes:["model/gltf-binary"]},
    {id:"material",assetKinds:["material"],mediaTypes:[PBR_MATERIAL_MEDIA_TYPE]},
    {id:"base-color",assetKinds:["image"],mediaTypes:[RGBA8_IMAGE_MEDIA_TYPE]},
    {id:"normal",assetKinds:["image"],mediaTypes:[RGBA8_IMAGE_MEDIA_TYPE]},
    {id:"orm",assetKinds:["image"],mediaTypes:[LINEAR_RGBA8_IMAGE_MEDIA_TYPE]}],
  outputs:[{id:"output",assetKinds:["scene","mesh"],mediaTypes:["model/gltf-binary"]}],
  parameterSchema:{...baseSchema,required:["materialName","baseColorFactor","texCoord","sampler","alpha",...EXTRA],
    properties:{...baseSchema.properties as Record<string,unknown>,texCoord:{type:"integer",const:0},normalScale:{type:"number",minimum:0,maximum:8},metallicFactor:UNIT,roughnessFactor:UNIT,occlusionStrength:UNIT}},
});
function parameters(value:unknown):GltfPbrMaterialParameters {
  if(!value || typeof value!=="object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error("PBR parameters must be an object");
  const raw=value as Record<string,unknown>,base=Object.fromEntries(Object.entries(raw).filter(([key])=>!EXTRA.includes(key)));
  const p=normalizeGltfBaseColorParameters(base);
  if(p.texCoord!==0) throw new Error("PBR profile requires authored UV0 tangents and texCoord 0");
  const scalar=(key:string,max:number)=>{const n=raw[key];if(typeof n!=="number" || !Number.isFinite(n) || n<0 || n>max) throw new Error(`${key} must be finite in 0..${max}`);return n;};
  return {...p,normalScale:scalar("normalScale",8),metallicFactor:scalar("metallicFactor",1),roughnessFactor:scalar("roughnessFactor",1),occlusionStrength:scalar("occlusionStrength",1)};
}
async function checked(root:string,invocation:Invocation) {
  if(typeof root!=="string" || !path.isAbsolute(root)) throw new Error("PBR root must be absolute");
  const p=parameters(invocation.parameters);
  const codec=await probeImageCodecImplementation(IMAGE_ENCODE_PNG_OPERATION,invocation.runtime??{});
  const build=createAssetOperationBuildIdentity({operation:GLTF_PBR_MATERIAL_OPERATION,parameters:p,inputs:invocation.inputs??{},
    implementation:{id:"gltf-transform-pbr-bundle",version:"1",gltfTransform:VERSION,validator:validatorVersion(),pngCodec:codec.implementation,
      dependencyLockSha256:await readDependencyLockSha256(),tool:await captureToolIdentity()}});
  const source=createAssetRef(build.inputs.source),bundle=createAssetRef(build.inputs.material);
  if(source.byteLength>64*1024*1024 || bundle.byteLength>8*1024*1024) throw new Error("PBR source/material exceeds byte budget");
  const doc=parsePbrMaterialDocument(await resolveAssetObject(root,bundle));
  const refs:Record<Role,AssetRef>={baseColor:createAssetRef(build.inputs["base-color"]),normal:createAssetRef(build.inputs.normal),orm:createAssetRef(build.inputs.orm)};
  let pixels=0;
  for(const role of ROLES) {
    const declared=doc.textures[role],ref=refs[role];
    if(!declared || ref.sha256!==declared.sha256 || ref.byteLength!==declared.byteLength || ref.mediaType!==declared.mediaType) throw new Error(`PBR ${role} must match its complete bundle reference`);
    if(declared.width>4096 || declared.height>4096 || ref.byteLength>128*1024*1024) throw new Error("PBR texture exceeds dimension/encoded-byte budget");
    pixels+=declared.width*declared.height;
  }
  if(pixels>16777216) throw new Error("PBR textures exceed total decoded pixel budget (16777216)");
  const sourceBytes=await resolveAssetObject(root,source);
  const {json}=await new NodeIO().setAllowNetwork(false).setStrictResources(true).binaryToJSON(sourceBytes);
  checkStaticGltfAccessorBudget(json,"PBR");
  const imported=await parseCheckedGltfBytes(source,sourceBytes,Object.create(null),false);
  const selected=selectNamedGltfMaterial(imported.document,p.materialName,p.texCoord);
  if(selected.material.getNormalTextureInfo() && selected.material.getNormalTextureInfo()!.getTexCoord()!==0) throw new Error("PBR source normal texture must use its authored UV0 tangent frame");
  if(selected.primitives.some(primitive=>!primitive.getAttribute("NORMAL") || !primitive.getAttribute("TANGENT"))) throw new Error("PBR normal texture requires authored source normals and tangents");
  // The budgeted bundle dimensions must match native headers before pixel allocation.
  const images:Record<Role,Rgba8Image>={baseColor:parseRgba8Image(await resolveAssetObject(root,refs.baseColor),doc.textures.baseColor!),
    normal:parseRgba8Image(await resolveAssetObject(root,refs.normal),doc.textures.normal!),orm:parseLinearRgba8Image(await resolveAssetObject(root,refs.orm),doc.textures.orm!)};
  for(const role of ROLES) {
    const image=images[role];
    // Normal and ORM alpha are unused data, never coverage.
    if(role!=="baseColor") for(let i=3;i<image.pixels.length;i+=4) if(image.pixels[i]!==255) throw new Error("PBR data channels must be opaque");
  }
  return {p,build,codec,source,bundle,doc,refs,images,...imported,...selected};
}
export async function createGltfPbrMaterialOperationBuildIdentity(root:string,invocation:Invocation={}) {return (await checked(root,invocation)).build;}
export async function executeGltfPbrMaterialOperation(root:string,invocation:Invocation={}) {
  const prepared=await checked(root,invocation),{p,source,bundle,refs,images,doc,document,io,material,primitives,build}=prepared;
  const encoded:Partial<Record<Role,AssetRef>>={},textures:Partial<Record<Role,Texture>>={};
  let imagesAdded=0,imagesReused=0;
  for(const role of ROLES) {
    let input=refs[role];
    if(role==="normal") {
      const axis=doc.conventions.normal!.yAxis;
      switch(axis) {
        case "negative": {
          const image=images.normal,green=convolveRgba8(extractRgba8Channel(image,"green"),{width:1,height:1,weights:[-1],divisor:1,bias:255});
          const positive=combineRgba8Channels({red:extractRgba8Channel(image,"red"),green,blue:extractRgba8Channel(image,"blue"),alpha:extractRgba8Channel(image,"alpha")});
          input=(await storeAssetObject(root,{bytes:encodeRgba8Image(positive),kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,
            metadata:{operation:"scene.material.pbr",sourceSha256:refs.normal.sha256,materialSha256:bundle.sha256,normalYAxis:"positive",channelColorSpace:"linear"}})).asset;
          break;
        }
        case "positive": break;
        default: {const unreachable:never=axis;throw new Error(`Unsupported normal axis: ${unreachable}`);}
      }
    }
    const png=createAssetRef((await executeImageEncodePngOperation(root,{inputs:{source:input},parameters:{compressionLevel:9},runtime:prepared.codec.runtime})).outputs.output);
    const bytes=await resolveAssetObject(root,png);encoded[role]=png;
    const existing=document.getRoot().listTextures().find(t=>t.getMimeType()==="image/png" && t.getImage() && sha256Bytes(t.getImage()!)===png.sha256);
    if(existing) {textures[role]=existing;imagesReused++;} else {textures[role]=document.createTexture(role).setMimeType("image/png").setImage(bytes);imagesAdded++;}
  }
  material.setBaseColorTexture(textures.baseColor!).setBaseColorFactor(p.baseColorFactor).setAlphaMode(p.alpha.mode).setAlphaCutoff(p.alpha.mode==="MASK"?p.alpha.cutoff:.5)
    .setNormalTexture(textures.normal!).setNormalScale(p.normalScale).setMetallicRoughnessTexture(textures.orm!).setMetallicFactor(p.metallicFactor).setRoughnessFactor(p.roughnessFactor)
    .setOcclusionTexture(textures.orm!).setOcclusionStrength(p.occlusionStrength);
  for(const info of [material.getBaseColorTextureInfo(),material.getNormalTextureInfo(),material.getMetallicRoughnessTextureInfo(),material.getOcclusionTextureInfo()]) applyGltfTextureInfo(info!,p);
  const bytes=await io.writeBinary(document);await validateGltf(bytes,"glb",Object.create(null),"scene.material.pbr output");
  const output=(await storeAssetObject(root,{bytes,kind:source.kind,mediaType:"model/gltf-binary",metadata:{operation:"scene.material.pbr",sourceSha256:source.sha256,materialSha256:bundle.sha256,
    textureSources:ROLES.map(role=>({role,sha256:refs[role].sha256})),materialName:p.materialName,normalYAxis:"positive",ormChannels:{red:"ambient-occlusion",green:"roughness",blue:"metallic"}}})).asset;
  return normalizeAssetOperationResult(GLTF_PBR_MATERIAL_OPERATION,{outputs:{output},observations:{build,...gltfSummary(document),affectedPrimitives:primitives.length,
    encodedTextures:encoded,sourceNormalYAxis:doc.conventions.normal!.yAxis,normalYAxis:"positive",texturePixels:ROLES.map(role=>({role,width:images[role].width,height:images[role].height})),
    pngEncodesExecuted:3,imagesAdded,imagesReused,selectedTextureBytes:selectedTextureBytes(encoded,images),sourceChannelDecodedBytes:ROLES.reduce((sum,role)=>sum+images[role].pixels.byteLength,0),parameters:p}});
}
function selectedTextureBytes(encoded:Partial<Record<Role,AssetRef>>,images:Record<Role,Rgba8Image>) {
  const seen=new Set<string>();let encodedBytes=0,decodedRgba8Bytes=0;
  for(const role of ROLES) {const ref=encoded[role]!;if(!seen.has(ref.sha256)) {seen.add(ref.sha256);encodedBytes+=ref.byteLength;decodedRgba8Bytes+=images[role].pixels.byteLength;}}
  return {uniqueImages:seen.size,encodedBytes,decodedRgba8Bytes};
}
