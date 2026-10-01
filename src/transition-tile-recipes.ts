import path from "node:path";
import {canonicalJson} from "./canonical.js";
import {storeAssetObject} from "./asset-store.js";
import {createAssetOperationBuildIdentity,createAssetOperationRegistry,createAssetRef,parseAssetRef,normalizeAssetOperationResult,
 type AssetRef,type AssetOperationBuildIdentity,type CanonicalJsonObject} from "./operations.js";
import {captureToolIdentity,type ToolIdentity} from "./tool.js";
import {encodeRgba8Image,RGBA8_IMAGE_MEDIA_TYPE,type Rgba8Image} from "./image-rgba8.js";
import {generateCircleSdfRgba8} from "./procedural-shapes.js";
import {levelsRgba8} from "./image-color.js";
import {convolveRgba8} from "./image-convolution.js";
import {applyMaskRgba8} from "./image-advanced.js";
import {combineRgba8Channels,extractRgba8Channel} from "./image-channels.js";

type Rgb=readonly [number,number,number];
export type TransitionTileRecipe={schemaVersion:1;size:number;soil:Rgb;grass:Rgb};
export type TransitionTileParameters=TransitionTileRecipe & {corners:string};
export type TransitionEdge="north"|"east"|"south"|"west";
export type TransitionTileConnection={schemaVersion:1;family:"grass-soil-corners-v1";id:string;corners:string;
 axes:"right-down";unit:"cell";origin:[0,0];dimensions:{pixels:[number,number];cells:[1,1]};
 ports:Record<TransitionEdge,string>;allowedRotations:[0,1,2,3];mirroring:false;palette:{soil:[number,number,number];grass:[number,number,number]}};
export type TransitionTileResult={corners:string;build:AssetOperationBuildIdentity;image:AssetRef;observations:CanonicalJsonObject};
type Invocation={parameters?:unknown;inputs?:unknown};
const recipeKeys=["schemaVersion","size","soil","grass"];
const allCorners=Object.freeze(Array.from({length:16},(_,i)=>i.toString(2).padStart(4,"0")));
const byteSchema={type:"integer",minimum:0,maximum:255};
const rgbSchema={type:"array",minItems:3,maxItems:3,items:byteSchema};
const registry=createAssetOperationRegistry([{
 schemaVersion:1,id:"image.procedural.transition-tile",version:"1",category:"procedural.image",label:"Generate a grass/soil corner tile",
 description:"Compose existing corner SDFs and mask/color kernels into one opaque square tile with ordered family-owned edge ports.",
 inputs:[],outputs:[{id:"image",assetKinds:["image"],mediaTypes:[RGBA8_IMAGE_MEDIA_TYPE]}],
 parameterSchema:{type:"object",additionalProperties:false,required:[...recipeKeys,"corners"],properties:{
  schemaVersion:{const:1},size:{type:"integer",minimum:17,maximum:128},soil:rgbSchema,grass:rgbSchema,corners:{type:"string",pattern:"^[01]{4}$"}}},
}]);
export const TRANSITION_TILE_OPERATION=registry.get("image.procedural.transition-tile","1")!;

