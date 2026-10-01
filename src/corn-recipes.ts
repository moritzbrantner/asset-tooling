import {readBlenderRecipeSource} from "./blender-recipe-source.js";
import {readWheatRecipeSource,type WheatStage} from "./wheat-recipes.js";
import {parseAssetSpec} from "./schema.js";
export type CornStage=WheatStage;
export type CornParameters={schemaVersion:1;stage:CornStage;seed:string;stemHeight:number;stemRadius:number;leafCount:number;
 leafLength:number;leafWidth:number;earLength:number;kernelRows:number;curveSegments:number;maxTriangles:number};
const keys=["schemaVersion","stage","seed","stemHeight","stemRadius","leafCount","leafLength","leafWidth","earLength","kernelRows","curveSegments","maxTriangles"];
function number(value:unknown,name:string,min:number,max:number,integer=false):number {
 if(typeof value!=="number" || !Number.isFinite(value) || value<min || value>max || (integer && !Number.isSafeInteger(value))) {
  throw new Error(`${name} must be ${integer?"an integer":"finite"} in ${min}..${max}`);
 }
 return value;
}
export function normalizeCornParameters(value:unknown):CornParameters {
 if(!value || typeof value!=="object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) {
  throw new Error("Corn parameters must be a plain object");
 }
 const p=value as Record<string,unknown>;
 if(Object.keys(p).length!==keys.length || keys.some(k=>!Object.hasOwn(p,k))) {throw new Error("Corn requires exactly the declared controls");}
 if(p.schemaVersion!==1) {throw new Error("Corn schemaVersion must be 1");}
 if(typeof p.seed!=="string" || p.seed.length>10 || !/^(0|[1-9][0-9]*)$/.test(p.seed) || /\s/.test(p.seed) || BigInt(p.seed)>2147483647n) {
  throw new Error("Corn seed must be canonical decimal in 0..2147483647");
 }
 if(p.stage!=="early" && p.stage!=="mature" && p.stage!=="harvested") {throw new Error("unsupported Corn stage");}
 const result:CornParameters={schemaVersion:1,stage:p.stage,seed:p.seed,stemHeight:number(p.stemHeight,"stemHeight",.1,2.4),
  stemRadius:number(p.stemRadius,"stemRadius",.006,.035),leafCount:number(p.leafCount,"leafCount",0,8,true),leafLength:number(p.leafLength,"leafLength",0,.45),
  leafWidth:number(p.leafWidth,"leafWidth",0,.12),earLength:number(p.earLength,"earLength",0,.3),kernelRows:number(p.kernelRows,"kernelRows",0,8,true),
  curveSegments:number(p.curveSegments,"curveSegments",2,6,true),maxTriangles:number(p.maxTriangles,"maxTriangles",100,12000,true)};
 switch(result.stage) {
  case "harvested": {
   if(result.leafCount!==0 || result.leafLength!==0 || result.leafWidth!==0 || result.earLength!==0 || result.kernelRows!==0 || result.stemHeight>.3) {
    throw new Error("harvested Corn requires a short bare stalk");
   }
   break;
  }
  case "early": {
   if(result.leafCount<2 || result.leafCount>4 || result.leafLength<.1 || result.leafWidth<.02 || result.stemHeight>.6 || result.leafLength*.05>result.stemHeight*.16 || result.earLength!==0 || result.kernelRows!==0) {
    throw new Error("early Corn requires short broad foliage without an ear");
   }
   break;
  }
  case "mature": {
   if(result.leafCount<4 || result.leafLength<.2 || result.leafWidth<.04 || result.stemHeight<.8 || result.earLength<.12 || result.kernelRows<4) {
    throw new Error("mature Corn requires broad foliage and a bounded ear");
   }
   break;
  }
  default: {
   const unreachable:never=result.stage;
   throw new Error(`unsupported Corn stage '${unreachable}'`);
  }
 }
 return result;
}
export async function readCornRecipeSource() {
 const [source,authoring]=await Promise.all([readBlenderRecipeSource("corn.py"),readWheatRecipeSource()]);
 return {...source,authoring};
}
export function createCornAssetSpec({assetId,parameters,scriptSha256,authoringSha256,blenderVersion,scriptPath="corn.py",authoringPath="wheat.py",outputPath="corn.glb"}: {
 assetId:string;parameters:unknown;scriptSha256:string;authoringSha256:string;blenderVersion:string;scriptPath?:string;authoringPath?:string;outputPath?:string;
}) {
 if(!/^\d+\.\d+\.\d+$/.test(blenderVersion)) {throw new Error("Corn Blender version must be exact");}
 if(!scriptPath.endsWith(".py") || !authoringPath.endsWith(".py") || !outputPath.endsWith(".glb")) {throw new Error("Corn requires Python and GLB paths");}
 return parseAssetSpec({schemaVersion:1,assetId,generator:{id:"external.blender.script",version:"1"},randomness:{mode:"none"},
  inputs:{script:{path:scriptPath,sha256:scriptSha256},authoring:{path:authoringPath,sha256:authoringSha256}},models:{},
  parameters:{blenderVersion,arguments:normalizeCornParameters(parameters)},output:{path:outputPath},reproducibility:{expected:"approximate"}});
}
const common={schemaVersion:1,seed:"133",curveSegments:4,maxTriangles:7000} as const;
export const CORN_PRESETS=Object.freeze({
 early:Object.freeze({...common,stage:"early",stemHeight:.4,stemRadius:.012,leafCount:3,leafLength:.24,leafWidth:.05,earLength:0,kernelRows:0} as const),
 mature:Object.freeze({...common,stage:"mature",stemHeight:1.5,stemRadius:.018,leafCount:6,leafLength:.38,leafWidth:.09,earLength:.21,kernelRows:6} as const),
 harvested:Object.freeze({...common,stage:"harvested",stemHeight:.15,stemRadius:.018,leafCount:0,leafLength:0,leafWidth:0,earLength:0,kernelRows:0} as const),
});
