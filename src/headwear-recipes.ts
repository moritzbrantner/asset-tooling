import {readBlenderRecipeSource} from "./blender-recipe-source.js";
import {parseAssetSpec} from "./schema.js";

export type HeadwearPiece="cap.ranger"|"helm.ironcrest";
export type HeadwearParameters={schemaVersion:1;piece:HeadwearPiece;segments:number;maxTriangles:number};

/** Style-spec triangle ceilings (docs/style-humanlike.md). `maxTriangles` may lower, never raise, them. */
export const HEADWEAR_TRIANGLE_BUDGETS=Object.freeze({"cap.ranger":2000,"helm.ironcrest":2500}) satisfies Record<HeadwearPiece,number>;
export const HEADWEAR_MATERIALS=Object.freeze({"cap.ranger":Object.freeze(["felt","leather","feather"] as const),
 "helm.ironcrest":Object.freeze(["iron","brass"] as const)}) satisfies Record<HeadwearPiece,readonly string[]>;
/**
 * Every GLB's geometry is in the male Ranger's rest model space around its head; the empty node `grip` sits at the
 * origin with an identity transform, so the `head.armor` socket (the inverse Head rest transform) places it.
 */
export const HEADWEAR_CONTRACT=Object.freeze({schemaVersion:1,unit:"meter",axes:"right-handed-y-up",origin:"grip",gripNode:"grip",
 space:"rest-model",socket:"head.armor",role:"armor"});
/** The appearance parts each piece hides while worn (owner answer on #336: the helm hides the hair, the cap keeps it). */
export const HEADWEAR_HIDES=Object.freeze({"cap.ranger":Object.freeze(["outfit.hood"]),"helm.ironcrest":Object.freeze(["outfit.hood","hair"])}) satisfies Record<HeadwearPiece,readonly string[]>;

export function normalizeHeadwearParameters(value:unknown):HeadwearParameters {
 if(!value || typeof value!=="object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error("headwear parameters must be a plain object");
 // Admit the external JSON record before reading its declared controls.
 const p=value as Record<string,unknown>;
 if(typeof p.piece!=="string" || !Object.hasOwn(HEADWEAR_TRIANGLE_BUDGETS,p.piece)) throw new Error("headwear piece must be cap.ranger or helm.ironcrest");
 const piece=p.piece as HeadwearPiece,keys=["schemaVersion","piece","segments","maxTriangles"];
 if(Object.keys(p).length!==keys.length || keys.some(k=>!Object.hasOwn(p,k))) throw new Error("headwear requires exactly the declared controls");
 if(p.schemaVersion!==1) throw new Error("headwear schemaVersion must be 1");
 const integer=(key:string,min:number,max:number)=>{
  const v=p[key];
  if(typeof v!=="number" || !Number.isSafeInteger(v) || v<min || v>max) throw new Error(`headwear ${key} must be an integer in ${min}..${max}`);
  return v;
 };
 return {schemaVersion:1,piece,segments:integer("segments",12,24),maxTriangles:integer("maxTriangles",12,HEADWEAR_TRIANGLE_BUDGETS[piece])};
}
export async function readHeadwearRecipeSource() {
 return readBlenderRecipeSource("headwear.py");
}
export function createHeadwearAssetSpec({assetId,parameters,scriptSha256,blenderVersion,scriptPath="headwear.py",outputPath="headwear.glb"}:{
 assetId:string;parameters:unknown;scriptSha256:string;blenderVersion:string;scriptPath?:string;outputPath?:string;
}) {
 if(!/^\d+\.\d+\.\d+$/.test(blenderVersion)) throw new Error("headwear Blender version must be exact");
 if(!scriptPath.endsWith(".py") || !outputPath.endsWith(".glb")) throw new Error("headwear spec requires a Python script and GLB output");
 return parseAssetSpec({schemaVersion:1,assetId,generator:{id:"external.blender.script",version:"1"},randomness:{mode:"none"},
  inputs:{script:{path:scriptPath,sha256:scriptSha256}},models:{},parameters:{blenderVersion,arguments:normalizeHeadwearParameters(parameters)},
  output:{path:outputPath},reproducibility:{expected:"exact"}});
}

/** The owner-approved shapes (2026-10-21, #336). */
export const HEADWEAR_PRESETS=Object.freeze({
 "cap.ranger":Object.freeze({schemaVersion:1,piece:"cap.ranger",segments:16,maxTriangles:2000}),
 "helm.ironcrest":Object.freeze({schemaVersion:1,piece:"helm.ironcrest",segments:16,maxTriangles:2500}),
}) satisfies Record<HeadwearPiece,HeadwearParameters>;
