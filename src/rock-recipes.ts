import { readFile } from "node:fs/promises";
import { sha256Bytes } from "./hash.js";
import { createAssetRef, type AssetRef } from "./operations.js";
import { parseAssetSpec } from "./schema.js";

export type RockParameters = {
  schemaVersion: 1; seed: string; width: number; height: number; depth: number;
  subdivisions: number; angularity: number; flattening: number; irregularity: number; noiseScale: number;
};
const KEYS = ["schemaVersion","seed","width","height","depth","subdivisions","angularity","flattening","irregularity","noiseScale"];
function object(value: unknown, keys: string[], label: string): Record<string,unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be a plain object`);
  const result=value as Record<string,unknown>;
  for(const key of Object.keys(result)) if(!keys.includes(key)) throw new Error(`${label} contains unknown field '${key}'`);
  for(const key of keys) if(!Object.hasOwn(result,key)) throw new Error(`${label} is missing '${key}'`);
  return result;
}
function bounded(value: unknown, key: string, min: number, max: number): number {
  if(typeof value !== "number" || !Number.isFinite(value) || value<min || value>max) throw new Error(`${key} must be finite in ${min}..${max}`);
  return value;
}
export function normalizeRockParameters(value: unknown): RockParameters {
  const p=object(value,KEYS,"rock parameters");
  if(p.schemaVersion!==1) throw new Error("rock schemaVersion must be 1");
  if(typeof p.seed!=="string" || !/^(0|[1-9][0-9]*)$/.test(p.seed)) throw new Error("rock seed must be a decimal integer string");
  const subdivisions=bounded(p.subdivisions,"subdivisions",1,5);
  if(!Number.isInteger(subdivisions)) throw new Error("subdivisions must be an integer");
  return {schemaVersion:1,seed:p.seed,width:bounded(p.width,"width",0.001,1000),height:bounded(p.height,"height",0.001,1000),depth:bounded(p.depth,"depth",0.001,1000),subdivisions,
    angularity:bounded(p.angularity,"angularity",0,1),flattening:bounded(p.flattening,"flattening",0,1),irregularity:bounded(p.irregularity,"irregularity",0,0.35),noiseScale:bounded(p.noiseScale,"noiseScale",0.1,16)};
}

/** Read packaged authoring source. Acquisition is not invoked by this recipe. */
export async function readRockRecipeSource() {
  const bytes=await readFile(new URL("../adapters/blender/rock.py",import.meta.url));
  const release: unknown=JSON.parse(await readFile(new URL("../adapters/blender/release.json",import.meta.url),"utf8"));
  if(!release || typeof release!=="object" || !("version" in release) || typeof release.version!=="string" || !/^\d+\.\d+\.\d+$/.test(release.version)) throw new Error("packaged Blender release must declare an exact version");
  return {bytes,sha256:sha256Bytes(bytes),blenderVersion:release.version};
}
export function createRockAssetSpec({assetId,parameters,scriptSha256,blenderVersion,scriptPath="rock.py",outputPath="rock.glb"}: {
  assetId: string; parameters: unknown; scriptSha256: string; blenderVersion: string; scriptPath?: string; outputPath?: string;
}) {
  if(!/^\d+\.\d+\.\d+$/.test(blenderVersion)) throw new Error("rock Blender version must be exact");
  if(!scriptPath.endsWith(".py") || !outputPath.endsWith(".glb")) throw new Error("rock spec requires a Python script and GLB output");
  return parseAssetSpec({schemaVersion:1,assetId,generator:{id:"external.blender.script",version:"1"},randomness:{mode:"none"},
    inputs:{script:{path:scriptPath,sha256:scriptSha256}},models:{},parameters:{blenderVersion,arguments:normalizeRockParameters(parameters)},
    output:{path:outputPath},reproducibility:{expected:"exact"}});
}
export type RockVariant = { id: string; mesh: AssetRef; material?: AssetRef };
/** A slot assignment is declared separately from the immutable neutral master GLB. */
export function createRockVariantManifest(variants: RockVariant[]) {
  if(!Array.isArray(variants) || variants.length<1 || variants.length>64) throw new Error("rock variants must contain 1..64 entries");
  const ids=new Set<string>();
  const normalized=variants.map(variant=>{
    if(typeof variant.id!=="string" || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(variant.id)) throw new Error("invalid rock variant id");
    if(ids.has(variant.id)) throw new Error(`duplicate rock variant '${variant.id}'`);
    ids.add(variant.id);
    const mesh=createAssetRef(variant.mesh);
    if(mesh.kind!=="mesh" || mesh.mediaType!=="model/gltf-binary") throw new Error("rock variant requires a GLB mesh AssetRef");
    const material=variant.material===undefined?undefined:createAssetRef(variant.material);
    if(material && (material.kind!=="material" || material.mediaType!=="application/vnd.asset-tooling.pbr-material+json")) throw new Error("rock material must use the existing PBR material AssetRef contract");
    return {id:variant.id,mesh,...(material?{materialSlot:"rock-surface",material}:{})};
  }).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  return {schemaVersion:1,unit:"meter",axes:"right-handed-y-up",origin:"ground-contact-bounds-center",variants:normalized};
}
const defaults: RockParameters={schemaVersion:1,seed:"42",width:0.8,height:0.55,depth:0.7,subdivisions:3,angularity:0,flattening:0.2,irregularity:0.12,noiseScale:2.5};
export const ROCK_PRESETS=Object.freeze({
  rounded:Object.freeze({...defaults}),
  angular:Object.freeze({...defaults,angularity:0.8,irregularity:0.22,subdivisions:2}),
  flat:Object.freeze({...defaults,width:1.2,height:0.24,depth:0.8,flattening:0.9,angularity:0.3}),
  boulder:Object.freeze({...defaults,width:2.4,height:1.8,depth:2,subdivisions:4,irregularity:0.3,noiseScale:1.8}),
});
