import path from "node:path";
import {canonicalJson,compareCodeUnitStrings} from "./canonical.js";
import {sha256Text} from "./hash.js";
import type {AssetRef,DeepReadonly} from "./operations.js";
import {
 SURFACE_TEXTURE_PRESETS,executePreservedSurfaceTextureRecipe,executeSurfaceTextureRecipe,normalizeSurfaceTextureRecipe,
 type RgbBytes,type SurfaceTextureRecipe,type SurfaceTextureStep,
} from "./surface-texture-recipes.js";

/** A state may change only appearance channels; height and normal are family-wide invariants. */
export type SurfaceAppearanceState={id:string;low:RgbBytes;high:RgbBytes;roughnessMin:number;roughnessMax:number};
export type SurfaceAppearanceFamily={schemaVersion:1;id:string;base:SurfaceTextureRecipe;states:SurfaceAppearanceState[]};
export const SURFACE_APPEARANCE_INVARIANTS=Object.freeze({shared:Object.freeze(["height","normal"] as const),varying:Object.freeze(["color","roughness"] as const)});

function object(value:unknown,keys:readonly string[],label:string):Record<string,unknown> {
 if(!value || typeof value!=="object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be a plain object`);
 // Plain-object validation establishes this external JSON boundary.
 const p=value as Record<string,unknown>;
 if(Object.keys(p).some(k=>!keys.includes(k)) || keys.some(k=>!Object.hasOwn(p,k))) throw new Error(`${label} requires exactly ${keys.join(", ")}`);
 return p;
}
function token(value:unknown,label:string):string {
 if(typeof value!=="string" || value.length>64 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)) throw new Error(`${label} must be a portable lowercase token of at most 64 characters`);
 return value;
}
const stateRecipe=(base:SurfaceTextureRecipe,{low,high,roughnessMin,roughnessMax}:SurfaceAppearanceState):SurfaceTextureRecipe=>({...base,low,high,roughnessMin,roughnessMax});

/** Validates the base and every state before generation; states are ordered by ID, not declaration order. */
export function normalizeSurfaceAppearanceFamily(value:unknown):SurfaceAppearanceFamily {
 const p=object(value,["schemaVersion","id","base","states"],"surface appearance family");
 if(p.schemaVersion!==1) throw new Error("surface appearance family requires schemaVersion 1");
 const base=normalizeSurfaceTextureRecipe(p.base);
 if(!Array.isArray(p.states) || p.states.length<1 || p.states.length>8) throw new Error("surface appearance family requires 1..8 states");
 const seen=new Set<string>();
 const states=p.states.map((raw):SurfaceAppearanceState=>{
  const s=object(raw,["id","low","high","roughnessMin","roughnessMax"],"surface appearance state"),id=token(s.id,"state id");
  if(seen.has(id)) throw new Error(`duplicate surface appearance state '${id}'`);seen.add(id);
  // Reuse the surface recipe's own palette/roughness validation for each state.
  const checked=normalizeSurfaceTextureRecipe({...base,low:s.low,high:s.high,roughnessMin:s.roughnessMin,roughnessMax:s.roughnessMax});
  return {id,low:checked.low,high:checked.high,roughnessMin:checked.roughnessMin,roughnessMax:checked.roughnessMax};
 }).sort((a,b)=>compareCodeUnitStrings(a.id,b.id));
 return {schemaVersion:1,id:token(p.id,"family id"),base,states};
}

export type SurfaceAppearanceStateResult={id:string;recipeSha256:string;outputs:{color:AssetRef;roughness:AssetRef};steps:SurfaceTextureStep[];
 execution:{executedOperations:number;reusedOperations:number}};
