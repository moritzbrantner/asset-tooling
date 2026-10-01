import {readBlenderRecipeSource} from "./blender-recipe-source.js";
import {parseAssetSpec} from "./schema.js";

export type WheatStage="early"|"mature"|"harvested";
export type WheatParameters={schemaVersion:1;stage:WheatStage;seed:string;stemHeight:number;stemRadius:number;
 leafCount:number;leafLength:number;leafWidth:number;earLength:number;grainPairs:number;curveSegments:number;maxTriangles:number};
const keys=["schemaVersion","stage","seed","stemHeight","stemRadius","leafCount","leafLength","leafWidth","earLength","grainPairs","curveSegments","maxTriangles"];
function number(value:unknown,label:string,min:number,max:number,integer=false):number {
 if(typeof value!=="number" || !Number.isFinite(value) || value<min || value>max || (integer && !Number.isSafeInteger(value))) {
  throw new Error(`${label} must be ${integer?"an integer":"finite"} in ${min}..${max}`);
 }
 return value;
}
export function normalizeWheatParameters(value:unknown):WheatParameters {
 if(!value || typeof value!=="object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) {
  throw new Error("Wheat parameters must be a plain object");
 }
 // Admit the external JSON record before reading its controls.
 const p=value as Record<string,unknown>;
 if(Object.keys(p).length!==keys.length || keys.some(k=>!Object.hasOwn(p,k))) {throw new Error("Wheat requires exactly the declared controls");}
 if(p.schemaVersion!==1) {throw new Error("Wheat schemaVersion must be 1");}
 if(typeof p.seed!=="string" || p.seed.length>10 || !/^(0|[1-9][0-9]*)$/.test(p.seed) || /\s/.test(p.seed) || BigInt(p.seed)>2147483647n) {
  throw new Error("Wheat seed must be canonical decimal in 0..2147483647");
 }
 if(p.stage!=="early" && p.stage!=="mature" && p.stage!=="harvested") {throw new Error("unsupported Wheat stage");}
 const result:WheatParameters={schemaVersion:1,stage:p.stage,seed:p.seed,stemHeight:number(p.stemHeight,"stemHeight",.1,1.3),
  stemRadius:number(p.stemRadius,"stemRadius",.003,.025),leafCount:number(p.leafCount,"leafCount",0,6,true),
  leafLength:number(p.leafLength,"leafLength",0,.3),leafWidth:number(p.leafWidth,"leafWidth",0,.08),earLength:number(p.earLength,"earLength",0,.3),
  grainPairs:number(p.grainPairs,"grainPairs",0,8,true),curveSegments:number(p.curveSegments,"curveSegments",2,6,true),maxTriangles:number(p.maxTriangles,"maxTriangles",100,20000,true)};
 switch(result.stage) {
  case "harvested": {
   if(result.leafCount!==0 || result.leafLength!==0 || result.leafWidth!==0 || result.earLength!==0 || result.grainPairs!==0 || result.stemHeight>.3) {
    throw new Error("harvested appearance requires a short bare stem and no foliage/ear controls");
   }
   break;
  }
  case "early":
  case "mature": {
   if(result.leafCount<2 || result.leafLength<.05 || result.leafWidth<.008) {throw new Error("early/mature Wheat requires bounded visible leaves");}
   if(result.stage==="early" && (result.earLength!==0 || result.grainPairs!==0 || result.stemHeight>.5 || result.leafCount>4)) {
    throw new Error("early Wheat requires a short leafy stem without an ear");
   }
   if(result.stage==="mature" && (result.earLength<.08 || result.grainPairs<4)) {throw new Error("mature Wheat requires a visible bounded grain ear");}
   break;
  }
  default: {
   const unreachable:never=result.stage;
   throw new Error(`unsupported Wheat stage '${unreachable}'`);
  }
 }
 return result;
}
export function readWheatRecipeSource() {return readBlenderRecipeSource("wheat.py");}
export function createWheatAssetSpec({assetId,parameters,scriptSha256,blenderVersion,scriptPath="wheat.py",outputPath="wheat.glb"}: {
 assetId:string;parameters:unknown;scriptSha256:string;blenderVersion:string;scriptPath?:string;outputPath?:string;
}) {
 if(!/^\d+\.\d+\.\d+$/.test(blenderVersion)) {throw new Error("Wheat Blender version must be exact");}
 if(!scriptPath.endsWith(".py") || !outputPath.endsWith(".glb")) {throw new Error("Wheat spec requires Python and GLB paths");}
 return parseAssetSpec({schemaVersion:1,assetId,generator:{id:"external.blender.script",version:"1"},randomness:{mode:"none"},
  inputs:{script:{path:scriptPath,sha256:scriptSha256}},models:{},parameters:{blenderVersion,arguments:normalizeWheatParameters(parameters)},
  output:{path:outputPath},reproducibility:{expected:"approximate"}});
}
const common={schemaVersion:1,seed:"133",curveSegments:4,maxTriangles:6000} as const;
export const WHEAT_PRESETS=Object.freeze({
 early:Object.freeze({...common,stage:"early",stemHeight:.25,stemRadius:.007,leafCount:3,leafLength:.14,leafWidth:.025,earLength:0,grainPairs:0} as const),
 mature:Object.freeze({...common,stage:"mature",stemHeight:.9,stemRadius:.011,leafCount:4,leafLength:.24,leafWidth:.032,earLength:.22,grainPairs:7} as const),
 harvested:Object.freeze({...common,stage:"harvested",stemHeight:.12,stemRadius:.011,leafCount:0,leafLength:0,leafWidth:0,earLength:0,grainPairs:0} as const),
});
