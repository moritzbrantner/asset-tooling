import path from "node:path";
import {resolveAssetObject,storeAssetObject} from "./asset-store.js";
import {createAssetOperationBuildIdentity,createAssetOperationRegistry,createAssetRef,normalizeAssetOperationResult,
  type AssetOperationBuildIdentity} from "./operations.js";
import {captureToolIdentity} from "./tool.js";
import {parseRgba8Image,RGBA8_IMAGE_MEDIA_TYPE} from "./image-rgba8.js";
import {centeredInstanceBounds,createInstanceSet,encodeInstanceSet,parseInstanceSet,INSTANCE_SET_MEDIA_TYPE,
  INSTANCE_SET_ASSET_KIND,INSTANCE_SET_MAX_COORDINATE_MICRO,type InstanceSetBounds} from "./instance-set.js";
import {sampleAxis} from "./instance-image-sampling.js";

export type InstanceExclusionMaskParameters={maxCoverage:number;maskBounds:InstanceSetBounds};
type Invocation={parameters?:unknown;inputs?:unknown};
const registry=createAssetOperationRegistry([{
  schemaVersion:1,id:"instances.filter.exclusion-mask",version:"1",label:"Filter saved detail by an exclusion mask",category:"instances.transform",
  description:"Keep original candidate IDs/order/XYZ when exact nearest-endpoint coverage is at or below the declared threshold; never backfill excluded candidates.",
  inputs:[{id:"source",assetKinds:[INSTANCE_SET_ASSET_KIND],mediaTypes:[INSTANCE_SET_MEDIA_TYPE]},
    {id:"mask",assetKinds:["image"],mediaTypes:[RGBA8_IMAGE_MEDIA_TYPE]}],
  outputs:[{id:"output",assetKinds:[INSTANCE_SET_ASSET_KIND],mediaTypes:[INSTANCE_SET_MEDIA_TYPE]}],
  parameterSchema:{type:"object",additionalProperties:false,required:["maxCoverage","maskBounds"],properties:{maxCoverage:{type:"integer",minimum:0,maximum:255},
    maskBounds:{type:"object",additionalProperties:false,required:["widthMicro","depthMicro"],properties:{
      widthMicro:{type:"integer",minimum:1,maximum:INSTANCE_SET_MAX_COORDINATE_MICRO},depthMicro:{type:"integer",minimum:1,maximum:INSTANCE_SET_MAX_COORDINATE_MICRO}}}}},
}]);
export const INSTANCE_EXCLUSION_MASK_OPERATION=registry.get("instances.filter.exclusion-mask","1")!;

