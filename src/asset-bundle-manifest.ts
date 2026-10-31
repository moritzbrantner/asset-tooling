/** Strict parsing of selections and every manifest schema, content-addressed path rules, budgets and manifest storage. */
import { canonicalJson, compareCodeUnitStrings } from "./canonical.js";
import { storeAssetObject } from "./asset-store.js";
import { RGBA8_IMAGE_MEDIA_TYPE } from "./image-rgba8.js";
import { CANONICAL_AUDIO_MEDIA_TYPE } from "./audio.js";
import { SPRITE_ATLAS_MEDIA_TYPE } from "./sprite-atlas-operations.js";
import { createAssetRef, parseAssetRef, type AssetRef, type AssetOperationBuildIdentity } from "./operations.js";
import { APPROVED_IMAGE_BUNDLE_PROFILE, ASSET_BUNDLE_MEDIA_TYPE, AUDIO_BUNDLE_PROFILE, GLTF_RESOURCES_BUNDLE_ALLOWED_VALIDATOR_WARNINGS, GLTF_RESOURCES_BUNDLE_PROFILE,
  GLTF_RESOURCE_EXTENSIONS, MAX_ASSET_BYTES, MAX_ASSETS, MAX_ATTACHMENTS, MAX_BUNDLE_BYTES, MAX_MANIFEST_BYTES, MAX_SCENE_RESOURCES, SPRITE_ATLAS_BUNDLE_PROFILE, STATIC_ASSET_BUNDLE_PROFILE,
  type AnyAssetBundleManifest, type ApprovedBundleAssetSelection, type ApprovedImageBundleEntry, type ApprovedImageBundleManifest, type AssetBundleEntry, type AssetBundleManifest,
  type AudioBundleManifest, type BundleAssetSelection, type BundleProfile, type BundleResource, type GltfBundleAttachment, type GltfBundleResource, type GltfResourcesBundleEntry,
  type GltfResourcesBundleManifest, type SpriteAtlasBundleEntry, type SpriteAtlasBundleManifest } from "./asset-bundle-contract.js";