function object(value:unknown,keys:readonly string[],label:string):Record<string,unknown> {
 if(!value || typeof value!=="object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be a plain object`);
 // The external JSON boundary has established a plain record.
 const p=value as Record<string,unknown>;
 if(Object.keys(p).some(k=>!keys.includes(k)) || keys.some(k=>!Object.hasOwn(p,k))) throw new Error(`${label} requires exactly ${keys.join(", ")}`);
 return p;
}
function integer(value:unknown,label:string,min:number,max:number):number {
 if(typeof value!=="number" || !Number.isSafeInteger(value) || value<min || value>max) throw new Error(`${label} must be an integer in ${min}..${max}`);
 return value;
}
function rgb(value:unknown,label:string):Rgb {
 if(!Array.isArray(value) || value.length!==3) throw new Error(`${label} requires three RGB bytes`);
 return [integer(value[0],label,0,255),integer(value[1],label,0,255),integer(value[2],label,0,255)];
}
function corners(value:unknown):string {
 if(typeof value!=="string" || !/^[01]{4}$/.test(value)) throw new Error("corners must be four soil=0/grass=1 bits in NW,NE,SE,SW order");
 return value;
}
export function normalizeTransitionTileRecipe(value:unknown):TransitionTileRecipe {
 const p=object(value,recipeKeys,"transition tile recipe");
 if(p.schemaVersion!==1) throw new Error("transition tile schemaVersion must be 1");
 const recipe:TransitionTileRecipe={schemaVersion:1,size:integer(p.size,"tile size",17,128),soil:rgb(p.soil,"soil"),grass:rgb(p.grass,"grass")};
 if(canonicalJson(recipe.soil)===canonicalJson(recipe.grass)) throw new Error("soil and grass must have distinct colors");
 return recipe;
}
function parameters(value:unknown):TransitionTileParameters {
 const p=object(value,[...recipeKeys,"corners"],"transition tile parameters");
 return {...normalizeTransitionTileRecipe(Object.fromEntries(recipeKeys.map(k=>[k,p[k]]))),corners:corners(p.corners)};
}
function connection(p:TransitionTileParameters):TransitionTileConnection {
 const [nw,ne,se,sw]=p.corners;
 return {schemaVersion:1,family:"grass-soil-corners-v1",id:`corners.${p.corners}`,corners:p.corners,axes:"right-down",unit:"cell",origin:[0,0],
  dimensions:{pixels:[p.size,p.size],cells:[1,1]},ports:{north:`${nw}${ne}`,east:`${ne}${se}`,south:`${sw}${se}`,west:`${nw}${sw}`},
  allowedRotations:[0,1,2,3],mirroring:false,palette:{soil:[...p.soil],grass:[...p.grass]}};
}
/** Read the original sprite source ref preserved by the atlas/bundle; never infer ports from packing rectangles. */
export function readTransitionTileConnection(value:unknown):TransitionTileConnection {
 return connectionForRef(parseAssetRef(value));
}
function connectionForRef(ref:AssetRef):TransitionTileConnection {
 if(ref.kind!=="image" || ref.mediaType!==RGBA8_IMAGE_MEDIA_TYPE) throw new Error("connection requires the original canonical RGBA8 sprite ref");
 const c=object(ref.metadata.connection,["schemaVersion","family","id","corners","axes","unit","origin","dimensions","ports","allowedRotations","mirroring","palette"],"transition connection");
 const d=object(c.dimensions,["pixels","cells"],"connection dimensions"),palette=object(c.palette,["soil","grass"],"connection palette");
 if(!Array.isArray(d.pixels) || d.pixels.length!==2) throw new Error("connection dimensions require two pixel axes");
 const expected=connection({...normalizeTransitionTileRecipe({schemaVersion:1,size:d.pixels[0],...palette}),corners:corners(c.corners)});
 // All derived ports, orientation permissions, origin and normalized dimensions have one family owner.
 if(canonicalJson(c)!==canonicalJson(expected) || ref.metadata.width!==expected.dimensions.pixels[0] || ref.metadata.height!==expected.dimensions.pixels[1]) throw new Error("transition connection has invalid ports, identity, dimensions, units, origin or orientation permissions");
 return expected;
}
export function transformTransitionCorners(value:unknown,options:unknown):string {
 const c=corners(value),p=object(options,["quarterTurns","mirror"],"transition orientation");
 if(p.mirror!==false) throw new Error("transition tile mirroring is unsupported");
 const q=integer(p.quarterTurns,"quarterTurns",0,3);
 return c.slice(4-q)+c.slice(0,4-q);
}
const opposite:Record<TransitionEdge,TransitionEdge>={north:"south",east:"west",south:"north",west:"east"};
export function canConnectTransitionTiles(first:unknown,second:unknown,direction:TransitionEdge):boolean {
 if(!Object.hasOwn(opposite,direction)) throw new Error("connection direction must be north, east, south or west");
 const a=readTransitionTileConnection(first),b=readTransitionTileConnection(second);
 return canonicalJson(a.dimensions)===canonicalJson(b.dimensions) && canonicalJson(a.palette)===canonicalJson(b.palette) && a.ports[direction]===b.ports[opposite[direction]];
}
/** Bounded selected-family lookup diagnoses absent combinations and duplicate logical IDs. */
export function findTransitionTile(values:readonly unknown[],wanted:unknown):AssetRef {
 const target=corners(wanted);
 if(!Array.isArray(values) || values.length<1 || values.length>16) throw new Error("selected transition family requires 1..16 sprites");
 const refs=values.map(parseAssetRef),connections=refs.map(connectionForRef),seen=new Set<string>();
 for(const c of connections) {
  if(seen.has(c.id)) throw new Error(`duplicate transition piece '${c.id}'`);
  seen.add(c.id);
  if(canonicalJson(c.palette)!==canonicalJson(connections[0]!.palette) || canonicalJson(c.dimensions)!==canonicalJson(connections[0]!.dimensions)) throw new Error("selected transition family has incompatible dimensions or palette");
 }
 const index=connections.findIndex(c=>c.corners===target);
 if(index<0) throw new Error(`selected transition family is missing combination '${target}'`);
 return refs[index]!;
}
function assertRoot(root:string):void {if(typeof root!=="string" || !path.isAbsolute(root)) throw new Error("transition tile root must be absolute");}
function buildFor(p:TransitionTileParameters,inputs:unknown,tool:ToolIdentity):AssetOperationBuildIdentity {
 return createAssetOperationBuildIdentity({operation:TRANSITION_TILE_OPERATION,parameters:p,inputs,
  implementation:{id:"builtin.image.procedural.transition-tile",version:"1",algorithm:"corner-sdf-complement-product-srgb-v1",randomness:"none",tool}});
}
async function prepare(root:string,{parameters:value,inputs={}}:Invocation={}) {
 assertRoot(root);
 const p=parameters(value);
 const build=buildFor(p,inputs,await captureToolIdentity());
 return {p,build};
}
export async function createTransitionTileBuildIdentity(root:string,invocation:Invocation={}):Promise<AssetOperationBuildIdentity> {
 return (await prepare(root,invocation)).build;
}
function invert(image:Rgba8Image):Rgba8Image {return convolveRgba8(image,{width:1,height:1,weights:[-1],divisor:1,bias:255});}
function tilePixels(p:TransitionTileParameters):Rgba8Image {
 const side=p.size-1,radius=Math.floor(3*side/4),spread=Math.max(1,Math.floor(side/32));
 const centers:readonly (readonly [number,number])[]=[[0,0],[side,0],[side,side],[0,side]];
 const fields=centers.map(([centerX,centerY])=>generateCircleSdfRgba8({width:p.size,height:p.size,centerX,centerY,radius,spread}));
 const white=levelsRgba8(fields[0]!,{blackPoint:0,whitePoint:255,outputBlack:255,outputWhite:255});
 let complement=white;
 for(let i=0;i<4;i++) {
  if(p.corners[i]==="1") complement=applyMaskRgba8(complement,levelsRgba8(fields[i]!,{blackPoint:128,whitePoint:255}),"luma");
 }
 const coverage=invert(extractRgba8Channel(complement,"alpha"));
 const channel=(i:0|1|2)=>{
  const soil=p.soil[i],grass=p.grass[i];
  if(soil<=grass) return levelsRgba8(coverage,{blackPoint:0,whitePoint:255,outputBlack:soil,outputWhite:grass});
  return levelsRgba8(invert(coverage),{blackPoint:0,whitePoint:255,outputBlack:grass,outputWhite:soil});
 };
 return combineRgba8Channels({red:channel(0),green:channel(1),blue:channel(2),alpha:white});
}
async function executePrepared(root:string,{p,build}:Awaited<ReturnType<typeof prepare>>) {
 const stored=await storeAssetObject(root,{kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,bytes:encodeRgba8Image(tilePixels(p)),
  metadata:{width:p.size,height:p.size,pixelFormat:"rgba8",colorSpace:"srgb",alphaMode:"straight",sampling:"color",channelColorSpace:"srgb",
   generator:"image.procedural.transition-tile@1",parameters:build.parameters,implementation:build.implementation,connection:connection(p)}});
 const result=normalizeAssetOperationResult(TRANSITION_TILE_OPERATION,{outputs:{image:stored.asset},observations:{randomness:"none",opaque:true,
  pixels:p.size*p.size,sdfFields:4,kernels:["integer-euclidean-circle-sdf-v1","rgb-piecewise-linear-v1","clamp-integer-convolution-v1","straight-alpha-mask-multiply-v1","opaque-grayscale-channel-extract-v1","luma-channel-combine-v1"]}});
 return {result,stored};
}
export async function executeTransitionTileOperation(root:string,invocation:Invocation={}) {
 return (await executePrepared(root,await prepare(root,invocation))).result;
}
/** Replays selected original tiles only; atlas layout and game placement are separate existing owners. */
export async function executeTransitionTileKit(root:string,value:unknown,{corners:selection=allCorners,signal}:{corners?:unknown;signal?:AbortSignal}={}) {
 assertRoot(root);signal?.throwIfAborted();
 const recipe=normalizeTransitionTileRecipe(value);
 if(!Array.isArray(selection) || selection.length<1 || selection.length>16) throw new Error("transition selection requires 1..16 corner combinations");
 const selected=selection.map(corners).sort();
 if(new Set(selected).size!==selected.length) throw new Error("duplicate selected transition piece");
 const tiles:TransitionTileResult[]=[];
 let objectWrites=0,objectBytesWritten=0;
 const tool=await captureToolIdentity();
 for(const c of selected) {
  signal?.throwIfAborted();
  const p:TransitionTileParameters={...recipe,corners:c},prepared={p,build:buildFor(p,{},tool)};
  signal?.throwIfAborted();
  const {result,stored}=await executePrepared(root,prepared);
  signal?.throwIfAborted();
  tiles.push({corners:c,build:prepared.build,image:createAssetRef(result.outputs.image),observations:result.observations});
  if(stored.status==="changed") {objectWrites++;objectBytesWritten+=stored.asset.byteLength;}
 }
 return {schemaVersion:1,recipe,tiles,execution:{tileOperations:tiles.length,pixelsGenerated:tiles.length*recipe.size*recipe.size,objectWrites,objectBytesWritten,
  verifiedExistingObjects:tiles.length-objectWrites,randomness:"none",placementEvaluations:0}};
}
export const TRANSITION_TILE_PRESET=Object.freeze({schemaVersion:1,size:65,soil:Object.freeze([126,83,47] as const),grass:Object.freeze([89,137,58] as const)});
