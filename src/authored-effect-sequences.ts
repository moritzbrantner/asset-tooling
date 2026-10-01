import path from "node:path";
import {canonicalJson} from "./canonical.js";
import {sha256Text} from "./hash.js";
import {createAssetRef,type DeepReadonly} from "./operations.js";
import {normalizeEffectArtworkParameters,createEffectArtworkBuildIdentity,executeEffectArtwork,type EffectArtworkParameters} from "./effect-artwork-recipes.js";
import {createSpriteAtlasOperationBuildIdentity,executeSpriteAtlasOperation,type SpriteFrame} from "./sprite-atlas-operations.js";

export type AuthoredEffectFrame={index:number;timeMs:number;durationMs:number;artwork:EffectArtworkParameters};
export type AuthoredEffectSequenceRecipe={schemaVersion:1;sequence:string;loop:false;
 atlas:{columns:number;padding:number;extrusion:number;trim:boolean};frames:AuthoredEffectFrame[]};

function object(value:unknown,keys:readonly string[],label:string):Record<string,unknown> {
 if(!value || typeof value!=="object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be a plain object`);
 // Plain-object validation establishes this external JSON boundary.
 const p=value as Record<string,unknown>;
 if(Object.keys(p).some(k=>!keys.includes(k)) || keys.some(k=>!Object.hasOwn(p,k))) throw new Error(`${label} requires exactly ${keys.join(", ")}`);
 return p;
}
function integer(value:unknown,label:string,min:number,max:number):number {
 if(typeof value!=="number" || !Number.isSafeInteger(value) || value<min || value>max) throw new Error(`${label} must be an integer in ${min}..${max}`);
 return value;
}
function atlasBounds(recipe:AuthoredEffectSequenceRecipe) {
 const first=recipe.frames[0]!.artwork,margin=recipe.atlas.padding+recipe.atlas.extrusion;
 return {width:recipe.atlas.columns*(first.width+2*margin),maxHeight:Math.ceil(recipe.frames.length/recipe.atlas.columns)*(first.height+2*margin)};
}
/** Explicit discrete poses only: this recipe evaluates no motion, curves or missing times. */
export function normalizeAuthoredEffectSequenceRecipe(value:unknown):AuthoredEffectSequenceRecipe {
 const p=object(value,["schemaVersion","sequence","loop","atlas","frames"],"authored effect sequence");
 if(p.schemaVersion!==1 || p.loop!==false) throw new Error("authored sequence v1 requires schemaVersion 1 and one-shot loop=false");
 if(typeof p.sequence!=="string" || p.sequence.length>112 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(p.sequence)) throw new Error("sequence must be a portable lowercase token of at most 112 characters");
 const a=object(p.atlas,["columns","padding","extrusion","trim"],"authored atlas");
 if(typeof a.trim!=="boolean") throw new Error("atlas trim must be boolean");
 if(!Array.isArray(p.frames) || p.frames.length<2 || p.frames.length>32) throw new Error("authored sequence requires 2..32 explicit frames");
 let expectedTime=0;
 const frames=p.frames.map((value,index):AuthoredEffectFrame=>{
  const f=object(value,["index","timeMs","durationMs","artwork"],"authored frame");
  const timeMs=integer(f.timeMs,"frame timeMs",0,60000);
  if(integer(f.index,"frame index",0,31)!==index || timeMs!==expectedTime) throw new Error("authored frames must have contiguous indices/times starting at zero; gaps and implicit times are unsupported");
  const durationMs=integer(f.durationMs,"frame durationMs",1,10000);expectedTime+=durationMs;
  return {index,timeMs,durationMs,artwork:normalizeEffectArtworkParameters(f.artwork)};
 });
 if(expectedTime>60000) throw new Error("authored sequence exceeds its 60000ms duration budget");
 const first=frames[0]!.artwork;
 for(const {artwork} of frames) if(artwork.width!==first.width || artwork.height!==first.height || artwork.centerX!==first.centerX || artwork.centerY!==first.centerY) throw new Error("authored frames must share canvas dimensions and pixel pivot");
 if(frames.at(-1)!.artwork.opacity!==0) throw new Error("one-shot sequence requires a fully transparent terminal frame");
 const recipe:AuthoredEffectSequenceRecipe={schemaVersion:1,sequence:p.sequence,loop:false,frames,
  atlas:{columns:integer(a.columns,"atlas columns",1,8),padding:integer(a.padding,"atlas padding",0,8),extrusion:integer(a.extrusion,"atlas extrusion",0,8),trim:a.trim}};
 const bounds=atlasBounds(recipe);
 if(bounds.width>4096 || bounds.maxHeight>4096 || bounds.width*bounds.maxHeight>4_194_304) throw new Error("authored atlas exceeds its 4096-axis / 4-megapixel conservative budget");
 return recipe;
}
export async function executeAuthoredEffectSequenceRecipe(root:string,value:unknown,{signal}:{signal?:AbortSignal}={}) {
 if(typeof root!=="string" || !path.isAbsolute(root)) throw new Error("authored sequence root must be absolute");
 signal?.throwIfAborted();
 // Validate every pose/time and worst-case packing before any generated object.
 const recipe=normalizeAuthoredEffectSequenceRecipe(value);
 const frames=[];
 for(const {artwork,...timing} of recipe.frames) {
  signal?.throwIfAborted();
  const invocation={parameters:artwork},build=await createEffectArtworkBuildIdentity(root,invocation);
  signal?.throwIfAborted();
  const result=await executeEffectArtwork(root,invocation);
  signal?.throwIfAborted();
  const frame:SpriteFrame={sequence:recipe.sequence,...timing,loop:false};
  frames.push({id:`${recipe.sequence}.frame.${String(timing.index).padStart(3,"0")}`,frame,build,
   image:createAssetRef(result.outputs.image),mask:createAssetRef(result.outputs.mask),observations:result.observations});
 }
 const first=recipe.frames[0]!.artwork,invocation={inputs:{sprites:frames.map(f=>f.image)},
  parameters:{...atlasBounds(recipe),padding:recipe.atlas.padding,extrusion:recipe.atlas.extrusion,trim:recipe.atlas.trim,
   sprites:frames.map(f=>({id:f.id,pivot:{x:first.centerX,y:first.centerY},frame:f.frame}))}};
 const build=await createSpriteAtlasOperationBuildIdentity(root,invocation);
 signal?.throwIfAborted();
 const result=await executeSpriteAtlasOperation(root,invocation);
 signal?.throwIfAborted();
 return {schemaVersion:1,recipe,recipeSha256:sha256Text(canonicalJson(recipe)),durationMs:recipe.frames.at(-1)!.timeMs+recipe.frames.at(-1)!.durationMs,
  frames,atlas:{build,result},execution:{artworkOperations:frames.length,atlasOperations:1,randomness:"none",motionEvaluations:0}};
}

function deepFreeze<T>(value:T):DeepReadonly<T> {
 if(typeof value==="object" && value!==null) {Object.freeze(value);for(const nested of Object.values(value)) deepFreeze(nested);}
 // All nested arrays/records are frozen before exposure.
 return value as DeepReadonly<T>;
}
const atlas={columns:3,padding:2,extrusion:1,trim:true};
const ring:AuthoredEffectSequenceRecipe={schemaVersion:1,sequence:"ring.strong",loop:false,atlas,frames:[
 {index:0,timeMs:0,durationMs:40,artwork:{shape:"ring",width:64,height:48,centerX:32,centerY:24,radius:6,softness:2,stroke:3,color:[255,210,112],opacity:0}},
 {index:1,timeMs:40,durationMs:40,artwork:{shape:"ring",width:64,height:48,centerX:32,centerY:24,radius:8,softness:2,stroke:3,color:[255,210,112],opacity:255}},
 {index:2,timeMs:80,durationMs:60,artwork:{shape:"ring",width:64,height:48,centerX:32,centerY:24,radius:11,softness:2,stroke:3,color:[255,210,112],opacity:220}},
 {index:3,timeMs:140,durationMs:80,artwork:{shape:"ring",width:64,height:48,centerX:32,centerY:24,radius:14,softness:2,stroke:3,color:[255,210,112],opacity:160}},
 {index:4,timeMs:220,durationMs:120,artwork:{shape:"ring",width:64,height:48,centerX:32,centerY:24,radius:17,softness:2,stroke:3,color:[255,210,112],opacity:80}},
 {index:5,timeMs:340,durationMs:80,artwork:{shape:"ring",width:64,height:48,centerX:32,centerY:24,radius:18,softness:2,stroke:3,color:[255,210,112],opacity:0}},
]};
const puff:AuthoredEffectSequenceRecipe={schemaVersion:1,sequence:"puff.strong",loop:false,atlas,frames:[
 {index:0,timeMs:0,durationMs:60,artwork:{shape:"puff",width:64,height:64,centerX:32,centerY:32,radius:2,softness:4,color:[202,220,238],opacity:0}},
 {index:1,timeMs:60,durationMs:70,artwork:{shape:"puff",width:64,height:64,centerX:32,centerY:32,radius:3,softness:8,color:[202,220,238],opacity:96}},
 {index:2,timeMs:130,durationMs:90,artwork:{shape:"puff",width:64,height:64,centerX:32,centerY:32,radius:5,softness:12,color:[202,220,238],opacity:160}},
 {index:3,timeMs:220,durationMs:120,artwork:{shape:"puff",width:64,height:64,centerX:32,centerY:32,radius:6,softness:16,color:[202,220,238],opacity:96}},
 {index:4,timeMs:340,durationMs:160,artwork:{shape:"puff",width:64,height:64,centerX:32,centerY:32,radius:8,softness:20,color:[202,220,238],opacity:32}},
 {index:5,timeMs:500,durationMs:100,artwork:{shape:"puff",width:64,height:64,centerX:32,centerY:32,radius:10,softness:20,color:[202,220,238],opacity:0}},
]};
function variant(recipe:AuthoredEffectSequenceRecipe,name:string,opacityScale:number):AuthoredEffectSequenceRecipe {
 return {...recipe,sequence:`${recipe.sequence.split(".")[0]}.${name}`,frames:recipe.frames.map(f=>({...f,artwork:{...f.artwork,opacity:Math.round(f.artwork.opacity*opacityScale/255)}}))};
}
export const AUTHORED_EFFECT_SEQUENCE_PRESETS=deepFreeze({
 ring:{strong:ring,subtle:variant(ring,"subtle",96),off:variant(ring,"off",0)},
 puff:{strong:puff,subtle:variant(puff,"subtle",96),off:variant(puff,"off",0)},
});