export function object(value:unknown,keys:string[],name:string):Record<string,unknown> {
  if(!value || typeof value!=="object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error(`${name} must be a plain object`);
  const result=value as Record<string,unknown>;
  if(Object.keys(result).some(k=>!keys.includes(k)) || keys.some(k=>!Object.hasOwn(result,k))) throw new Error(`${name} requires exactly ${keys.join(", ")}`);
  return result;
}
export function token(value:unknown,name:string):string {
  if(typeof value!=="string" || value.length>128 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)) throw new Error(`${name} must be a portable lowercase token of at most 128 characters`);
  return value;
}
export function selections(value:unknown):BundleAssetSelection[] {
  if(!Array.isArray(value) || value.length<1 || value.length>MAX_ASSETS) throw new Error("bundle must select 1..256 assets");
  const seen=new Set<string>();
  return value.map((entry,index)=>{
    const p=object(entry,["key","variant"],`bundle selection[${index}]`);
    const key=token(p.key,"asset key"),variant=token(p.variant,"asset variant"),pair=`${key}/${variant}`;
    if(seen.has(pair)) throw new Error(`duplicate bundle selection '${pair}'`);seen.add(pair);return {key,variant};
  });
}
export function approvedSelections(value:unknown,fields:string[]):ApprovedBundleAssetSelection[] {
  if(!Array.isArray(value)) throw new Error("approved bundle must select 1..256 assets");
  const plain=selections(value.map((entry,index)=>{const e=object(entry,fields,`approved bundle selection[${index}]`);return {key:e.key,variant:e.variant};}));
  return plain.map((selection,index)=>{
    const approved=object((value[index] as Record<string,unknown>).approved,["sha256"],`approved bundle selection '${selection.key}/${selection.variant}' approval`);
    if(typeof approved.sha256!=="string" || !/^[0-9a-f]{64}$/.test(approved.sha256)) throw new Error(`approved sha256 of '${selection.key}/${selection.variant}' must be 64 lowercase hex characters`);
    return {...selection,approved:{sha256:approved.sha256}};
  });
}
export function compareEntries(a:BundleAssetSelection,b:BundleAssetSelection):number { return compareCodeUnitStrings(a.key,b.key)||compareCodeUnitStrings(a.variant,b.variant); }
export function unreachable(value:never):never { throw new Error(`unsupported owned bundle variant: ${String(value)}`); }
export function assetPath(source:AssetRef,profile:BundleProfile=STATIC_ASSET_BUNDLE_PROFILE):string {
  if(source.byteLength<1 || source.byteLength>MAX_ASSET_BYTES) throw new Error("bundle asset exceeds 64 MiB byte budget");
  switch(profile) {
   case SPRITE_ATLAS_BUNDLE_PROFILE:
    if(source.kind==="sprite-atlas" && source.mediaType===SPRITE_ATLAS_MEDIA_TYPE) {
      if(source.byteLength>MAX_MANIFEST_BYTES) throw new Error("atlas manifest exceeds 8 MiB byte budget");
      return `assets/${source.sha256}.atlas.json`;
    }
    if(source.kind==="image" && source.mediaType===RGBA8_IMAGE_MEDIA_TYPE) return `assets/${source.sha256}.rgba.json`;
    if(source.kind==="image" && source.mediaType==="image/png") return `assets/${source.sha256}.png`;
    throw new Error("asset kind/media type is incompatible with sprite-atlas-png-v1");
   case STATIC_ASSET_BUNDLE_PROFILE:
    if(source.mediaType==="model/gltf-binary" && ["scene","mesh"].includes(source.kind)) return `assets/${source.sha256}.glb`;
    if(source.mediaType==="image/png" && source.kind==="image") return `assets/${source.sha256}.png`;
    throw new Error(`asset kind/media type '${source.kind}/${source.mediaType}' is incompatible with ${STATIC_ASSET_BUNDLE_PROFILE}`);
   case APPROVED_IMAGE_BUNDLE_PROFILE:
    if(source.mediaType==="image/png" && source.kind==="image") return `assets/${source.sha256}.png`;
    throw new Error(`asset kind/media type '${source.kind}/${source.mediaType}' is incompatible with ${APPROVED_IMAGE_BUNDLE_PROFILE}`);
   case AUDIO_BUNDLE_PROFILE:
    if(source.mediaType===CANONICAL_AUDIO_MEDIA_TYPE && source.kind==="audio") return `assets/${source.sha256}.wav`;
    if(source.mediaType==="application/json") {
      if(source.byteLength>MAX_MANIFEST_BYTES) throw new Error("bundle JSON descriptor exceeds 8 MiB byte budget");
      return `assets/${source.sha256}.json`;
    }
    throw new Error(`asset kind/media type '${source.kind}/${source.mediaType}' is incompatible with ${AUDIO_BUNDLE_PROFILE}`);
   case GLTF_RESOURCES_BUNDLE_PROFILE: throw new Error(`${GLTF_RESOURCES_BUNDLE_PROFILE} paths are scene, resource and attachment specific`);
   default: return unreachable(profile);
  }
}
export function checkBudget(entries:BundleResource[]):void {
  const lengths=new Map<string,number>();
  for(const entry of entries) {
    const previous=lengths.get(entry.path);
    if(previous!==undefined && previous!==entry.source.byteLength) throw new Error("conflicting byte lengths for identical bundle content");
    lengths.set(entry.path,entry.source.byteLength);
  }
  if([...lengths.values()].reduce((sum,n)=>sum+n,0)>MAX_BUNDLE_BYTES) throw new Error("bundle exceeds the 256 MiB unique payload budget");
}
function resource(value:unknown,mediaType:string):BundleResource {
  const e=object(value,["source","path"],"bundle resource"),source=parseAssetRef(e.source),portable=assetPath(source,SPRITE_ATLAS_BUNDLE_PROFILE);
  if(source.mediaType!==mediaType || e.path!==portable) throw new Error("bundle resource kind/media type/path does not match its content identity");
  return {source,path:portable};
}
export function compareResources(a:BundleResource,b:BundleResource):number {
  return compareCodeUnitStrings(a.path,b.path)||compareCodeUnitStrings(canonicalJson(a.source),canonicalJson(b.source));
}
function manifestJson(bytes:Uint8Array):unknown {
  if(!(bytes instanceof Uint8Array) || bytes.byteLength>MAX_MANIFEST_BYTES) throw new Error("bundle manifest exceeds its 8 MiB byte budget");
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}
export function parseAssetBundleManifest(bytes:Uint8Array):AssetBundleManifest { return parseStaticBundle(manifestJson(bytes)); }
export function parseSpriteAtlasBundleManifest(bytes:Uint8Array):SpriteAtlasBundleManifest { return parseAtlasBundle(manifestJson(bytes)); }
/** Parse an approved-png-v1 (schemaVersion 3) manifest; every entry's approval must name its packaged source bytes. */
export function parseApprovedImageBundleManifest(bytes:Uint8Array):ApprovedImageBundleManifest { return parseApprovedBundle(manifestJson(bytes)); }
export function parseAnyAssetBundleManifest(bytes:Uint8Array):AnyAssetBundleManifest {
  const raw=manifestJson(bytes),version=raw && typeof raw==="object" && "schemaVersion" in raw ? raw.schemaVersion : undefined;
  return version===2 ? parseAtlasBundle(raw) : version===3 ? parseApprovedBundle(raw) : version===4 ? parseGltfResourcesBundle(raw) : version===5 ? parseAudioBundle(raw) : parseStaticBundle(raw);
}
const APPROVED_ENTRY_FIELDS=["key","variant","approved","source","path"];
function parseApprovedBundle(raw:unknown):ApprovedImageBundleManifest {
  const p=object(raw,["schemaVersion","profile","assets"],"approved bundle manifest");
  if(p.schemaVersion!==3 || p.profile!==APPROVED_IMAGE_BUNDLE_PROFILE || !Array.isArray(p.assets)) throw new Error("unsupported bundle manifest schema/profile");
  const selected=approvedSelections(p.assets,APPROVED_ENTRY_FIELDS);
  const assets=p.assets.map((entry,index)=>{
    const e=object(entry,APPROVED_ENTRY_FIELDS,"approved bundle entry"),choice=selected[index]!,source=parseAssetRef(e.source),portablePath=assetPath(source,APPROVED_IMAGE_BUNDLE_PROFILE);
    if(source.sha256!==choice.approved.sha256) throw new Error(`approved sha256 of '${choice.key}/${choice.variant}' does not name its packaged source bytes`);
    if(e.path!==portablePath) throw new Error("bundle resource path must match its content identity");
    return {...choice,source,path:portablePath};
  });
  checkBudget(assets);
  if(assets.some((entry,index)=>index>0 && compareEntries(assets[index-1]!,entry)>=0)) throw new Error("bundle entries must have stable key/variant ordering");
  return {schemaVersion:3,profile:APPROVED_IMAGE_BUNDLE_PROFILE,assets};
}
function parseStaticBundle(raw:unknown):AssetBundleManifest { return {schemaVersion:1,profile:STATIC_ASSET_BUNDLE_PROFILE,assets:parseFlatEntries(raw,1,STATIC_ASSET_BUNDLE_PROFILE)}; }
/** Parse an audio-wav-v1 (schemaVersion 5) manifest. */
export function parseAudioBundleManifest(bytes:Uint8Array):AudioBundleManifest { return parseAudioBundle(manifestJson(bytes)); }
function parseAudioBundle(raw:unknown):AudioBundleManifest { return {schemaVersion:5,profile:AUDIO_BUNDLE_PROFILE,assets:parseFlatEntries(raw,5,AUDIO_BUNDLE_PROFILE)}; }
/** The {key, variant, source, path} entries shared by static-glb-png-v1 and audio-wav-v1. */
function parseFlatEntries(raw:unknown,schemaVersion:1|5,profile:typeof STATIC_ASSET_BUNDLE_PROFILE|typeof AUDIO_BUNDLE_PROFILE):AssetBundleEntry[] {
  const p=object(raw,["schemaVersion","profile","assets"],"bundle manifest");
  if(p.schemaVersion!==schemaVersion || p.profile!==profile || !Array.isArray(p.assets)) throw new Error("unsupported bundle manifest schema/profile");
  const selected=selections(p.assets.map((entry,index)=>{const e=object(entry,["key","variant","source","path"],`bundle entry[${index}]`);return {key:e.key,variant:e.variant};}));
  const assets=p.assets.map((entry,index)=>{
    const e=object(entry,["key","variant","source","path"],"bundle entry"),source=createAssetRef(e.source),portablePath=assetPath(source,profile);
    if(e.path!==portablePath) throw new Error("bundle resource path must match its content identity");
    return {...selected[index]!,source,path:portablePath};
  });
  checkBudget(assets);
  if(assets.some((entry,index)=>index>0 && compareEntries(assets[index-1]!,entry)>=0)) throw new Error("bundle entries must have stable key/variant ordering");
  return assets;
}
function parseAtlasBundle(value:unknown):SpriteAtlasBundleManifest {
  const p=object(value,["schemaVersion","profile","assets","resources"],"atlas bundle manifest");
  if(p.schemaVersion!==2 || p.profile!==SPRITE_ATLAS_BUNDLE_PROFILE || !Array.isArray(p.assets) || p.assets.length<1 || p.assets.length>MAX_ASSETS) throw new Error("unsupported atlas bundle schema/profile or selection count");
  const chosen=selections(p.assets.map(value=>{const e=object(value,["key","variant","source","path","image"],"atlas bundle entry");return {key:e.key,variant:e.variant};}));
  const assets:SpriteAtlasBundleEntry[]=p.assets.map((value,index)=>{
    const e=object(value,["key","variant","source","path","image"],"atlas bundle entry"),source=parseAssetRef(e.source),portable=assetPath(source,SPRITE_ATLAS_BUNDLE_PROFILE);
    if(source.kind!=="sprite-atlas" || e.path!==portable) throw new Error("atlas selection path/kind must match original manifest");
    return {...chosen[index]!,source,path:portable,image:resource(e.image,"image/png")};
  });
  if(!Array.isArray(p.resources) || p.resources.length<1 || p.resources.length>4096) throw new Error("atlas bundle must contain 1..4096 canonical resources");
  const resources=p.resources.map(value=>resource(value,RGBA8_IMAGE_MEDIA_TYPE));
  if(assets.some((e,i)=>i>0 && compareEntries(assets[i-1]!,e)>=0) || resources.some((e,i)=>i>0 && compareResources(resources[i-1]!,e)>=0)) throw new Error("atlas bundle entries/resources must have stable unique ordering");
  checkBudget([...assets,...assets.map(e=>e.image),...resources]);
  return {schemaVersion:2,profile:SPRITE_ATLAS_BUNDLE_PROFILE,assets,resources};
}
export async function storeManifest(root:string,prepared:{bytes:Buffer;manifest:AnyAssetBundleManifest;build:AssetOperationBuildIdentity}) {
  return (await storeAssetObject(root,{bytes:prepared.bytes,kind:"asset-bundle",mediaType:ASSET_BUNDLE_MEDIA_TYPE,
    metadata:{profile:prepared.manifest.profile,operation:prepared.build.operation,implementation:prepared.build.implementation,assetCount:prepared.manifest.assets.length,
      sourceSha256s:prepared.manifest.assets.map(entry=>entry.source.sha256)}})).asset;
}
export function bundleResources(manifest:AnyAssetBundleManifest):BundleResource[] {
  switch(manifest.schemaVersion) {
    case 4: return [];
    case 1: case 3: case 5: return manifest.assets;
    case 2: return [...manifest.assets,...manifest.assets.map(e=>e.image),...manifest.resources];
    default: return unreachable(manifest);
  }
}
export function resolveAssetBundleEntry(manifest:AssetBundleManifest,key:string,variant:string):AssetBundleEntry;
export function resolveAssetBundleEntry(manifest:SpriteAtlasBundleManifest,key:string,variant:string):SpriteAtlasBundleEntry;
export function resolveAssetBundleEntry(manifest:ApprovedImageBundleManifest,key:string,variant:string):ApprovedImageBundleEntry;
export function resolveAssetBundleEntry(manifest:GltfResourcesBundleManifest,key:string,variant:string):GltfResourcesBundleEntry;
export function resolveAssetBundleEntry(manifest:AnyAssetBundleManifest,key:string,variant:string):AssetBundleEntry|SpriteAtlasBundleEntry|ApprovedImageBundleEntry|GltfResourcesBundleEntry;
export function resolveAssetBundleEntry(manifest:AnyAssetBundleManifest,key:string,variant:string):AssetBundleEntry|SpriteAtlasBundleEntry|ApprovedImageBundleEntry|GltfResourcesBundleEntry {
  token(key,"asset key");token(variant,"asset variant");
  const entry=manifest.assets.find(asset=>asset.key===key && asset.variant===variant);
  if(!entry) throw new Error(`bundle does not contain '${key}/${variant}'`);return entry;
}
const HEX64=/^[0-9a-f]{64}$/;
export function gltfResourcePath(sha256:string,mediaType:string):string {
  const extension=GLTF_RESOURCE_EXTENSIONS[mediaType];
  if(!extension) throw new Error(`glTF resource media type '${mediaType}' is not supported by ${GLTF_RESOURCES_BUNDLE_PROFILE}`);
  return `resources/${sha256}.${extension}`;
}
export function attachmentPath(source:AssetRef):string {
  if(source.byteLength<1 || source.byteLength>MAX_ASSET_BYTES) throw new Error("bundle attachment exceeds 64 MiB byte budget");
  if(source.mediaType==="application/json") return `attachments/${source.sha256}.json`;
  if(source.mediaType==="model/gltf-binary") return `attachments/${source.sha256}.glb`;
  throw new Error(`attachment media type '${source.mediaType}' is incompatible with ${GLTF_RESOURCES_BUNDLE_PROFILE}`);
}
export function scenePath(key:string,variant:string):string { return `scenes/${key}/${variant}.gltf`; }
export const RESOURCE_URI_PREFIX="../../";
export function gltfResourcesPolicy() { return {allowedValidatorWarnings:[...GLTF_RESOURCES_BUNDLE_ALLOWED_VALIDATOR_WARNINGS]}; }
function exactInteger(value:unknown,min:number,max:number,name:string):number {
  if(typeof value!=="number" || !Number.isSafeInteger(value) || value<min || value>max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return value;
}
function hex(value:unknown,name:string):string { if(typeof value!=="string" || !HEX64.test(value)) throw new Error(`${name} must be 64 lowercase hex characters`);return value; }
/** Parse a gltf-resources-v1 (schemaVersion 4) manifest: shape, content-addressed paths, sorting and budgets. */
export function parseGltfResourcesBundleManifest(bytes:Uint8Array):GltfResourcesBundleManifest { return parseGltfResourcesBundle(manifestJson(bytes)); }
const GLTF_ENTRY_FIELDS=["key","variant","source","path","sha256","resources","attachments","observations"];
function parseGltfResourcesBundle(raw:unknown):GltfResourcesBundleManifest {
  const p=object(raw,["schemaVersion","profile","policy","assets"],"gltf-resources bundle manifest");
  if(p.schemaVersion!==4 || p.profile!==GLTF_RESOURCES_BUNDLE_PROFILE || !Array.isArray(p.assets)) throw new Error("unsupported bundle manifest schema/profile");
  const policy=object(p.policy,["allowedValidatorWarnings"],"gltf-resources bundle policy");
  if(canonicalJson(policy.allowedValidatorWarnings)!==canonicalJson(gltfResourcesPolicy().allowedValidatorWarnings)) throw new Error(`gltf-resources bundle policy must allow exactly ${GLTF_RESOURCES_BUNDLE_ALLOWED_VALIDATOR_WARNINGS.join(", ")}`);
  const chosen=selections(p.assets.map((entry,index)=>{const e=object(entry,GLTF_ENTRY_FIELDS,`gltf-resources bundle entry[${index}]`);return {key:e.key,variant:e.variant};}));
  const sizes=new Map<string,number>();
  const sized=(filePath:string,byteLength:number)=>{const previous=sizes.get(filePath);if(previous!==undefined && previous!==byteLength) throw new Error("conflicting byte lengths for identical bundle content");sizes.set(filePath,byteLength);};
  const assets=p.assets.map((entry,index):GltfResourcesBundleEntry=>{
    const e=object(entry,GLTF_ENTRY_FIELDS,"gltf-resources bundle entry"),{key,variant}=chosen[index]!,location=`gltf-resources bundle entry '${key}/${variant}'`;
    const source=parseAssetRef(e.source);
    if(source.kind!=="scene" || source.mediaType!=="model/gltf-binary" || source.byteLength>MAX_ASSET_BYTES) throw new Error(`${location} source must be a scene GLB within 64 MiB`);
    if(e.path!==scenePath(key,variant)) throw new Error(`${location} path must be ${scenePath(key,variant)}`);
    if(!Array.isArray(e.resources) || e.resources.length<1 || e.resources.length>MAX_SCENE_RESOURCES) throw new Error(`${location} must list 1..${MAX_SCENE_RESOURCES} resources`);
    const resources=e.resources.map((value):GltfBundleResource=>{
      const r=object(value,["uri","path","sha256","byteLength","mediaType"],`${location} resource`),sha256=hex(r.sha256,`${location} resource sha256`);
      const filePath=gltfResourcePath(sha256,typeof r.mediaType==="string"?r.mediaType:"");
      if(r.path!==filePath || r.uri!==`${RESOURCE_URI_PREFIX}${filePath}`) throw new Error(`${location} resource path/uri must match its content identity`);
      const byteLength=exactInteger(r.byteLength,1,MAX_ASSET_BYTES,`${location} resource byteLength`);sized(filePath,byteLength);
      return {uri:r.uri,path:filePath,sha256,byteLength,mediaType:r.mediaType as string};
    });
    if(resources.some((r,i)=>i>0 && compareCodeUnitStrings(resources[i-1]!.path,r.path)>=0)) throw new Error(`${location} resources must be uniquely sorted by path`);
    if(!Array.isArray(e.attachments) || e.attachments.length>MAX_ATTACHMENTS) throw new Error(`${location} must list at most ${MAX_ATTACHMENTS} attachments`);
    const attachments=e.attachments.map((value):GltfBundleAttachment=>{
      const a=object(value,["name","source","path","sha256","byteLength","mediaType"],`${location} attachment`),name=token(a.name,"attachment name"),attached=parseAssetRef(a.source);
      if(a.path!==attachmentPath(attached) || a.sha256!==attached.sha256 || a.byteLength!==attached.byteLength || a.mediaType!==attached.mediaType) throw new Error(`${location} attachment '${name}' must match its source content identity`);
      sized(attachmentPath(attached),attached.byteLength);
      return {name,source:attached,path:attachmentPath(attached),sha256:attached.sha256,byteLength:attached.byteLength,mediaType:attached.mediaType};
    });
    if(attachments.some((a,i)=>i>0 && compareCodeUnitStrings(attachments[i-1]!.name,a.name)>=0)) throw new Error(`${location} attachments must be uniquely sorted by name`);
    const o=object(e.observations,["skins","animations","triangles"],`${location} observations`);
    if(!Array.isArray(o.animations) || o.animations.some(name=>typeof name!=="string")) throw new Error(`${location} observations.animations must list animation names`);
    return {key,variant,source,path:e.path,sha256:hex(e.sha256,`${location} sha256`),resources,attachments,
      observations:{skins:exactInteger(o.skins,0,1_000_000,"skins"),animations:[...o.animations as string[]],triangles:exactInteger(o.triangles,0,Number.MAX_SAFE_INTEGER,"triangles")}};
  });
  if(assets.some((entry,index)=>index>0 && compareEntries(assets[index-1]!,entry)>=0)) throw new Error("bundle entries must have stable key/variant ordering");
  if([...sizes.values()].reduce((sum,n)=>sum+n,0)>MAX_BUNDLE_BYTES) throw new Error("bundle exceeds the 256 MiB unique payload budget");
  return {schemaVersion:4,profile:GLTF_RESOURCES_BUNDLE_PROFILE,policy:gltfResourcesPolicy(),assets};
}
/** The complete distribution file set of a parsed manifest: manifest.json plus every referenced payload path. */
export function listAssetBundleFiles(manifestValue:AnyAssetBundleManifest):string[] {
  const manifest=parseAnyAssetBundleManifest(Buffer.from(canonicalJson(manifestValue))),files=new Set(["manifest.json"]);
  if(manifest.schemaVersion===4) for(const entry of manifest.assets) for(const file of [entry,...entry.resources,...entry.attachments]) files.add(file.path);
  else for(const resource of bundleResources(manifest)) files.add(resource.path);
  return [...files].sort(compareCodeUnitStrings);
}
