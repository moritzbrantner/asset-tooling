import path from "node:path";
import { canonicalJson } from "./canonical.js";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { createAssetOperationBuildIdentity, createAssetOperationDescriptor, createAssetRef, normalizeAssetOperationResult,
  type AssetOperationBuildIdentity, type AssetRef, type CanonicalJsonObject } from "./operations.js";
import { captureToolIdentity } from "./tool.js";
import { encodeRgba8Image, parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE, type Rgba8Image } from "./image-rgba8.js";
import { generateCircleSdfRgba8 } from "./procedural-shapes.js";
import { generateLinearGradientRgba8 } from "./procedural-image.js";
import { levelsRgba8 } from "./image-color.js";
import { convolveRgba8 } from "./image-convolution.js";
import { extractRgba8Channel } from "./image-channels.js";
import { applyMaskRgba8 } from "./image-advanced.js";

export type LeafMaskParameters = { width:number; height:number; radius:number; offset:number; softness:number };
export type MaskColorGradientParameters = { low:readonly [number,number,number]; high:readonly [number,number,number] };
export type LeafArtworkRecipe = LeafMaskParameters & MaskColorGradientParameters & {schemaVersion:1};
export type LeafMaskStep = {build:AssetOperationBuildIdentity; output:AssetRef; observations:CanonicalJsonObject};
type Invocation = {parameters?:unknown; inputs?:unknown};
const maskKeys=["width","height","radius","offset","softness"];
const integerSchema=(minimum:number,maximum:number)=>({type:"integer",minimum,maximum});
const port=(id:string)=>({id,assetKinds:["image"],mediaTypes:[RGBA8_IMAGE_MEDIA_TYPE]});
const rgbSchema={type:"array",minItems:3,maxItems:3,items:integerSchema(0,255)};
export const LEAF_MASK_OPERATION=createAssetOperationDescriptor({
  schemaVersion:1,id:"image.procedural.mask.leaf",version:"1",label:"Compose a leaf alpha mask",category:"procedural.image",
  description:"Compose two softened circle SDF coverages into a vertical lens; the output is opaque grayscale linear coverage.",
  inputs:[],outputs:[port("output")],parameterSchema:{type:"object",additionalProperties:false,required:maskKeys,properties:{
    width:integerSchema(9,256),height:integerSchema(9,256),radius:integerSchema(1,128),offset:integerSchema(0,127),softness:integerSchema(1,16)}}});
export const MASK_COLOR_GRADIENT_OPERATION=createAssetOperationDescriptor({
  schemaVersion:1,id:"image.mask.color-gradient",version:"1",label:"Color a saved alpha mask",category:"texture.material",
  description:"Apply a top-to-bottom sRGB gradient to bounded opaque grayscale coverage, retaining straight alpha and edge RGB.",
  inputs:[port("mask")],outputs:[port("output")],parameterSchema:{type:"object",additionalProperties:false,required:["low","high"],properties:{low:rgbSchema,high:rgbSchema}}});

