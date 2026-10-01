import {readBlenderRecipeSource} from "./blender-recipe-source.js";
import {readWheatRecipeSource} from "./wheat-recipes.js";
import {parseAssetSpec} from "./schema.js";

export type GrassParameters={schemaVersion:1;seed:string;bladeCount:number;bladeHeight:number;bladeWidth:number;
 spread:number;bend:number;curveSegments:number;maxTriangles:number};
const keys=["schemaVersion","seed","bladeCount","bladeHeight","bladeWidth","spread","bend","curveSegments","maxTriangles"];
function number(value:unknown,label:string,min:number,max:number,integer=false):number {
 if(typeof value!=="number" || !Number.isFinite(value) || value<min || value>max || (integer && !Number.isSafeInteger(value))) {
  throw new Error(`${label} must be ${integer?"an integer":"finite"} in ${min}..${max}`);
 }
 return value;
}
export function normalizeGrassParameters(value:unknown):GrassParameters {
 if(!value || typeof value!=="object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) {
  throw new Error("Grass parameters must be a plain object");
 }
 // Admit the external JSON record before reading its declared controls.
 const p=value as Record<string,unknown>;
 if(Object.keys(p).length!==keys.length || keys.some(k=>!Object.hasOwn(p,k))) {throw new Error("Grass requires exactly the declared controls");}
 if(p.schemaVersion!==1) {throw new Error("Grass schemaVersion must be 1");}
 if(typeof p.seed!=="string" || p.seed.length>10 || !/^(0|[1-9][0-9]*)$/.test(p.seed) || /\s/.test(p.seed) || BigInt(p.seed)>2147483647n) {
  throw new Error("Grass seed must be canonical decimal in 0..2147483647");
 }
 const result:GrassParameters={schemaVersion:1,seed:p.seed,bladeCount:number(p.bladeCount,"bladeCount",1,32,true),
  bladeHeight:number(p.bladeHeight,"bladeHeight",.08,1),bladeWidth:number(p.bladeWidth,"bladeWidth",.004,.06),
  spread:number(p.spread,"spread",0,.3),bend:number(p.bend,"bend",0,.8),curveSegments:number(p.curveSegments,"curveSegments",2,6,true),
  maxTriangles:number(p.maxTriangles,"maxTriangles",16,8000,true)};
 if(result.bladeWidth>result.bladeHeight*.25) {throw new Error("Grass blade width must not exceed one quarter of its height envelope");}
 return result;
}
export async function readGrassRecipeSource() {
 const [source,authoring]=await Promise.all([readBlenderRecipeSource("grass.py"),readWheatRecipeSource()]);
 return {...source,authoring};
}
export function createGrassAssetSpec({assetId,parameters,scriptSha256,authoringSha256,blenderVersion,scriptPath="grass.py",authoringPath="wheat.py",outputPath="grass.glb"}: {
 assetId:string;parameters:unknown;scriptSha256:string;authoringSha256:string;blenderVersion:string;scriptPath?:string;authoringPath?:string;outputPath?:string;
}) {
 if(!/^\d+\.\d+\.\d+$/.test(blenderVersion)) {throw new Error("Grass Blender version must be exact");}
 if(!scriptPath.endsWith(".py") || !authoringPath.endsWith(".py") || !outputPath.endsWith(".glb")) {throw new Error("Grass requires Python and GLB paths");}
 return parseAssetSpec({schemaVersion:1,assetId,generator:{id:"external.blender.script",version:"1"},randomness:{mode:"none"},
  inputs:{script:{path:scriptPath,sha256:scriptSha256},authoring:{path:authoringPath,sha256:authoringSha256}},models:{},
  parameters:{blenderVersion,arguments:normalizeGrassParameters(parameters)},output:{path:outputPath},reproducibility:{expected:"approximate"}});
}
const common={schemaVersion:1,seed:"133",curveSegments:4,maxTriangles:8000} as const;
export const GRASS_PRESETS=Object.freeze({
 short:Object.freeze({...common,bladeCount:12,bladeHeight:.18,bladeWidth:.012,spread:.05,bend:.1}),
 bent:Object.freeze({...common,bladeCount:12,bladeHeight:.45,bladeWidth:.025,spread:.06,bend:.7}),
 tuft:Object.freeze({...common,bladeCount:24,bladeHeight:.3,bladeWidth:.018,spread:.12,bend:.4}),
});
