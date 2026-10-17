// Archery gear recipes (#113 bow slice, docs/weapon-recipes.md#archery): adapters/blender/archery.py through the
// pinned Blender script backend. The bow is skinned to `grip` and `nock`; the arrow and quiver are static.
import {readBlenderRecipeSource} from "./blender-recipe-source.js";
import {parseAssetSpec} from "./schema.js";

export type ArcheryPiece="bow.long"|"arrow"|"quiver.back";
export type ArcheryRole="bow"|"arrow"|"quiver";
export const ARCHERY_PIECES:readonly ArcheryPiece[]=Object.freeze(["bow.long","arrow","quiver.back"]);
/** Style-spec triangle ceilings; `maxTriangles` may lower, never raise, them. */
export const ARCHERY_TRIANGLE_BUDGETS=Object.freeze({"bow.long":2500,"arrow":800,"quiver.back":6000}) satisfies Record<ArcheryPiece,number>;
export const ARCHERY_ROLES=Object.freeze({"bow.long":"bow","arrow":"arrow","quiver.back":"quiver"}) satisfies Record<ArcheryPiece,ArcheryRole>;
export const ARCHERY_MATERIALS=Object.freeze({"bow.long":["wood","horn","leather","string"],"arrow":["wood","iron","feather"],
 "quiver.back":["leather","wood","iron","feather"]}) satisfies Record<ArcheryPiece,readonly string[]>;
/** Attach frames: every GLB's origin is its attach frame. The bow's draw contract is in BOW_DRAW_CONTRACT. */
export const ARCHERY_GRIP_CONTRACT=Object.freeze({schemaVersion:1,unit:"meter",axes:"right-handed-y-up",origin:"grip",
 "bow.long":"origin at the centre of the hand's contact on the riser; limbs along +Y/-Y, the arrow leaves toward +Z, the string is on the -Z side",
 "arrow":"origin at the arrow's nock; the shaft runs toward +Z to the head",
 "quiver.back":"origin at the centre of the tube; the opening points to +Y and the side worn against the body faces -Z"});
/** The bow is skinned to `grip` (root) and `nock`; translating `nock` toward -Z in the bow frame draws the string. */
export const BOW_DRAW_CONTRACT=Object.freeze({joints:Object.freeze(["grip","nock"]),drawJoint:"nock",drawAxis:Object.freeze([0,0,-1])});

const RANGES={
 "bow.long":{length:[1.2,1.9],braceHeight:[.12,.24],limbWidth:[.02,.05],limbSegments:[6,24,true]},
 "arrow":{length:[.55,.95],shaftRadius:[.003,.007],radialSegments:[5,12,true]},
 "quiver.back":{length:[.35,.7],radius:[.035,.08],arrows:[0,8,true],radialSegments:[8,24,true]},
} as const satisfies Record<ArcheryPiece,Record<string,readonly [number,number]|readonly [number,number,true]>>;

export function normalizeArcheryParameters(value:unknown):Record<string,unknown> {
 if(!value || typeof value!=="object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error("archery parameters must be a plain object");
 const p=value as Record<string,unknown>;
 if(typeof p.piece!=="string" || !Object.hasOwn(RANGES,p.piece)) throw new Error("archery piece must be bow.long, arrow or quiver.back");
 const piece=p.piece as ArcheryPiece,ranges:Record<string,readonly number[]|readonly [number,number,true]>=RANGES[piece];
 const keys=["schemaVersion","piece","maxTriangles",...Object.keys(ranges)];
 if(Object.keys(p).length!==keys.length || keys.some(k=>!Object.hasOwn(p,k))) throw new Error("archery piece requires exactly the declared controls");
 if(p.schemaVersion!==1) throw new Error("archery schemaVersion must be 1");
 const result:Record<string,unknown>={schemaVersion:1,piece};
 const number=(v:unknown,label:string,min:number,max:number,integer:boolean)=>{
  if(typeof v!=="number" || !Number.isFinite(v) || v<min || v>max || (integer && !Number.isSafeInteger(v))) throw new Error(`archery ${label} must be ${integer?"an integer":"finite"} in ${min}..${max}`);
  return v;
 };
 for(const [key,[min,max,integer]] of Object.entries(ranges)) result[key]=number(p[key],key,min!,max!,integer===true);
 result.maxTriangles=number(p.maxTriangles,"maxTriangles",12,ARCHERY_TRIANGLE_BUDGETS[piece],true);
 return result;
}
export async function readArcheryRecipeSource() {
 return readBlenderRecipeSource("archery.py");
}
export function createArcheryAssetSpec({assetId,parameters,scriptSha256,blenderVersion}:{assetId:string;parameters:unknown;scriptSha256:string;blenderVersion:string}) {
 if(!/^\d+\.\d+\.\d+$/.test(blenderVersion)) throw new Error("archery Blender version must be exact");
 return parseAssetSpec({schemaVersion:1,assetId,generator:{id:"external.blender.script",version:"1"},randomness:{mode:"none"},
  inputs:{script:{path:"archery.py",sha256:scriptSha256}},models:{},parameters:{blenderVersion,arguments:normalizeArcheryParameters(parameters)},
  output:{path:"archery.glb"},reproducibility:{expected:"exact"}});
}
export const ARCHERY_PRESETS=Object.freeze({
 "bow.long":Object.freeze({schemaVersion:1,piece:"bow.long",length:1.5,braceHeight:.18,limbWidth:.034,limbSegments:12,maxTriangles:2500}),
 "arrow":Object.freeze({schemaVersion:1,piece:"arrow",length:.76,shaftRadius:.0045,radialSegments:8,maxTriangles:800}),
 "quiver.back":Object.freeze({schemaVersion:1,piece:"quiver.back",length:.5,radius:.055,arrows:5,radialSegments:16,maxTriangles:6000}),
}) satisfies Record<ArcheryPiece,Record<string,unknown>>;