function object(value:unknown,keys:readonly string[],label:string):Record<string,unknown> {
  if(!value || typeof value!=="object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be a plain object`);
  // Inspect keys only after establishing the JSON object boundary.
  const p=value as Record<string,unknown>;
  if(Object.keys(p).some(key=>!keys.includes(key)) || keys.some(key=>!Object.hasOwn(p,key))) throw new Error(`${label} requires exactly ${keys.join(", ")}`);
  return p;
}
function integer(value:unknown,label:string,min:number,max:number):number {
  if(typeof value!=="number" || !Number.isSafeInteger(value) || value<min || value>max) throw new Error(`${label} must be an integer in ${min}..${max}`);
  return value;
}
export function normalizeLeafMaskParameters(value:unknown):LeafMaskParameters {
  const p=object(value,maskKeys,"leaf mask parameters");
  const width=integer(p.width,"width",9,256),height=integer(p.height,"height",9,256);
  const radius=integer(p.radius,"radius",1,128),offset=integer(p.offset,"offset",0,radius-1),softness=integer(p.softness,"softness",1,16);
  const cx=Math.floor(width/2),cy=Math.floor(height/2);
  if(offset>Math.min(cx,width-1-cx) || radius-offset+softness>Math.min(cx,width-1-cx) || radius+softness>Math.min(cy,height-1-cy)) {
    throw new Error("leaf circles and softened coverage must fit with a transparent outer border");
  }
  return {width,height,radius,offset,softness};
}
function rgb(value:unknown,label:string):[number,number,number] {
  if(!Array.isArray(value) || value.length!==3) throw new Error(`${label} requires three RGB bytes`);
  return [integer(value[0],label,0,255),integer(value[1],label,0,255),integer(value[2],label,0,255)];
}
function colorParameters(value:unknown):MaskColorGradientParameters {
  const p=object(value,["low","high"],"mask color gradient parameters");
  return {low:rgb(p.low,"low"),high:rgb(p.high,"high")};
}
export function normalizeLeafArtworkRecipe(value:unknown):LeafArtworkRecipe {
  const p=object(value,["schemaVersion",...maskKeys,"low","high"],"leaf artwork recipe");
  if(p.schemaVersion!==1) throw new Error("leaf artwork schemaVersion must be 1");
  return {schemaVersion:1,...normalizeLeafMaskParameters(Object.fromEntries(maskKeys.map(key=>[key,p[key]]))),...colorParameters({low:p.low,high:p.high})};
}
function assertRoot(root:string):void {if(typeof root!=="string" || !path.isAbsolute(root)) throw new Error("leaf artwork root must be absolute");}
export async function createLeafMaskBuildIdentity(root:string,{parameters,inputs={}}:Invocation={}):Promise<AssetOperationBuildIdentity> {
  assertRoot(root);
  return createAssetOperationBuildIdentity({operation:LEAF_MASK_OPERATION,parameters:normalizeLeafMaskParameters(parameters),inputs,
    implementation:{id:"builtin.image.procedural.mask.leaf",version:"1",algorithm:"two-circle-coverage-product-v1",randomness:"none",tool:await captureToolIdentity()}});
}
function maskMetadata(p:LeafMaskParameters,build:AssetOperationBuildIdentity):CanonicalJsonObject {
  return {width:p.width,height:p.height,pixelFormat:"rgba8",colorSpace:"srgb",alphaMode:"straight",sampling:"data",channelColorSpace:"linear",
    field:"coverage",scalarEncoding:"unorm8",generator:"image.procedural.mask.leaf@1",parameters:build.parameters,implementation:build.implementation,
    pivot:{x:Math.floor(p.width/2),y:Math.floor(p.height/2)}};
}
const maskObservations=(build:AssetOperationBuildIdentity)=>({parameters:build.parameters,randomness:"none",kernels:["integer-euclidean-circle-sdf-v1","rgb-piecewise-linear-v1","clamp-integer-convolution-v1","straight-alpha-mask-multiply-v1","opaque-grayscale-channel-extract-v1"]});
export async function executeLeafMaskOperation(root:string,invocation:Invocation={}) {
  const build=await createLeafMaskBuildIdentity(root,invocation),p=normalizeLeafMaskParameters(build.parameters);
  const field=(side:number)=>generateCircleSdfRgba8({width:p.width,height:p.height,centerX:Math.floor(p.width/2)+side*p.offset,centerY:Math.floor(p.height/2),radius:p.radius,spread:p.softness});
  const coverage=(side:number)=>convolveRgba8(levelsRgba8(field(side),{blackPoint:128,whitePoint:255}),{width:1,height:1,weights:[-1],divisor:1,bias:255});
  const left=coverage(-1),right=coverage(1);
  const white=levelsRgba8(left,{blackPoint:0,whitePoint:255,outputBlack:255,outputWhite:255});
  const mask=extractRgba8Channel(applyMaskRgba8(applyMaskRgba8(white,left,"luma"),right,"luma"),"alpha");
  const output=(await storeAssetObject(root,{bytes:encodeRgba8Image(mask),kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,metadata:maskMetadata(p,build)})).asset;
  return normalizeAssetOperationResult(LEAF_MASK_OPERATION,{outputs:{output},observations:maskObservations(build)});
}
async function checkedMask(root:string,ref:AssetRef,dimensions?:Pick<Rgba8Image,"width"|"height">) {
  if(ref.kind!=="image" || ref.mediaType!==RGBA8_IMAGE_MEDIA_TYPE || ref.byteLength>400_000) throw new Error("mask must be a canonical RGBA8 image within 400,000 bytes");
  const image=parseRgba8Image(await resolveAssetObject(root,ref),dimensions);
  if(image.width>256 || image.height>256) throw new Error("mask dimensions must not exceed 256");
  for(let i=0;i<image.pixels.length;i+=4) if(image.pixels[i]!==image.pixels[i+1] || image.pixels[i]!==image.pixels[i+2] || image.pixels[i+3]!==255) throw new Error("mask must be opaque grayscale coverage");
  return image;
}
async function checkedColor(root:string,{parameters,inputs={}}:Invocation={}) {
  assertRoot(root);
  const p=colorParameters(parameters);
  const build=createAssetOperationBuildIdentity({operation:MASK_COLOR_GRADIENT_OPERATION,parameters:p,inputs,
    implementation:{id:"builtin.image.mask.color-gradient",version:"1",algorithm:"vertical-srgb-straight-alpha-gradient-v1",randomness:"none",tool:await captureToolIdentity()}});
  const mask=createAssetRef(build.inputs.mask),image=await checkedMask(root,mask);
  return {p,build,mask,image};
}
export async function createMaskColorGradientBuildIdentity(root:string,invocation:Invocation={}):Promise<AssetOperationBuildIdentity> {return (await checkedColor(root,invocation)).build;}
export async function executeMaskColorGradientOperation(root:string,invocation:Invocation={}) {
  const {p,build,mask,image}=await checkedColor(root,invocation);
  const gradient=generateLinearGradientRgba8({width:image.width,height:image.height,direction:"vertical",startColor:[...p.low,255],endColor:[...p.high,255]});
  const pixels=applyMaskRgba8(gradient,image,"luma");
  const output=(await storeAssetObject(root,{bytes:encodeRgba8Image(pixels),kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,
    metadata:{width:image.width,height:image.height,pixelFormat:"rgba8",colorSpace:"srgb",alphaMode:"straight",sampling:"color",channelColorSpace:"srgb",
      generator:"image.mask.color-gradient@1",parameters:build.parameters,implementation:build.implementation,maskSha256:mask.sha256}})).asset;
  return normalizeAssetOperationResult(MASK_COLOR_GRADIENT_OPERATION,{outputs:{output},observations:{parameters:build.parameters,maskSha256:mask.sha256,randomness:"none"}});
}
async function preservedMask(root:string,value:unknown,build:AssetOperationBuildIdentity,p:LeafMaskParameters):Promise<LeafMaskStep> {
  const step=object(value,["build","output","observations"],"preserved leaf mask");
  if(canonicalJson(step.build)!==canonicalJson(build)) throw new Error("preserved leaf mask build does not match current controls; regenerate it");
  const output=createAssetRef(step.output);
  await checkedMask(root,output,p);
  if(canonicalJson(output.metadata)!==canonicalJson(maskMetadata(p,build)) || canonicalJson(step.observations)!==canonicalJson(maskObservations(build))) throw new Error("preserved leaf mask evidence does not match complete producer contract");
  return {build,output,observations:normalizeAssetOperationResult(LEAF_MASK_OPERATION,{outputs:{output},observations:maskObservations(build)}).observations};
}
async function executeRecipe(root:string,value:unknown,options:unknown) {
  assertRoot(root);
  const recipe=normalizeLeafArtworkRecipe(value);
  if(!options || typeof options!=="object" || Array.isArray(options) || ![Object.prototype,null].includes(Object.getPrototypeOf(options))) throw new Error("leaf preservation options must be a plain object");
  if(Object.keys(options).some(key=>key!=="mask")) throw new Error("only the leaf mask can be preserved");
  const maskParameters=normalizeLeafMaskParameters(Object.fromEntries(maskKeys.map(key=>[key,recipe[key as keyof LeafArtworkRecipe]])));
  const build=await createLeafMaskBuildIdentity(root,{parameters:maskParameters});
  let step:LeafMaskStep;
  const reused=Object.hasOwn(options,"mask");
  if(reused) step=await preservedMask(root,"mask" in options?options.mask:undefined,build,maskParameters);
  else {
    const result=await executeLeafMaskOperation(root,{parameters:maskParameters});
    step={build,output:createAssetRef(result.outputs.output),observations:result.observations};
  }
  const colored=await executeMaskColorGradientOperation(root,{parameters:{low:recipe.low,high:recipe.high},inputs:{mask:step.output}});
  return {schemaVersion:1,recipe,outputs:{mask:step.output,image:createAssetRef(colored.outputs.output)},maskStep:step,
    colorBuild:await createMaskColorGradientBuildIdentity(root,{parameters:{low:recipe.low,high:recipe.high},inputs:{mask:step.output}}),
    execution:{executedOperations:reused?1:2,reusedOperations:reused?1:0,maskPixelsGenerated:reused?0:recipe.width*recipe.height,colorPixelsGenerated:recipe.width*recipe.height}};
}
/** Full execution is the independent authoritative replay path; it never reuses a supplied lock. */
export async function executeLeafArtworkRecipe(root:string,value:unknown) {
  const {execution:_execution,...result}=await executeRecipe(root,value,{});
  return result;
}
export async function executePreservedLeafArtworkRecipe(root:string,value:unknown,preserve:{mask?:LeafMaskStep}={}) {return executeRecipe(root,value,preserve);}
const palette={low:Object.freeze([115,158,63] as const),high:Object.freeze([35,72,24] as const)};
const defaults={schemaVersion:1,width:64,height:64,softness:2,...palette} as const;
export const LEAF_ARTWORK_PRESETS=Object.freeze({
  rounded:Object.freeze({...defaults,radius:22,offset:10}),
  slender:Object.freeze({...defaults,radius:26,offset:20}),
  broad:Object.freeze({...defaults,radius:24,offset:6}),
});
