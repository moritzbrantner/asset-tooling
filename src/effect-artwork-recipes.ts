import path from "node:path";
import { storeAssetObject } from "./asset-store.js";
import { createAssetOperationBuildIdentity, createAssetOperationRegistry, normalizeAssetOperationResult, type AssetOperationBuildIdentity, type AssetRef, type CanonicalJsonObject } from "./operations.js";
import { captureToolIdentity } from "./tool.js";
import { encodeRgba8Image, RGBA8_IMAGE_MEDIA_TYPE, type Rgba8Image } from "./image-rgba8.js";
import { generateCircleSdfRgba8 } from "./procedural-shapes.js";
import { levelsRgba8 } from "./image-color.js";
import { convolveRgba8 } from "./image-convolution.js";
import { combineRgba8Channels, extractRgba8Channel } from "./image-channels.js";
import { applyMaskRgba8 } from "./image-advanced.js";

type CommonArtworkParameters = { width:number; height:number; centerX:number; centerY:number; radius:number; softness:number; color:readonly [number,number,number]; opacity:number };
export type EffectArtworkParameters = CommonArtworkParameters & ({shape:"puff"} | {shape:"ring";stroke:number});
type Invocation = { parameters?:unknown; inputs?:unknown };
const commonKeys = ["shape","width","height","centerX","centerY","radius","softness","color","opacity"];
const integerSchema = (minimum:number,maximum:number) => ({type:"integer",minimum,maximum});
const port = (id:string) => ({id,assetKinds:["image"],mediaTypes:[RGBA8_IMAGE_MEDIA_TYPE]});
const registry = createAssetOperationRegistry([{
  schemaVersion:1, id:"image.procedural.effect-artwork", version:"1", label:"Generate static puff or ring artwork", category:"procedural.image",
  description:"Compose existing circle SDF, levels, convolution, channel and mask kernels into bounded straight-alpha effect ingredients.",
  inputs:[],outputs:[port("image"),port("mask")],
  parameterSchema:{type:"object",additionalProperties:false,required:commonKeys,properties:{
    shape:{type:"string",enum:["puff","ring"]},width:integerSchema(9,256),height:integerSchema(9,256),
    centerX:integerSchema(0,255),centerY:integerSchema(0,255),radius:integerSchema(1,128),softness:integerSchema(1,64),
    color:{type:"array",minItems:3,maxItems:3,items:integerSchema(0,255)},opacity:integerSchema(0,255),stroke:integerSchema(1,128),
  },oneOf:[{properties:{shape:{const:"puff"}},not:{required:["stroke"]}},{properties:{shape:{const:"ring"}},required:["stroke"]}]},
}]);
export const EFFECT_ARTWORK_OPERATION = registry.get("image.procedural.effect-artwork","1")!;