function object(value:unknown,keys:readonly string[],label:string):Record<string,unknown> {
  if(!value || typeof value!=="object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be a plain object`);
  // Inspect the record only after checking the external JSON boundary.
  const p=value as Record<string,unknown>;
  if(Object.keys(p).some(key=>!keys.includes(key)) || keys.some(key=>!Object.hasOwn(p,key))) throw new Error(`${label} requires exactly ${keys.join(", ")}`);
  return p;
}
function integer(value:unknown,label:string,min:number,max:number):number {
  if(typeof value!=="number" || !Number.isSafeInteger(value) || value<min || value>max) throw new Error(`${label} must be an integer in ${min}..${max}`);
  return value;
}
function parameters(value:unknown):InstanceExclusionMaskParameters {
  const p=object(value,["maxCoverage","maskBounds"],"instance exclusion parameters"),bounds=object(p.maskBounds,["widthMicro","depthMicro"],"mask bounds");
  return {maxCoverage:integer(p.maxCoverage,"maxCoverage",0,255),maskBounds:{
    widthMicro:integer(bounds.widthMicro,"mask widthMicro",1,INSTANCE_SET_MAX_COORDINATE_MICRO),
    depthMicro:integer(bounds.depthMicro,"mask depthMicro",1,INSTANCE_SET_MAX_COORDINATE_MICRO)}};
}
async function checked(root:string,{parameters:value,inputs={}}:Invocation={}) {
  if(typeof root!=="string" || !path.isAbsolute(root)) throw new Error("instance exclusion root must be absolute");
  const p=parameters(value);
  const build=createAssetOperationBuildIdentity({operation:INSTANCE_EXCLUSION_MASK_OPERATION,parameters:p,inputs,
    implementation:{id:"builtin.instances.filter.exclusion-mask",version:"1",algorithm:"nearest-endpoint-q8-exclusion-subset-v1",randomness:"none",tool:await captureToolIdentity()}});
  const source=createAssetRef(build.inputs.source),mask=createAssetRef(build.inputs.mask);
  if(mask.metadata.sampling!=="data" || mask.metadata.channelColorSpace!=="linear") throw new Error("exclusion mask must explicitly declare data sampling and linear channelColorSpace");
  if(source.byteLength>2*1024*1024 || mask.byteLength>8*1024*1024) throw new Error("instance exclusion inputs exceed the 2 MiB instance-set / 8 MiB mask budgets");
  const set=parseInstanceSet(await resolveAssetObject(root,source));
  if(set.bounds.widthMicro!==p.maskBounds.widthMicro || set.bounds.depthMicro!==p.maskBounds.depthMicro) throw new Error("declared mask bounds must match the centered source footprint; implicit stretching is unsupported");
  const image=parseRgba8Image(await resolveAssetObject(root,mask));
  if(image.width>4096 || image.height>4096 || image.width*image.height>1_048_576) throw new Error("exclusion mask exceeds the 4096-axis / 1048576-pixel budget");
  for(let i=0;i<image.pixels.length;i+=4) if(image.pixels[i]!==image.pixels[i+1] || image.pixels[i]!==image.pixels[i+2] || image.pixels[i+3]!==255) throw new Error("exclusion mask must be opaque grayscale linear UNORM8 coverage");
  return {p,build,source,mask,set,image};
}
export async function createInstanceExclusionMaskOperationBuildIdentity(root:string,invocation:Invocation={}):Promise<AssetOperationBuildIdentity> {return (await checked(root,invocation)).build;}
export async function executeInstanceExclusionMaskOperation(root:string,invocation:Invocation={}) {
  const {p,source,mask,set,image}=await checked(root,invocation),bounds=centeredInstanceBounds(set.bounds.widthMicro,set.bounds.depthMicro);
  const instances=set.instances.filter(instance=>{
    const x=sampleAxis(instance.positionMicro[0],bounds.minX,set.bounds.widthMicro,image.width);
    const z=sampleAxis(instance.positionMicro[2],bounds.minZ,set.bounds.depthMicro,image.height);
    return image.pixels[(z*image.width+x)*4]!<=p.maxCoverage;
  });
  const output=(await storeAssetObject(root,{kind:INSTANCE_SET_ASSET_KIND,mediaType:INSTANCE_SET_MEDIA_TYPE,bytes:encodeInstanceSet(createInstanceSet({...set,instances})),
    metadata:{schemaVersion:1,coordinateSystem:set.coordinateSystem,coordinateQuantization:set.coordinateQuantization,
      widthMicro:set.bounds.widthMicro,depthMicro:set.bounds.depthMicro,count:instances.length,generator:"instances.filter.exclusion-mask@1",
      sourceInstanceSetSha256:source.sha256,sourceMaskSha256:mask.sha256,parameters:p,sampling:"nearest-endpoints",maskMeaning:"linear-unorm8-exclusion"}})).asset;
  return normalizeAssetOperationResult(INSTANCE_EXCLUSION_MASK_OPERATION,{outputs:{output},observations:{parameters:p,sourceCount:set.instances.length,
    keptCount:instances.length,excludedCount:set.instances.length-instances.length,maskWidth:image.width,maskHeight:image.height,
    coordinateSystem:set.coordinateSystem,coordinateQuantization:set.coordinateQuantization,maskBounds:{...bounds,...p.maskBounds},
    imageX:"positive-x",imageY:"positive-z",sampling:"nearest-endpoints",randomness:"none",candidatesGenerated:0,positionsChanged:0,idsRenumbered:0}});
}