export type SurfaceAppearanceShared={height:SurfaceTextureStep;normal:SurfaceTextureStep};
type Options={signal?:AbortSignal;shared?:SurfaceAppearanceShared};
async function sharedComponents(root:string,family:SurfaceAppearanceFamily,signal?:AbortSignal,accepted?:SurfaceAppearanceShared):Promise<SurfaceAppearanceShared> {
 signal?.throwIfAborted();
 if(accepted!==undefined) {
  // Accepted steps are verified as locks (build identity, metadata and bytes) by the preserved surface path.
  const a=object(accepted,["height","normal"],"accepted shared surface components");
  return {height:a.height as SurfaceTextureStep,normal:a.normal as SurfaceTextureStep};
 }
 const result=await executeSurfaceTextureRecipe(root,family.base,{channels:["height","normal"]});
 signal?.throwIfAborted();
 const step=(field:"height"|"normal")=>result.steps.find(s=>s.output.metadata.field===field)!;
 return {height:step("height"),normal:step("normal")};
}
async function state(root:string,family:SurfaceAppearanceFamily,s:SurfaceAppearanceState,shared:{height:SurfaceTextureStep;normal:SurfaceTextureStep},signal?:AbortSignal):Promise<SurfaceAppearanceStateResult> {
 signal?.throwIfAborted();
 const recipe=stateRecipe(family.base,s);
 // Height/normal locks are verified by the surface recipe; only color and roughness may execute.
 const result=await executePreservedSurfaceTextureRecipe(root,recipe,{channels:["color","normal","roughness"],preserve:shared});
 // The surface stages take no signal: an in-flight stage may store immutable objects, but no cancelled result is returned.
 signal?.throwIfAborted();
 const {color,roughness,height,normal}=result.outputs;
 if(!color || !roughness || height || normal?.sha256!==shared.normal.output.sha256) throw new Error("surface appearance state did not preserve the shared normal");
 return {id:s.id,recipeSha256:result.recipeSha256,outputs:{color,roughness},steps:["base-color","roughness"].map(field=>result.steps.find(x=>x.output.metadata.field===field)!),
  execution:{executedOperations:result.execution.executedOperations,reusedOperations:result.execution.reusedOperations}};
}
function checkedRoot(root:string) {
 if(typeof root!=="string" || !path.isAbsolute(root)) throw new Error("surface appearance root must be absolute");
}

/** Builds (or verifies accepted) shared height/normal once, then each state's color/roughness against those exact components. */
export async function executeSurfaceAppearanceFamily(root:string,value:unknown,{signal,shared:accepted}:Options={}) {
 checkedRoot(root);signal?.throwIfAborted();
 const family=normalizeSurfaceAppearanceFamily(value),shared=await sharedComponents(root,family,signal,accepted);
 const states:SurfaceAppearanceStateResult[]=[];
 for(const s of family.states) states.push(await state(root,family,s,shared,signal));
 return {schemaVersion:1 as const,family,familySha256:sha256Text(canonicalJson(family)),invariants:SURFACE_APPEARANCE_INVARIANTS,
  shared,states};
}
/** Builds one state only; siblings are not executed. With accepted shared steps, no height/normal stage runs. */
export async function executeSurfaceAppearanceState(root:string,value:unknown,stateId:string,{signal,shared:accepted}:Options={}) {
 checkedRoot(root);signal?.throwIfAborted();
 const family=normalizeSurfaceAppearanceFamily(value),selected=family.states.find(s=>s.id===stateId);
 if(!selected) throw new Error(`unknown surface appearance state '${String(stateId)}'`);
 const shared=await sharedComponents(root,family,signal,accepted);
 return {schemaVersion:1 as const,familySha256:sha256Text(canonicalJson(family)),shared,
  state:await state(root,family,selected,shared,signal)};
}

function deepFreeze<T>(value:T):DeepReadonly<T> {
 if(typeof value==="object" && value!==null) {Object.freeze(value);for(const nested of Object.values(value)) deepFreeze(nested);}
 // All nested arrays/records are frozen before exposure.
 return value as DeepReadonly<T>;
}
const soil=structuredClone(SURFACE_TEXTURE_PRESETS["soil-fine"]) as SurfaceTextureRecipe;
/** Dry/damp/wet soil: wet surfaces read darker and glossier while the soil relief stays identical. */
export const SURFACE_APPEARANCE_PRESETS=deepFreeze({
 soilMoisture:{schemaVersion:1,id:"soil.moisture",base:soil,states:[
  {id:"dry",low:[58,38,22],high:[168,128,82],roughnessMin:200,roughnessMax:250},
  {id:"damp",low:[38,23,12],high:[145,102,58],roughnessMin:150,roughnessMax:210},
  {id:"wet",low:[22,13,7],high:[96,64,36],roughnessMin:50,roughnessMax:120},
 ]} satisfies SurfaceAppearanceFamily,
});