function integer(value:unknown,name:string,min:number,max:number):number {
  if(typeof value!=="number" || !Number.isSafeInteger(value) || value<min || value>max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return value;
}
export function normalizeEffectArtworkParameters(value:unknown):EffectArtworkParameters {
  if(!value || typeof value!=="object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error("effect artwork parameters must be a plain object");
  const p=value as Record<string,unknown>;
  if(p.shape!=="puff" && p.shape!=="ring") throw new Error("shape must be puff or ring");
  const keys=p.shape==="ring"?[...commonKeys,"stroke"]:commonKeys;
  for(const key of Object.keys(p)) if(!keys.includes(key)) throw new Error(`effect artwork contains unknown field '${key}'`);
  for(const key of keys) if(!Object.hasOwn(p,key)) throw new Error(`effect artwork is missing '${key}'`);
  const width=integer(p.width,"width",9,256),height=integer(p.height,"height",9,256);
  const centerX=integer(p.centerX,"centerX",0,width-1),centerY=integer(p.centerY,"centerY",0,height-1);
  const radius=integer(p.radius,"radius",1,128),softness=integer(p.softness,"softness",1,64);
  if(radius+softness>Math.min(centerX,centerY,width-1-centerX,height-1-centerY)) throw new Error("radius plus softness must fit with a transparent outer border");
  if(!Array.isArray(p.color) || p.color.length!==3) throw new Error("color must contain three RGB bytes");
  const color: [number,number,number]=[integer(p.color[0],"color[0]",0,255),integer(p.color[1],"color[1]",0,255),integer(p.color[2],"color[2]",0,255)];
  const common={width,height,centerX,centerY,radius,softness,color,opacity:integer(p.opacity,"opacity",0,255)};
  if(p.shape==="puff") return {shape:"puff",...common};
  const stroke=integer(p.stroke,"stroke",1,radius-1);
  if(radius-stroke<softness) throw new Error("ring inner radius must be at least softness to keep its center transparent");
  return {shape:"ring",...common,stroke};
}
function assertRoot(root:string):void { if(typeof root!=="string" || !path.isAbsolute(root)) throw new Error("effect artwork root must be an absolute path"); }
export async function createEffectArtworkBuildIdentity(root:string,{parameters,inputs={}}:Invocation={}):Promise<AssetOperationBuildIdentity> {
  assertRoot(root);
  return createAssetOperationBuildIdentity({operation:EFFECT_ARTWORK_OPERATION,parameters:normalizeEffectArtworkParameters(parameters),inputs,
    implementation:{id:"builtin.image.procedural.effect-artwork",version:"1",algorithm:"circle-sdf-alpha-ingredient-composition-v1",randomness:"none",tool:await captureToolIdentity()}});
}
function artwork(p:EffectArtworkParameters):{image:Rgba8Image;mask:Rgba8Image} {
  const shape={width:p.width,height:p.height,centerX:p.centerX,centerY:p.centerY,radius:p.radius,spread:p.softness};
  const field=generateCircleSdfRgba8(shape);
  const outer=convolveRgba8(levelsRgba8(field,{blackPoint:128,whitePoint:255}),{width:1,height:1,weights:[-1],divisor:1,bias:255});
  const constant=(value:number) => levelsRgba8(field,{blackPoint:0,whitePoint:255,outputBlack:value,outputWhite:value});
  let image=applyMaskRgba8(combineRgba8Channels({red:constant(p.color[0]),green:constant(p.color[1]),blue:constant(p.color[2]),alpha:constant(p.opacity)}),outer,"luma");
  switch(p.shape) {
    case "puff": break;
    case "ring": {
      const inner=generateCircleSdfRgba8({...shape,radius:p.radius-p.stroke});
      image=applyMaskRgba8(image,levelsRgba8(inner,{blackPoint:1,whitePoint:128}),"luma");
      break;
    }
    default: {
      const unreachable:never=p;
      throw new Error(`unsupported artwork '${unreachable}'`);
    }
  }
  return {image,mask:extractRgba8Channel(image,"alpha")};
}
export async function executeEffectArtwork(root:string,invocation:Invocation={}) {
  const build=await createEffectArtworkBuildIdentity(root,invocation);
  const p=normalizeEffectArtworkParameters(build.parameters),pixels=artwork(p);
  const outputs: Record<string,AssetRef>={};
  for(const key of ["image","mask"] as const) {
    const metadata:CanonicalJsonObject={width:p.width,height:p.height,pixelFormat:"rgba8",colorSpace:"srgb",alphaMode:"straight",generator:"image.procedural.effect-artwork@1",
      parameters:build.parameters,implementation:build.implementation,shape:p.shape,pivot:{x:p.centerX,y:p.centerY},sampling:key==="mask"?"data":"color",channelColorSpace:key==="mask"?"linear":"srgb"};
    outputs[key]=(await storeAssetObject(root,{bytes:encodeRgba8Image(pixels[key]),kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,metadata})).asset;
  }
  return normalizeAssetOperationResult(EFFECT_ARTWORK_OPERATION,{outputs,observations:{parameters:build.parameters,randomness:"none",static:true,
    kernels:["integer-euclidean-circle-sdf-v1","rgb-piecewise-linear-v1","clamp-integer-convolution-v1","luma-channel-combine-v1","straight-alpha-mask-multiply-v1","opaque-grayscale-channel-extract-v1"]}});
}
const base={width:64,height:64,centerX:32,centerY:32,color:Object.freeze([255,210,112] as const)};
const puff={shape:"puff",...base,radius:4,softness:20} as const;
const ring={shape:"ring",...base,radius:22,softness:3,stroke:4} as const;
export const EFFECT_ARTWORK_PRESETS=Object.freeze({
  puff:Object.freeze({subtle:Object.freeze({...puff,opacity:96}),strong:Object.freeze({...puff,opacity:255}),off:Object.freeze({...puff,opacity:0})}),
  ring:Object.freeze({subtle:Object.freeze({...ring,opacity:96}),strong:Object.freeze({...ring,opacity:255}),off:Object.freeze({...ring,opacity:0})}),
});
