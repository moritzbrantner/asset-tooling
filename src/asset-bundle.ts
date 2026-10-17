import { readDependencyLockSha256 } from "./dependency-lock.js";
/// <reference path="./gltf-validator.d.ts" />
import { ImageUtils, NodeIO, VERSION, type GLTF } from "@gltf-transform/core";
import { version as validatorVersion } from "gltf-validator";
import path from "node:path";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { canonicalJson, compareCodeUnitStrings } from "./canonical.js";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { sha256Bytes } from "./hash.js";
import { checkStaticGltfAccessorBudget, gltfSummary, parseCheckedGltfBytes, PRODUCTION_SUPERSEDED_VALIDATOR_CODES, validateGltf } from "./gltf-processing.js";
import { checkWeightSums, GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS, GLTF_WEIGHT_SUM_POLICY } from "./gltf-production-operations.js";
import { validateBytes } from "gltf-validator";
import { captureToolIdentity } from "./tool.js";
import { parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "./image-rgba8.js";
import { parseSpriteAtlasManifest, SPRITE_ATLAS_MEDIA_TYPE, type SpriteAtlasManifest } from "./sprite-atlas-operations.js";
import { createAssetOperationBuildIdentity, createAssetOperationDescriptor, createAssetRef, normalizeAssetOperationResult,
  createAssetOperationRegistry, parseAssetRef, type AssetRef, type AssetOperationBuildIdentity } from "./operations.js";

export const ASSET_BUNDLE_MEDIA_TYPE = "application/vnd.moritzbrantner.asset-bundle+json";
export const STATIC_ASSET_BUNDLE_PROFILE = "static-glb-png-v1";
export const SPRITE_ATLAS_BUNDLE_PROFILE = "sprite-atlas-png-v1";
/** PNG candidates approved by naming their exact sha256 in the export selection (Atlas Decision 4.1.3). */
export const APPROVED_IMAGE_BUNDLE_PROFILE = "approved-png-v1";
/** Skinned/animated GLBs exported as glTF JSON whose buffers and images are hash-addressed external files (#118 Q4, #110). */
export const GLTF_RESOURCES_BUNDLE_PROFILE = "gltf-resources-v1";
/** The scene.import.gltf@2 warning allowance, applied profile-wide and recorded in build identity and manifest. */
export const GLTF_RESOURCES_BUNDLE_ALLOWED_VALIDATOR_WARNINGS: readonly string[] = Object.freeze([...GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS]);
const MAX_ASSETS = 256, MAX_ASSET_BYTES = 64*1024*1024, MAX_BUNDLE_BYTES = 256*1024*1024, MAX_MANIFEST_BYTES = 8*1024*1024;
export type BundleAssetSelection = { key:string; variant:string };
export type AssetBundleParameters = { profile:typeof STATIC_ASSET_BUNDLE_PROFILE|typeof SPRITE_ATLAS_BUNDLE_PROFILE; assets:BundleAssetSelection[] };
export type AssetBundleEntry = BundleAssetSelection & { source:AssetRef; path:string };
export type AssetBundleManifest = { schemaVersion:1; profile:typeof STATIC_ASSET_BUNDLE_PROFILE; assets:AssetBundleEntry[] };
export type BundleResource = { source:AssetRef; path:string };
export type SpriteAtlasBundleEntry = AssetBundleEntry & { image:BundleResource };
export type SpriteAtlasBundleManifest = { schemaVersion:2; profile:typeof SPRITE_ATLAS_BUNDLE_PROFILE; assets:SpriteAtlasBundleEntry[]; resources:BundleResource[] };
export type BundleApproval = { sha256:string };
export type ApprovedBundleAssetSelection = BundleAssetSelection & { approved:BundleApproval };
export type ApprovedImageBundleParameters = { profile:typeof APPROVED_IMAGE_BUNDLE_PROFILE; assets:ApprovedBundleAssetSelection[] };
export type ApprovedImageBundleEntry = ApprovedBundleAssetSelection & { source:AssetRef; path:string };
export type ApprovedImageBundleManifest = { schemaVersion:3; profile:typeof APPROVED_IMAGE_BUNDLE_PROFILE; assets:ApprovedImageBundleEntry[] };
export type GltfResourcesAttachmentSelection = { name:string };
export type GltfResourcesBundleAssetSelection = BundleAssetSelection & { attachments?:GltfResourcesAttachmentSelection[] };
export type GltfResourcesBundleParameters = { profile:typeof GLTF_RESOURCES_BUNDLE_PROFILE; assets:GltfResourcesBundleAssetSelection[] };
export type GltfBundleResource = { uri:string; path:string; sha256:string; byteLength:number; mediaType:string };
export type GltfBundleAttachment = { name:string; source:AssetRef; path:string; sha256:string; byteLength:number; mediaType:string };
export type GltfBundleObservations = { skins:number; animations:string[]; triangles:number };
export type GltfResourcesBundleEntry = BundleAssetSelection & { source:AssetRef; path:string; sha256:string;
  resources:GltfBundleResource[]; attachments:GltfBundleAttachment[]; observations:GltfBundleObservations };
export type GltfResourcesBundleManifest = { schemaVersion:4; profile:typeof GLTF_RESOURCES_BUNDLE_PROFILE;
  policy:{ allowedValidatorWarnings:string[] }; assets:GltfResourcesBundleEntry[] };
export type AnyAssetBundleManifest = AssetBundleManifest|SpriteAtlasBundleManifest|ApprovedImageBundleManifest|GltfResourcesBundleManifest;
type BundleProfile = AssetBundleParameters["profile"]|typeof APPROVED_IMAGE_BUNDLE_PROFILE|typeof GLTF_RESOURCES_BUNDLE_PROFILE;
type Invocation = { parameters?:unknown; inputs?:unknown };
export type BundleExportProgress = { path:string; status:"changed"|"unchanged"; byteLength:number };
export type BundleExportOptions = { signal?:AbortSignal; onArtifact?:(artifact:BundleExportProgress)=>void|Promise<void> };
function parameterSchema(profile:string) {
  return {type:"object",additionalProperties:false,required:["profile","assets"],properties:{
    profile:{const:profile},assets:{type:"array",minItems:1,maxItems:MAX_ASSETS,items:{type:"object",additionalProperties:false,
      required:["key","variant"],properties:{key:{type:"string",pattern:"^[a-z0-9]+(?:[._-][a-z0-9]+)*$",maxLength:128},variant:{type:"string",pattern:"^[a-z0-9]+(?:[._-][a-z0-9]+)*$",maxLength:128}}}},
  }};
}

export const ASSET_BUNDLE_OPERATION = createAssetOperationDescriptor({
  schemaVersion:1,id:"asset.bundle",version:"1",label:"Package a selected static asset subset",category:"asset.packaging",
  inputs:[{id:"assets",assetKinds:["scene","mesh","image"],mediaTypes:["model/gltf-binary","image/png"],cardinality:{min:1,max:MAX_ASSETS}}],
  outputs:[{id:"manifest",assetKinds:["asset-bundle"],mediaTypes:[ASSET_BUNDLE_MEDIA_TYPE]}],
  parameterSchema:parameterSchema(STATIC_ASSET_BUNDLE_PROFILE),
});
const atlasRegistry=createAssetOperationRegistry([{
  ...ASSET_BUNDLE_OPERATION,version:"2",label:"Package selected sprite atlases and their PNG resources",
  inputs:[{id:"assets",assetKinds:["sprite-atlas"],mediaTypes:[SPRITE_ATLAS_MEDIA_TYPE],cardinality:{min:1,max:MAX_ASSETS}},
    {id:"images",assetKinds:["image"],mediaTypes:["image/png"],cardinality:{min:1,max:MAX_ASSETS}}],
  parameterSchema:parameterSchema(SPRITE_ATLAS_BUNDLE_PROFILE),
}]);
export const SPRITE_ATLAS_BUNDLE_OPERATION=atlasRegistry.get("asset.bundle","2")!;
const SELECTION_TOKEN_SCHEMA={type:"string",pattern:"^[a-z0-9]+(?:[._-][a-z0-9]+)*$",maxLength:128};
/** asset.bundle@3: package PNG candidates whose exact bytes the selection names as approved (Decision 4.1.3). */
export const APPROVED_IMAGE_BUNDLE_OPERATION = createAssetOperationDescriptor({
  schemaVersion:1,id:"asset.bundle",version:"3",label:"Package approved PNG candidates named by exact sha256",category:"asset.packaging",
  inputs:[{id:"assets",assetKinds:["image"],mediaTypes:["image/png"],cardinality:{min:1,max:MAX_ASSETS}}],
  outputs:[{id:"manifest",assetKinds:["asset-bundle"],mediaTypes:[ASSET_BUNDLE_MEDIA_TYPE]}],
  parameterSchema:{type:"object",additionalProperties:false,required:["profile","assets"],properties:{
    profile:{const:APPROVED_IMAGE_BUNDLE_PROFILE},assets:{type:"array",minItems:1,maxItems:MAX_ASSETS,items:{type:"object",additionalProperties:false,
      required:["key","variant","approved"],properties:{key:SELECTION_TOKEN_SCHEMA,variant:SELECTION_TOKEN_SCHEMA,
        approved:{type:"object",additionalProperties:false,required:["sha256"],properties:{sha256:{type:"string",pattern:"^[0-9a-f]{64}$"}}}}}},
  }},
});
const MAX_ATTACHMENTS = 16, MAX_SCENE_RESOURCES = 1024;
const GLTF_ATTACHMENT_MEDIA_TYPES: readonly string[] = ["application/json","model/gltf-binary"];
const GLTF_RESOURCE_EXTENSIONS: Readonly<Record<string,string>> = {"application/octet-stream":"bin","image/png":"png","image/jpeg":"jpg","image/webp":"webp","image/ktx2":"ktx2"};
/** asset.bundle@4: glTF scenes with hash-addressed external resources stored once, plus attachments (#118 Q4, #110). */
export const GLTF_RESOURCES_BUNDLE_OPERATION = createAssetOperationDescriptor({
  schemaVersion:1,id:"asset.bundle",version:"4",label:"Package GLB scenes as glTF with hash-addressed external resources and attachments",category:"asset.packaging",
  inputs:[{id:"assets",assetKinds:["scene"],mediaTypes:["model/gltf-binary"],cardinality:{min:1,max:MAX_ASSETS}},
    {id:"attachments",assetKinds:[],mediaTypes:[...GLTF_ATTACHMENT_MEDIA_TYPES],cardinality:{min:0,max:MAX_ASSETS*MAX_ATTACHMENTS},required:false}],
  outputs:[{id:"manifest",assetKinds:["asset-bundle"],mediaTypes:[ASSET_BUNDLE_MEDIA_TYPE]}],
  parameterSchema:{type:"object",additionalProperties:false,required:["profile","assets"],properties:{
    profile:{const:GLTF_RESOURCES_BUNDLE_PROFILE},assets:{type:"array",minItems:1,maxItems:MAX_ASSETS,items:{type:"object",additionalProperties:false,
      required:["key","variant"],properties:{key:SELECTION_TOKEN_SCHEMA,variant:SELECTION_TOKEN_SCHEMA,
        attachments:{type:"array",maxItems:MAX_ATTACHMENTS,items:{type:"object",additionalProperties:false,required:["name"],properties:{name:SELECTION_TOKEN_SCHEMA}}}}}},
  }},
});
function object(value:unknown,keys:string[],name:string):Record<string,unknown> {
  if(!value || typeof value!=="object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error(`${name} must be a plain object`);
  const result=value as Record<string,unknown>;
  if(Object.keys(result).some(k=>!keys.includes(k)) || keys.some(k=>!Object.hasOwn(result,k))) throw new Error(`${name} requires exactly ${keys.join(", ")}`);
  return result;
}
function token(value:unknown,name:string):string {
  if(typeof value!=="string" || value.length>128 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)) throw new Error(`${name} must be a portable lowercase token of at most 128 characters`);
  return value;
}
function selections(value:unknown):BundleAssetSelection[] {
  if(!Array.isArray(value) || value.length<1 || value.length>MAX_ASSETS) throw new Error("bundle must select 1..256 assets");
  const seen=new Set<string>();
  return value.map((entry,index)=>{
    const p=object(entry,["key","variant"],`bundle selection[${index}]`);
    const key=token(p.key,"asset key"),variant=token(p.variant,"asset variant"),pair=`${key}/${variant}`;
    if(seen.has(pair)) throw new Error(`duplicate bundle selection '${pair}'`);seen.add(pair);return {key,variant};
  });
}
function approvedSelections(value:unknown,fields:string[]):ApprovedBundleAssetSelection[] {
  if(!Array.isArray(value)) throw new Error("approved bundle must select 1..256 assets");
  const plain=selections(value.map((entry,index)=>{const e=object(entry,fields,`approved bundle selection[${index}]`);return {key:e.key,variant:e.variant};}));
  return plain.map((selection,index)=>{
    const approved=object((value[index] as Record<string,unknown>).approved,["sha256"],`approved bundle selection '${selection.key}/${selection.variant}' approval`);
    if(typeof approved.sha256!=="string" || !/^[0-9a-f]{64}$/.test(approved.sha256)) throw new Error(`approved sha256 of '${selection.key}/${selection.variant}' must be 64 lowercase hex characters`);
    return {...selection,approved:{sha256:approved.sha256}};
  });
}
function approvedParameters(value:unknown):ApprovedImageBundleParameters {
  const p=object(value,["profile","assets"],"approved bundle parameters");
  if(p.profile!==APPROVED_IMAGE_BUNDLE_PROFILE) throw new Error("unsupported bundle profile");
  return {profile:p.profile,assets:approvedSelections(p.assets,["key","variant","approved"])};
}
function isApprovedProfile(value:unknown):boolean {
  return !!value && typeof value==="object" && !Array.isArray(value) && (value as Record<string,unknown>).profile===APPROVED_IMAGE_BUNDLE_PROFILE;
}
function parameters(value:unknown):AssetBundleParameters {
  const p=object(value,["profile","assets"],"bundle parameters");
  if(p.profile!==STATIC_ASSET_BUNDLE_PROFILE && p.profile!==SPRITE_ATLAS_BUNDLE_PROFILE) throw new Error("unsupported bundle profile");
  return {profile:p.profile,assets:selections(p.assets)};
}
function compareEntries(a:BundleAssetSelection,b:BundleAssetSelection):number { return compareCodeUnitStrings(a.key,b.key)||compareCodeUnitStrings(a.variant,b.variant); }
function unreachable(value:never):never { throw new Error(`unsupported owned bundle variant: ${String(value)}`); }
function assetPath(source:AssetRef,profile:BundleProfile=STATIC_ASSET_BUNDLE_PROFILE):string {
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
   case GLTF_RESOURCES_BUNDLE_PROFILE: throw new Error(`${GLTF_RESOURCES_BUNDLE_PROFILE} paths are scene, resource and attachment specific`);
   default: return unreachable(profile);
  }
}
function checkBudget(entries:BundleResource[]):void {
  const lengths=new Map<string,number>();
  for(const entry of entries) {
    const previous=lengths.get(entry.path);
    if(previous!==undefined && previous!==entry.source.byteLength) throw new Error("conflicting byte lengths for identical bundle content");
    lengths.set(entry.path,entry.source.byteLength);
  }
  if([...lengths.values()].reduce((sum,n)=>sum+n,0)>MAX_BUNDLE_BYTES) throw new Error("bundle exceeds the 256 MiB unique payload budget");
}
function assertAbsolute(root:string):void { if(typeof root!=="string" || !path.isAbsolute(root)) throw new Error("bundle directory/root must be an absolute path"); }
function hasCode(error:unknown,code:string):boolean { return error instanceof Error && "code" in error && error.code===code; }
async function assertRegular(file:string,allowMissing=false):Promise<void> {
  try { const info=await lstat(file);if(info.isSymbolicLink() || !info.isFile()) throw new Error(`bundle file '${path.basename(file)}' must be a regular file`); }
  catch(error:unknown) { if(allowMissing && hasCode(error,"ENOENT")) return;throw error; }
}
async function assertDirectory(directory:string,allowMissing=false):Promise<void> {
  try { const info=await lstat(directory);if(info.isSymbolicLink() || !info.isDirectory()) throw new Error("bundle output directory must not be a symbolic link or file"); }
  catch(error:unknown) { if(allowMissing && hasCode(error,"ENOENT")) return;throw error; }
}
async function assertExportBoundary(root:string,directory:string):Promise<void> {
  assertAbsolute(root);assertAbsolute(directory);
  const relative=path.relative(root,directory),segments=relative.split(path.sep).map(segment=>segment.toLowerCase());
  if(segments.some(segment=>/[. ]$/.test(segment) || segment.includes(":")) || !relative || path.isAbsolute(relative) || segments[0]===".." || segments[0]===".git" || segments[0]===".asset-tooling" ||
     (segments[0]==="assets" && segments[1]==="canonical")) throw new Error("bundle export must be inside a separate declared output directory below its asset root");
  await assertDirectory(root);let prefix=root;
  for(const segment of relative.split(path.sep)) {prefix=path.join(prefix,segment);await assertDirectory(prefix,true);}
}
async function validatePayload(source:AssetRef,bytes:Buffer):Promise<void> {
  if(bytes.byteLength!==source.byteLength || sha256Bytes(bytes)!==source.sha256) throw new Error("bundle payload does not match its content pin");
  if(source.mediaType==="model/gltf-binary") {
    const { json } = await new NodeIO().setAllowNetwork(false).setStrictResources(true).binaryToJSON(bytes);
    checkStaticGltfAccessorBudget(json,"bundle");
    const parsed=await parseCheckedGltfBytes(source,bytes,Object.create(null),false);
    if(parsed.inventory.some(resource=>resource.storage==="external")) throw new Error("bundle GLB must have embedded resources");
  } else if(source.mediaType==="image/png") {
    const size=ImageUtils.getMimeType(bytes)==="image/png"?ImageUtils.getSize(bytes,"image/png"):null;
    if(!size || size.some(n=>!Number.isSafeInteger(n) || n<1 || n>4096)) throw new Error("bundle PNG must have valid header/dimensions in 1..4096");
  } else if(source.mediaType===SPRITE_ATLAS_MEDIA_TYPE) parseSpriteAtlasManifest(bytes);
  else if(source.mediaType===RGBA8_IMAGE_MEDIA_TYPE) boundedRgba(bytes);
  else throw new Error("unsupported bundle payload media type");
}
function boundedRgba(bytes:Buffer,expected?:{width:number;height:number}) {
  // Check declared dimensions before the existing parser allocates decoded pixels.
  const value:unknown=JSON.parse(bytes.toString("utf8"));
  if(!value || typeof value!=="object" || !("width" in value) || !("height" in value) ||
     typeof value.width!=="number" || typeof value.height!=="number" || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) ||
     value.width<1 || value.height<1 || value.width>4096 || value.height>4096 || value.width*value.height>4*1024*1024) throw new Error("atlas resource exceeds its 4096-axis/4-megapixel decode budget");
  return parseRgba8Image(bytes,expected);
}
function resource(value:unknown,mediaType:string):BundleResource {
  const e=object(value,["source","path"],"bundle resource"),source=parseAssetRef(e.source),portable=assetPath(source,SPRITE_ATLAS_BUNDLE_PROFILE);
  if(source.mediaType!==mediaType || e.path!==portable) throw new Error("bundle resource kind/media type/path does not match its content identity");
  return {source,path:portable};
}
function compareResources(a:BundleResource,b:BundleResource):number {
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
function parseAnyAssetBundleManifest(bytes:Uint8Array):AnyAssetBundleManifest {
  const raw=manifestJson(bytes),version=raw && typeof raw==="object" && "schemaVersion" in raw ? raw.schemaVersion : undefined;
  return version===2 ? parseAtlasBundle(raw) : version===3 ? parseApprovedBundle(raw) : version===4 ? parseGltfResourcesBundle(raw) : parseStaticBundle(raw);
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
function parseStaticBundle(raw:unknown):AssetBundleManifest {
  const p=object(raw,["schemaVersion","profile","assets"],"bundle manifest");
  if(p.schemaVersion!==1 || p.profile!==STATIC_ASSET_BUNDLE_PROFILE || !Array.isArray(p.assets)) throw new Error("unsupported bundle manifest schema/profile");
  const selected=selections(p.assets.map((entry,index)=>{const e=object(entry,["key","variant","source","path"],`bundle entry[${index}]`);return {key:e.key,variant:e.variant};}));
  const assets=p.assets.map((entry,index)=>{
    const e=object(entry,["key","variant","source","path"],"bundle entry"),source=createAssetRef(e.source),portablePath=assetPath(source);
    if(e.path!==portablePath) throw new Error("bundle resource path must match its content identity");
    return {...selected[index]!,source,path:portablePath};
  });
  checkBudget(assets);
  if(assets.some((entry,index)=>index>0 && compareEntries(assets[index-1]!,entry)>=0)) throw new Error("bundle entries must have stable key/variant ordering");
  return {schemaVersion:1,profile:STATIC_ASSET_BUNDLE_PROFILE,assets};
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
async function prepare(root:string,invocation:Invocation,signal?:AbortSignal) {
  signal?.throwIfAborted();assertAbsolute(root);
  if(isApprovedProfile(invocation.parameters)) return prepareApproved(root,approvedParameters(invocation.parameters),invocation.inputs,signal);
  if(isGltfResourcesProfile(invocation.parameters)) return prepareGltfResources(root,gltfResourcesParameters(invocation.parameters),invocation.inputs,signal);
  const p=parameters(invocation.parameters);
  switch(p.profile) {
    case SPRITE_ATLAS_BUNDLE_PROFILE: return prepareAtlas(root,p,invocation.inputs,signal);
    case STATIC_ASSET_BUNDLE_PROFILE: break;
    default: return unreachable(p.profile);
  }
  const inputs=object(invocation.inputs,["assets"],"bundle inputs");
  if(!Array.isArray(inputs.assets) || inputs.assets.length!==p.assets.length) throw new Error("one source AssetRef is required for each bundle selection");
  const refs=inputs.assets.map(createAssetRef),entries=p.assets.map((entry,index)=>({ ...entry,source:refs[index]!,path:assetPath(refs[index]!) })).sort(compareEntries);
  checkBudget(entries);const blobs=new Map<string,{source:AssetRef;bytes:Buffer}>();
  // Validate every declared dependency before inspecting/reusing any export file.
  for(const entry of entries) if(!blobs.has(entry.path)) {
    signal?.throwIfAborted();const bytes=await resolveAssetObject(root,entry.source);await validatePayload(entry.source,bytes);signal?.throwIfAborted();blobs.set(entry.path,{source:entry.source,bytes});
  }
  const build=createAssetOperationBuildIdentity({operation:ASSET_BUNDLE_OPERATION,parameters:{profile:p.profile,assets:entries.map(({key,variant})=>({key,variant}))},
    inputs:{assets:entries.map(entry=>entry.source)},implementation:{id:"builtin.asset.bundle",version:"1",profile:p.profile,
      gltfTransform:VERSION,validator:validatorVersion(),dependencyLockSha256:await readDependencyLockSha256(),tool:await captureToolIdentity()}});
  const manifest:AssetBundleManifest={schemaVersion:1,profile:p.profile,assets:entries};
  const bytes=Buffer.from(`${canonicalJson(manifest)}\n`);parseAssetBundleManifest(bytes);
  return {build,manifest,bytes,blobs};
}
type ReadResource=(source:AssetRef)=>Promise<Buffer>;
async function checkAtlas(entry:SpriteAtlasBundleEntry,read:ReadResource):Promise<{atlas:SpriteAtlasManifest;resources:BundleResource[]}> {
  const atlas=parseSpriteAtlasManifest(await read(entry.source));
  const image=boundedRgba(await read(atlas.image),{width:atlas.width,height:atlas.height});
  const png=await read(entry.image.source),size=ImageUtils.getSize(png,"image/png");
  const metadata=entry.image.source.metadata;
  if(!size || size[0]!==image.width || size[1]!==image.height || metadata.sourceSha256!==atlas.image.sha256 ||
     metadata.width!==image.width || metadata.height!==image.height || metadata.codec!=="png" || metadata.sourceColorSpace!=="srgb") throw new Error("atlas PNG must declare the original image pin and match its dimensions/color space");
  const resources:BundleResource[]=[{source:atlas.image,path:assetPath(atlas.image,SPRITE_ATLAS_BUNDLE_PROFILE)}];
  let sourcePixels=0;
  for(const sprite of atlas.sprites) {
    const source=boundedRgba(await read(sprite.source),sprite.sourceSize);
    sourcePixels+=source.width*source.height;
    if(sourcePixels>16*1024*1024) throw new Error("atlas sources exceed 16-megapixel budget");
    resources.push({source:sprite.source,path:assetPath(sprite.source,SPRITE_ATLAS_BUNDLE_PROFILE)});
  }
  return {atlas,resources};
}
function uniqueResources(resources:BundleResource[]):BundleResource[] {
  return [...new Map(resources.map(r=>[canonicalJson(r),r])).values()].sort(compareResources);
}
async function prepareAtlas(root:string,p:AssetBundleParameters,value:unknown,signal?:AbortSignal) {
  const inputs=object(value,["assets","images"],"atlas bundle inputs");
  if(!Array.isArray(inputs.assets) || !Array.isArray(inputs.images) || inputs.assets.length!==p.assets.length || inputs.images.length!==p.assets.length) throw new Error("one original atlas and PNG AssetRef is required for each selection");
  const refs=inputs.assets.map(createAssetRef),images=inputs.images.map(createAssetRef);
  const entries:SpriteAtlasBundleEntry[]=p.assets.map((e,i)=>({ ...e,source:refs[i]!,path:assetPath(refs[i]!,SPRITE_ATLAS_BUNDLE_PROFILE),
    image:{source:images[i]!,path:assetPath(images[i]!,SPRITE_ATLAS_BUNDLE_PROFILE)} })).sort(compareEntries);
  // Kind checks and initial budgets precede dependency reads.
  for(const e of entries) if(e.source.kind!=="sprite-atlas" || e.image.source.mediaType!=="image/png") throw new Error("atlas profile requires original atlas manifests and encoded PNGs");
  const declared:BundleResource[]=[...entries,...entries.map(e=>e.image)],resources:BundleResource[]=[];
  checkBudget(declared);
  const blobs=new Map<string,{source:AssetRef;bytes:Buffer}>();
  let canonicalReferences=0;
  const read:ReadResource=async source=>{
    signal?.throwIfAborted();const portable=assetPath(source,SPRITE_ATLAS_BUNDLE_PROFILE);
    if(source.mediaType===RGBA8_IMAGE_MEDIA_TYPE && ++canonicalReferences>4096) throw new Error("atlas bundle exceeds 4096 declared resource references");
    declared.push({source,path:portable});checkBudget(declared);
    const existing=blobs.get(portable);
    if(existing) {
      if(existing.source.byteLength!==source.byteLength) throw new Error("conflicting lengths for atlas dependency");
      return existing.bytes;
    }
    const bytes=await resolveAssetObject(root,source);await validatePayload(source,bytes);signal?.throwIfAborted();blobs.set(portable,{source,bytes});return bytes;
  };
  for(const entry of entries) {
    const checked=await checkAtlas(entry,read);resources.push(...checked.resources);
    if(resources.length>4096) throw new Error("atlas bundle exceeds 4096 declared resource references");
  }
  const manifest:SpriteAtlasBundleManifest={schemaVersion:2,profile:SPRITE_ATLAS_BUNDLE_PROFILE,assets:entries,resources:uniqueResources(resources)};
  const bytes=Buffer.from(`${canonicalJson(manifest)}\n`);parseSpriteAtlasBundleManifest(bytes);
  const build=createAssetOperationBuildIdentity({operation:SPRITE_ATLAS_BUNDLE_OPERATION,
    parameters:{profile:p.profile,assets:entries.map(({key,variant})=>({key,variant}))},
    inputs:{assets:entries.map(e=>e.source),images:entries.map(e=>e.image.source)},
    // Original atlas bytes pin the full nested resource refs; actual dependencies were verified above.
    implementation:{id:"builtin.asset.bundle",version:"2",profile:p.profile,algorithm:"original-atlas-png-pinned-closure-v1",gltfTransform:VERSION,
      dependencyLockSha256:await readDependencyLockSha256(),tool:await captureToolIdentity()}});
  return {build,manifest,bytes,blobs};
}
async function prepareApproved(root:string,p:ApprovedImageBundleParameters,value:unknown,signal?:AbortSignal) {
  const inputs=object(value,["assets"],"approved bundle inputs");
  if(!Array.isArray(inputs.assets) || inputs.assets.length!==p.assets.length) throw new Error("one candidate AssetRef is required for each approved bundle selection");
  const refs=inputs.assets.map(createAssetRef);
  // The selection's approval must name the exact candidate bytes; nothing is read or written before this holds.
  const entries:ApprovedImageBundleEntry[]=p.assets.map((selection,index)=>{
    const source=refs[index]!;
    if(source.sha256!==selection.approved.sha256) throw new Error(`candidate for '${selection.key}/${selection.variant}' is not the approved image: approved sha256 ${selection.approved.sha256}, candidate ${source.sha256}`);
    return {...selection,source,path:assetPath(source,APPROVED_IMAGE_BUNDLE_PROFILE)};
  }).sort(compareEntries);
  checkBudget(entries);const blobs=new Map<string,{source:AssetRef;bytes:Buffer}>();
  for(const entry of entries) if(!blobs.has(entry.path)) {
    signal?.throwIfAborted();let bytes:Buffer;
    try { bytes=await resolveAssetObject(root,entry.source); }
    catch(error:unknown) { throw new Error(`approved image ${entry.approved.sha256} for '${entry.key}/${entry.variant}' is not an intact stored candidate: ${error instanceof Error?error.message:String(error)}`); }
    if(sha256Bytes(bytes)!==entry.approved.sha256) throw new Error(`stored bytes for '${entry.key}/${entry.variant}' do not re-hash to the approved sha256`);
    await validatePayload(entry.source,bytes);signal?.throwIfAborted();blobs.set(entry.path,{source:entry.source,bytes});
  }
  const manifest:ApprovedImageBundleManifest={schemaVersion:3,profile:APPROVED_IMAGE_BUNDLE_PROFILE,assets:entries};
  const bytes=Buffer.from(`${canonicalJson(manifest)}\n`);parseApprovedImageBundleManifest(bytes);
  const build=createAssetOperationBuildIdentity({operation:APPROVED_IMAGE_BUNDLE_OPERATION,
    parameters:{profile:p.profile,assets:entries.map(({key,variant,approved})=>({key,variant,approved}))},
    inputs:{assets:entries.map(entry=>entry.source)},implementation:{id:"builtin.asset.bundle",version:"3",profile:p.profile,
      dependencyLockSha256:await readDependencyLockSha256(),tool:await captureToolIdentity()}});
  return {build,manifest,bytes,blobs};
}
export async function createAssetBundleBuildIdentity(root:string,invocation:Invocation={}):Promise<AssetOperationBuildIdentity> { return (await prepare(root,invocation)).build; }
async function storeManifest(root:string,prepared:Awaited<ReturnType<typeof prepare>>) {
  return (await storeAssetObject(root,{bytes:prepared.bytes,kind:"asset-bundle",mediaType:ASSET_BUNDLE_MEDIA_TYPE,
    metadata:{profile:prepared.manifest.profile,operation:prepared.build.operation,implementation:prepared.build.implementation,assetCount:prepared.manifest.assets.length,
      sourceSha256s:prepared.manifest.assets.map(entry=>entry.source.sha256)}})).asset;
}
export async function executeAssetBundleOperation(root:string,invocation:Invocation={}) {
  const prepared=await prepare(root,invocation),manifest=await storeManifest(root,prepared);
  return normalizeAssetOperationResult(bundleOperation(prepared.manifest),{outputs:{manifest},observations:{build:prepared.build,assetCount:prepared.manifest.assets.length,uniquePayloads:prepared.blobs.size}});
}
function bundleOperation(manifest:AnyAssetBundleManifest) {
  switch(manifest.schemaVersion) {
    case 1: return ASSET_BUNDLE_OPERATION;
    case 2: return SPRITE_ATLAS_BUNDLE_OPERATION;
    case 3: return APPROVED_IMAGE_BUNDLE_OPERATION;
    case 4: return GLTF_RESOURCES_BUNDLE_OPERATION;
    default: return unreachable(manifest);
  }
}
function bundleResources(manifest:AnyAssetBundleManifest):BundleResource[] {
  switch(manifest.schemaVersion) {
    case 4: return [];
    case 1: case 3: return manifest.assets;
    case 2: return [...manifest.assets,...manifest.assets.map(e=>e.image),...manifest.resources];
    default: return unreachable(manifest);
  }
}
async function writeAtomicIfChanged(directory:string,relative:string,bytes:Buffer,signal?:AbortSignal):Promise<"changed"|"unchanged"> {
  signal?.throwIfAborted();const target=path.join(directory,...relative.split("/"));await assertRegular(target,true);
  try { if((await lstat(target)).size===bytes.byteLength && (await readFile(target)).equals(bytes)) {signal?.throwIfAborted();return "unchanged";} }
  catch(error:unknown) { if(!hasCode(error,"ENOENT")) throw error; }
  const temporary=await mkdtemp(path.join(directory,".bundle-export-"));
  try { const staged=path.join(temporary,"payload");await writeFile(staged,bytes,{flag:"wx"});signal?.throwIfAborted();await rename(staged,target); }
  finally { await rm(temporary,{recursive:true,force:true}); }
  return "changed";
}
export async function exportAssetBundle(root:string,directory:string,invocation:Invocation={},options:BundleExportOptions={}) {
  options.signal?.throwIfAborted();await assertExportBoundary(root,directory);
  if(options.onArtifact!==undefined && typeof options.onArtifact!=="function") throw new Error("bundle onArtifact must be a function");
  const prepared=await prepare(root,invocation,options.signal);options.signal?.throwIfAborted();
  if(prepared.manifest.schemaVersion===3) return exportApproved(root,directory,prepared as PreparedApproved,options);
  if(prepared.manifest.schemaVersion===4) return exportGltfResources(root,directory,prepared as PreparedGltfResources,options);
  await assertDirectory(directory,true);await mkdir(directory,{recursive:true});await assertDirectory(path.join(directory,"assets"),true);await mkdir(path.join(directory,"assets"),{recursive:true});
  await assertRegular(path.join(directory,"manifest.json"),true);
  let blobsWritten=0,blobsReused=0,bytesWritten=0;
  for(const [portablePath,{bytes}] of prepared.blobs) {
    options.signal?.throwIfAborted();const status=await writeAtomicIfChanged(directory,portablePath,bytes,options.signal);
    if(status==="changed") {blobsWritten++;bytesWritten+=bytes.byteLength;} else blobsReused++;
    await options.onArtifact?.({path:portablePath,status,byteLength:bytes.byteLength});
  }
  const manifest=await storeManifest(root,prepared);options.signal?.throwIfAborted();
  // Sole commit point. Prior payloads remain available to readers holding the old manifest.
  const manifestStatus=await writeAtomicIfChanged(directory,"manifest.json",prepared.bytes,options.signal);
  if(manifestStatus==="changed") bytesWritten+=prepared.bytes.byteLength;
  return {manifest,manifestStatus,files:["manifest.json",...prepared.blobs.keys()].sort(compareCodeUnitStrings),assetsVerified:prepared.manifest.assets.length,blobsWritten,blobsReused,bytesWritten};
}
type PreparedApproved=Awaited<ReturnType<typeof prepareApproved>>;
/** Read a regular file without following a final symbolic link, so a swapped-in link cannot satisfy a pin check. */
async function readRegularNoFollow(file:string):Promise<Buffer> {
  await assertRegular(file);
  const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW ?? 0));
  try { if(!(await handle.stat()).isFile()) throw new Error(`bundle file '${path.basename(file)}' must be a regular file`);return await handle.readFile(); }
  finally { await handle.close(); }
}
/**
 * approved-png-v1 export. Same publication rules as @1/@2, plus: every payload is re-read without following symlinks and
 * re-hashed against its approval immediately before the manifest commit, and a failure before that commit rolls back
 * the payloads and directories this call added or changed, so a rejected approved export leaves the directory as it was.
 */
async function exportApproved(root:string,directory:string,prepared:PreparedApproved,options:BundleExportOptions) {
  await assertDirectory(directory,true);const assetsDirectory=path.join(directory,"assets");
  const createdTop=await mkdir(directory,{recursive:true});await assertDirectory(assetsDirectory,true);
  const assetsCreated=await mkdir(assetsDirectory,{recursive:true});
  await assertRegular(path.join(directory,"manifest.json"),true);
  const written=new Map<string,Buffer|undefined>();
  let blobsWritten=0,blobsReused=0,bytesWritten=0,manifestStatus:"changed"|"unchanged";
  try {
    for(const [portablePath,{bytes}] of prepared.blobs) {
      options.signal?.throwIfAborted();const target=path.join(directory,...portablePath.split("/"));await assertRegular(target,true);
      let previous:Buffer|undefined;
      try { previous=await readFile(target); } catch(error:unknown) { if(!hasCode(error,"ENOENT")) throw error; }
      if(!previous?.equals(bytes)) written.set(portablePath,previous);
      const status=await writeAtomicIfChanged(directory,portablePath,bytes,options.signal);
      if(status==="changed") {blobsWritten++;bytesWritten+=bytes.byteLength;} else {blobsReused++;written.delete(portablePath);}
      await options.onArtifact?.({path:portablePath,status,byteLength:bytes.byteLength});
    }
    const manifest=await storeManifest(root,prepared);options.signal?.throwIfAborted();
    await assertDirectory(directory);await assertDirectory(assetsDirectory);
    for(const entry of prepared.manifest.assets) {
      const bytes=await readRegularNoFollow(path.join(directory,...entry.path.split("/")));
      if(bytes.byteLength!==entry.source.byteLength || sha256Bytes(bytes)!==entry.approved.sha256) throw new Error(`exported payload for '${entry.key}/${entry.variant}' no longer matches its approved sha256; the manifest was not committed`);
    }
    // Sole commit point. Prior payloads remain available to readers holding the old manifest.
    manifestStatus=await writeAtomicIfChanged(directory,"manifest.json",prepared.bytes,options.signal);
    if(manifestStatus==="changed") bytesWritten+=prepared.bytes.byteLength;
    return {manifest,manifestStatus,files:["manifest.json",...prepared.blobs.keys()].sort(compareCodeUnitStrings),assetsVerified:prepared.manifest.assets.length,blobsWritten,blobsReused,bytesWritten};
  } catch(error:unknown) {
    await rollbackApproved(directory,written,createdTop,assetsCreated);throw error;
  }
}
async function rollbackApproved(directory:string,written:Map<string,Buffer|undefined>,createdTop:string|undefined,assetsCreated:string|undefined):Promise<void> {
  for(const [portablePath,previous] of written) {
    const target=path.join(directory,...portablePath.split("/"));
    try { await rm(target,{force:true});if(previous) await writeFile(target,previous,{flag:"wx"}); } catch { /* best effort; the original error is reported */ }
  }
  const created=[...(assetsCreated?[path.join(directory,"assets")]:[])];
  if(createdTop) for(let current=directory;;current=path.dirname(current)) {created.push(current);if(current===createdTop || path.dirname(current)===current) break;}
  for(const created_ of created) { try { await rmdir(created_); } catch { /* not empty or already gone */ } }
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
async function readPinned(directory:string,relative:string,source:AssetRef):Promise<Buffer> {
  await assertDirectory(directory);if(relative.startsWith("assets/")) await assertDirectory(path.join(directory,"assets"));
  const file=path.join(directory,...relative.split("/"));await assertRegular(file);
  if((await lstat(file)).size!==source.byteLength) throw new Error("packaged asset byte length does not match content pin");
  const bytes=await readFile(file);if(sha256Bytes(bytes)!==source.sha256) throw new Error("packaged asset hash does not match content pin");return bytes;
}
type BundleVerification<M extends AnyAssetBundleManifest>={manifest:M;assetsVerified:number;uniquePayloads:number};
export function verifyAssetBundle(directory:string,manifestValue:unknown,options?:{profile:typeof STATIC_ASSET_BUNDLE_PROFILE}):Promise<BundleVerification<AssetBundleManifest>>;
export function verifyAssetBundle(directory:string,manifestValue:unknown,options:{profile:typeof SPRITE_ATLAS_BUNDLE_PROFILE}):Promise<BundleVerification<SpriteAtlasBundleManifest>>;
export function verifyAssetBundle(directory:string,manifestValue:unknown,options:{profile:typeof APPROVED_IMAGE_BUNDLE_PROFILE}):Promise<BundleVerification<ApprovedImageBundleManifest>>;
export function verifyAssetBundle(directory:string,manifestValue:unknown,options:{profile:typeof GLTF_RESOURCES_BUNDLE_PROFILE}):Promise<BundleVerification<GltfResourcesBundleManifest>>;
export async function verifyAssetBundle(directory:string,manifestValue:unknown,options:{profile:BundleProfile}={profile:STATIC_ASSET_BUNDLE_PROFILE}):Promise<BundleVerification<AnyAssetBundleManifest>> {
  const selected=object(options,["profile"],"bundle verification profile");
  assertAbsolute(directory);const ref=createAssetRef(manifestValue);
  if(ref.kind!=="asset-bundle" || ref.mediaType!==ASSET_BUNDLE_MEDIA_TYPE || ref.byteLength>MAX_MANIFEST_BYTES) throw new Error("expected a pinned asset-bundle manifest within 8 MiB");
  const manifest=parseAnyAssetBundleManifest(await readPinned(directory,"manifest.json",ref)),verified=new Set<string>();
  if(manifest.profile!==selected.profile) throw new Error("bundle manifest does not match the explicitly selected verification profile");
  const resources=bundleResources(manifest);
  for(const entry of resources) if(!verified.has(entry.path)) {await validatePayload(entry.source,await readPinned(directory,entry.path,entry.source));verified.add(entry.path);}
  switch(manifest.schemaVersion) {
   case 1: case 3: break;
   case 4: return {manifest,assetsVerified:manifest.assets.length,uniquePayloads:await verifyGltfResources(directory,manifest)};
   case 2: {
    const expected:BundleResource[]=[];
    const declared=new Set(resources.map(r=>canonicalJson(r.source)));let canonicalReferences=0;
    const read:ReadResource=async source=>{
      if(!declared.has(canonicalJson(source))) throw new Error("atlas bundle resource closure omits a declared source");
      if(source.mediaType===RGBA8_IMAGE_MEDIA_TYPE && ++canonicalReferences>4096) throw new Error("atlas bundle exceeds 4096 declared resource references");
      return readPinned(directory,assetPath(source,SPRITE_ATLAS_BUNDLE_PROFILE),source);
    };
    for(const entry of manifest.assets) {
      const checked=await checkAtlas(entry,read);expected.push(...checked.resources);
      if(expected.length>4096) throw new Error("atlas bundle exceeds 4096 declared resource references");
    }
    if(canonicalJson(uniqueResources(expected))!==canonicalJson(manifest.resources)) throw new Error("atlas bundle resource closure is incomplete or contains undeclared resources");
    break;
   }
   default: return unreachable(manifest);
  }
  return {manifest,assetsVerified:manifest.assets.length,uniquePayloads:verified.size};
}
export async function readAssetBundleAsset(directory:string,manifest:AnyAssetBundleManifest,key:string,variant:string):Promise<Buffer> {
  assertAbsolute(directory);const entry=resolveAssetBundleEntry(parseAnyAssetBundleManifest(Buffer.from(canonicalJson(manifest))),key,variant);
  // A gltf-resources-v1 entry's file is the exported .gltf, pinned by its own sha256 rather than the source GLB's.
  if("resources" in entry) return readHashed(directory,entry.path,entry.sha256,undefined,MAX_MANIFEST_BYTES);
  return readPinned(directory,entry.path,entry.source);
}
/** Read the original atlas companion and selected runtime PNG from a verified package, without a source store. */
export async function readAssetBundleSpriteAtlas(directory:string,manifestValue:SpriteAtlasBundleManifest,key:string,variant:string) {
  assertAbsolute(directory);const manifest=parseSpriteAtlasBundleManifest(Buffer.from(canonicalJson(manifestValue)));
  const entry=manifest.assets.find(e=>e.key===key && e.variant===variant);token(key,"asset key");token(variant,"asset variant");
  if(!entry) throw new Error(`bundle does not contain '${key}/${variant}'`);
  const atlas=parseSpriteAtlasManifest(await readPinned(directory,entry.path,entry.source));
  return {atlas,image:entry.image.source,png:await readPinned(directory,entry.image.path,entry.image.source)};
}

// ─── gltf-resources-v1 (asset.bundle@4, #118 Q4, #110) ─────────────────────────────────────────────

type GltfJson = Record<string,any>;
type PreparedGltfFile = { bytes:Buffer };
const HEX64=/^[0-9a-f]{64}$/;
function isGltfResourcesProfile(value:unknown):boolean {
  return !!value && typeof value==="object" && !Array.isArray(value) && (value as Record<string,unknown>).profile===GLTF_RESOURCES_BUNDLE_PROFILE;
}
function attachmentNames(value:unknown,location:string):GltfResourcesAttachmentSelection[] {
  if(!Array.isArray(value) || value.length>MAX_ATTACHMENTS) throw new Error(`${location} attachments must be a list of at most ${MAX_ATTACHMENTS}`);
  const names=value.map((entry,index)=>({name:token(object(entry,["name"],`${location} attachment[${index}]`).name,"attachment name")}));
  if(new Set(names.map(n=>n.name)).size!==names.length) throw new Error(`${location} has duplicate attachment names`);
  return names;
}
function gltfResourcesParameters(value:unknown):GltfResourcesBundleParameters {
  const p=object(value,["profile","assets"],"gltf-resources bundle parameters");
  if(!Array.isArray(p.assets)) throw new Error("bundle must select 1..256 assets");
  const plain=selections(p.assets.map((entry,index)=>{
    const keys=entry && typeof entry==="object" && Object.hasOwn(entry,"attachments") ? ["key","variant","attachments"] : ["key","variant"];
    const e=object(entry,keys,`gltf-resources bundle selection[${index}]`);return {key:e.key,variant:e.variant};
  }));
  return {profile:GLTF_RESOURCES_BUNDLE_PROFILE,assets:plain.map((selection,index)=>{
    const raw=(p.assets as Record<string,unknown>[])[index]!;
    return Object.hasOwn(raw,"attachments") ? {...selection,attachments:attachmentNames(raw.attachments,`selection '${selection.key}/${selection.variant}'`)} : selection;
  })};
}
function gltfResourcePath(sha256:string,mediaType:string):string {
  const extension=GLTF_RESOURCE_EXTENSIONS[mediaType];
  if(!extension) throw new Error(`glTF resource media type '${mediaType}' is not supported by ${GLTF_RESOURCES_BUNDLE_PROFILE}`);
  return `resources/${sha256}.${extension}`;
}
function attachmentPath(source:AssetRef):string {
  if(source.byteLength<1 || source.byteLength>MAX_ASSET_BYTES) throw new Error("bundle attachment exceeds 64 MiB byte budget");
  if(source.mediaType==="application/json") return `attachments/${source.sha256}.json`;
  if(source.mediaType==="model/gltf-binary") return `attachments/${source.sha256}.glb`;
  throw new Error(`attachment media type '${source.mediaType}' is incompatible with ${GLTF_RESOURCES_BUNDLE_PROFILE}`);
}
function scenePath(key:string,variant:string):string { return `scenes/${key}/${variant}.gltf`; }
const RESOURCE_URI_PREFIX="../../";
/** Split a validated GLB container into its JSON and BIN chunk (declared buffer length). */
function glbChunks(bytes:Buffer):{json:GltfJson;bin:Buffer|undefined} {
  const jsonLength=bytes.readUInt32LE(12),json=JSON.parse(bytes.subarray(20,20+jsonLength).toString("utf8")) as GltfJson;
  const binStart=20+jsonLength;
  if(binStart+8>bytes.byteLength) return {json,bin:undefined};
  const binLength=bytes.readUInt32LE(binStart),declared=json.buffers?.[0]?.byteLength;
  if(bytes.readUInt32LE(binStart+4)!==0x004e4942 || typeof declared!=="number" || declared>binLength) throw new Error("bundle GLB BIN chunk does not hold its declared buffer");
  return {json,bin:bytes.subarray(binStart+8,binStart+8+declared)};
}
/**
 * Rewrite a GLB as glTF JSON: images become `../../resources/<sha256>.<ext>` files split out of their bufferViews,
 * and the remaining bufferViews are copied byte-for-byte into one `.bin` (offsets keep their 4-byte phase).
 */
function externalizeGlb(bytes:Buffer,location:string):{gltf:Buffer;files:(GltfBundleResource&PreparedGltfFile)[]} {
  const {json:source,bin}=glbChunks(bytes),json=structuredClone(source),views:GltfJson[]=json.bufferViews ?? [];
  const files=new Map<string,GltfBundleResource&PreparedGltfFile>();
  const add=(payload:Buffer,mediaType:string)=>{
    const sha256=sha256Bytes(payload),filePath=gltfResourcePath(sha256,mediaType),uri=`${RESOURCE_URI_PREFIX}${filePath}`;
    if(!files.has(filePath)) files.set(filePath,{uri,path:filePath,sha256,byteLength:payload.byteLength,mediaType,bytes:Buffer.from(payload)});
    return uri;
  };
  const accessorViews=new Set<number>();
  for(const accessor of json.accessors ?? []) for(const view of [accessor.bufferView,accessor.sparse?.indices?.bufferView,accessor.sparse?.values?.bufferView]) if(view!==undefined) accessorViews.add(view);
  const imageViews=new Set<number>();
  for(const [index,image] of (json.images ?? []).entries() as IterableIterator<[number,GltfJson]>) {
    if(image.uri!==undefined || image.bufferView===undefined) throw new Error(`${location}: /images/${index}: ${GLTF_RESOURCES_BUNDLE_PROFILE} requires GLB images stored in bufferViews`);
    const view=views[image.bufferView];
    if(!view || !bin || (view.buffer ?? 0)!==0 || accessorViews.has(image.bufferView)) throw new Error(`${location}: /images/${index}: image bufferView must be a dedicated view of the GLB buffer`);
    const start=view.byteOffset ?? 0,payload=bin.subarray(start,start+view.byteLength);
    const {bufferView:_bufferView,...rest}=image;
    json.images[index]={...rest,uri:add(payload,image.mimeType)};
    imageViews.add(image.bufferView);
  }
  const remap=new Map<number,number>(),kept:GltfJson[]=[],parts:Buffer[]=[];let offset=0;
  for(const [index,view] of views.entries()) {
    if(imageViews.has(index)) continue;
    if(!bin || (view.buffer ?? 0)!==0) throw new Error(`${location}: /bufferViews/${index}: bufferView must address the GLB buffer`);
    const start=view.byteOffset ?? 0,pad=((start%4)-(offset%4)+4)%4;
    if(pad) {parts.push(Buffer.alloc(pad));offset+=pad;}
    const {byteOffset:_byteOffset,...rest}=view;
    remap.set(index,kept.length);kept.push({...rest,buffer:0,...(offset?{byteOffset:offset}:{})});
    parts.push(bin.subarray(start,start+view.byteLength));offset+=view.byteLength;
  }
  for(const accessor of json.accessors ?? []) {
    if(accessor.bufferView!==undefined) accessor.bufferView=remap.get(accessor.bufferView);
    if(accessor.sparse) {accessor.sparse.indices.bufferView=remap.get(accessor.sparse.indices.bufferView);accessor.sparse.values.bufferView=remap.get(accessor.sparse.values.bufferView);}
  }
  if(kept.length) {json.bufferViews=kept;json.buffers=[{...json.buffers[0],byteLength:offset,uri:add(Buffer.concat(parts),"application/octet-stream")}];}
  else {delete json.bufferViews;delete json.buffers;}
  if(files.size>MAX_SCENE_RESOURCES) throw new Error(`${location} exceeds ${MAX_SCENE_RESOURCES} external resources`);
  const gltf=Buffer.from(`${canonicalJson(json)}\n`);
  if(gltf.byteLength>MAX_MANIFEST_BYTES) throw new Error(`${location} glTF JSON exceeds its 8 MiB byte budget`);
  return {gltf,files:[...files.values()].sort((a,b)=>compareCodeUnitStrings(a.path,b.path))};
}
/** Source GLB admission: the scene.import.gltf@2 loader, validator and weight-sum policy with the profile's warnings. */
async function checkSourceGlb(source:AssetRef,bytes:Buffer,location:string) {
  if(source.kind!=="scene" || source.mediaType!=="model/gltf-binary") throw new Error(`${location} must be a scene/model/gltf-binary AssetRef`);
  if(bytes.byteLength!==source.byteLength || sha256Bytes(bytes)!==source.sha256) throw new Error(`${location} payload does not match its content pin`);
  const { json } = await new NodeIO().setAllowNetwork(false).setStrictResources(true).binaryToJSON(bytes);
  checkStaticGltfAccessorBudget(json,location);
  const parsed=await parseCheckedGltfBytes(source,bytes,Object.create(null),true,GLTF_RESOURCES_BUNDLE_ALLOWED_VALIDATOR_WARNINGS);
  if(parsed.inventory.some(resource=>resource.storage!=="embedded")) throw new Error(`${location} must embed its buffers and images in the GLB`);
  checkWeightSums(parsed.document);
  return parsed.document;
}
function gltfObservations(document:Awaited<ReturnType<typeof checkSourceGlb>>):GltfBundleObservations {
  const root=document.getRoot();
  return {skins:root.listSkins().length,animations:root.listAnimations().map(animation=>animation.getName()),triangles:gltfSummary(document).triangleCount};
}
/** Validate an exported .gltf against exactly its listed resources, then load it with glTF Transform. */
async function checkExportedGltf(gltf:Buffer,resources:ReadonlyMap<string,Uint8Array>,location:string) {
  const json=JSON.parse(gltf.toString("utf8")) as GltfJson;
  const uris=[...(json.buffers ?? []),...(json.images ?? [])].map((entry:GltfJson)=>entry.uri);
  if(uris.some(uri=>typeof uri!=="string" || !resources.has(uri))) throw new Error(`${location} references a resource that its manifest entry does not list`);
  if(new Set(uris).size!==resources.size) throw new Error(`${location} manifest entry lists resources the glTF does not reference`);
  await validateGltf(gltf,"gltf",Object.create(null),location,GLTF_RESOURCES_BUNDLE_ALLOWED_VALIDATOR_WARNINGS,PRODUCTION_SUPERSEDED_VALIDATOR_CODES,[],uri=>resources.get(uri));
  checkStaticGltfAccessorBudget(json as GLTF.IGLTF,location);
  const document=await new NodeIO().setAllowNetwork(false).setStrictResources(true)
    .readJSON({json:json as GLTF.IGLTF,resources:Object.fromEntries([...resources].map(([uri,bytes])=>[uri,new Uint8Array(bytes)]))});
  checkWeightSums(document);
  return document;
}
async function checkAttachment(source:AssetRef,bytes:Buffer,location:string):Promise<void> {
  if(bytes.byteLength!==source.byteLength || sha256Bytes(bytes)!==source.sha256) throw new Error(`${location} payload does not match its content pin`);
  if(source.mediaType==="application/json") {
    if(bytes.byteLength>MAX_MANIFEST_BYTES) throw new Error(`${location} JSON attachment exceeds 8 MiB`);
    try { JSON.parse(bytes.toString("utf8")); } catch(error:unknown) { throw new Error(`${location} is not valid JSON: ${error instanceof Error?error.message:String(error)}`); }
  } else {
    const report=await validateBytes(bytes,{format:"glb",writeTimestamp:false,maxIssues:100,
      externalResourceFunction:async(uri:string)=>{throw new Error(`GLB attachment must be self-contained; external resource '${uri}'`);}});
    if(report.issues.numErrors) throw new Error(`${location} GLB attachment failed Khronos validation: ${report.issues.messages.filter(i=>i.severity===0).map(i=>`${i.pointer ?? "/"}: ${i.code}`).join("; ")}`);
  }
}
function gltfResourcesPolicy() { return {allowedValidatorWarnings:[...GLTF_RESOURCES_BUNDLE_ALLOWED_VALIDATOR_WARNINGS]}; }
async function prepareGltfResources(root:string,p:GltfResourcesBundleParameters,value:unknown,signal?:AbortSignal) {
  const inputs=value && typeof value==="object" && Object.hasOwn(value,"attachments") ? object(value,["assets","attachments"],"gltf-resources bundle inputs") : object(value,["assets"],"gltf-resources bundle inputs");
  const declaredAttachments=p.assets.reduce((sum,selection)=>sum+(selection.attachments?.length ?? 0),0);
  const attachmentInputs=inputs.attachments ?? [];
  if(!Array.isArray(inputs.assets) || inputs.assets.length!==p.assets.length) throw new Error("one source GLB AssetRef is required for each gltf-resources bundle selection");
  if(!Array.isArray(attachmentInputs) || attachmentInputs.length!==declaredAttachments) throw new Error("inputs.attachments must list one AssetRef per selected attachment, in selection order");
  const refs=inputs.assets.map(createAssetRef),attachmentRefs=attachmentInputs.map(createAssetRef);let cursor=0;
  const selected=p.assets.map((selection,index)=>{
    const source=refs[index]!;
    if(source.kind!=="scene" || source.mediaType!=="model/gltf-binary") throw new Error(`asset kind/media type '${source.kind}/${source.mediaType}' is incompatible with ${GLTF_RESOURCES_BUNDLE_PROFILE}`);
    if(source.byteLength<1 || source.byteLength>MAX_ASSET_BYTES) throw new Error("bundle asset exceeds 64 MiB byte budget");
    const attachments=(selection.attachments ?? []).map(({name})=>{const ref=attachmentRefs[cursor++]!;return {name,source:ref,path:attachmentPath(ref)};})
      .sort((a,b)=>compareCodeUnitStrings(a.name,b.name));
    return {key:selection.key,variant:selection.variant,source,attachments};
  }).sort(compareEntries);
  // Every declared dependency is read and checked before any export-file lookup.
  const blobs=new Map<string,PreparedGltfFile>(),sources=new Map<string,Buffer>();
  const read=async(ref:AssetRef)=>{
    signal?.throwIfAborted();const cached=sources.get(canonicalJson(ref));if(cached) return cached;
    const bytes=await resolveAssetObject(root,ref);signal?.throwIfAborted();sources.set(canonicalJson(ref),bytes);return bytes;
  };
  const assets:GltfResourcesBundleEntry[]=[];
  for(const entry of selected) {
    const location=`gltf-resources bundle '${entry.key}/${entry.variant}'`;
    const document=await checkSourceGlb(entry.source,await read(entry.source),location);
    const {gltf,files}=externalizeGlb(await read(entry.source),location);
    await checkExportedGltf(gltf,new Map(files.map(file=>[file.uri,file.bytes])),`${location} exported glTF`);
    const pathName=scenePath(entry.key,entry.variant);blobs.set(pathName,{bytes:gltf});
    for(const file of files) blobs.set(file.path,{bytes:file.bytes});
    const attachments:GltfBundleAttachment[]=[];
    for(const attachment of entry.attachments) {
      const bytes=await read(attachment.source);await checkAttachment(attachment.source,bytes,`${location} attachment '${attachment.name}'`);
      blobs.set(attachment.path,{bytes});
      attachments.push({name:attachment.name,source:attachment.source,path:attachment.path,sha256:attachment.source.sha256,byteLength:attachment.source.byteLength,mediaType:attachment.source.mediaType});
    }
    assets.push({key:entry.key,variant:entry.variant,source:entry.source,path:pathName,sha256:sha256Bytes(gltf),
      resources:files.map(({bytes:_bytes,...file})=>file),attachments,observations:gltfObservations(document)});
  }
  if([...blobs.values()].reduce((sum,blob)=>sum+blob.bytes.byteLength,0)>MAX_BUNDLE_BYTES) throw new Error("bundle exceeds the 256 MiB unique payload budget");
  const manifest:GltfResourcesBundleManifest={schemaVersion:4,profile:GLTF_RESOURCES_BUNDLE_PROFILE,policy:gltfResourcesPolicy(),assets};
  const bytes=Buffer.from(`${canonicalJson(manifest)}\n`);parseGltfResourcesBundleManifest(bytes);
  const build=createAssetOperationBuildIdentity({operation:GLTF_RESOURCES_BUNDLE_OPERATION,
    parameters:{profile:p.profile,assets:assets.map(({key,variant,attachments})=>({key,variant,attachments:attachments.map(({name})=>({name}))}))},
    inputs:{assets:assets.map(entry=>entry.source),attachments:assets.flatMap(entry=>entry.attachments.map(a=>a.source))},
    implementation:{id:"builtin.asset.bundle",version:"4",profile:p.profile,algorithm:"glb-to-gltf-hash-addressed-resources-v1",
      policy:{...gltfResourcesPolicy(),supersededValidatorCodes:[...PRODUCTION_SUPERSEDED_VALIDATOR_CODES],weightSums:GLTF_WEIGHT_SUM_POLICY},
      gltfTransform:VERSION,validator:validatorVersion(),dependencyLockSha256:await readDependencyLockSha256(),tool:await captureToolIdentity()}});
  return {build,manifest,bytes,blobs};
}
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
/** Read a packaged file below directory, rejecting links in any segment, and check its length/sha256. */
async function readHashed(directory:string,relative:string,sha256:string,byteLength:number|undefined,maxBytes:number):Promise<Buffer> {
  await assertDirectory(directory);let current=directory;const segments=relative.split("/");
  for(const segment of segments.slice(0,-1)) {current=path.join(current,segment);await assertDirectory(current);}
  const file=path.join(current,segments.at(-1)!);await assertRegular(file);
  const size=(await lstat(file)).size;
  if((byteLength!==undefined && size!==byteLength) || size>maxBytes) throw new Error(`packaged file '${relative}' byte length does not match its content pin`);
  const bytes=await readRegularNoFollow(file);
  if(sha256Bytes(bytes)!==sha256) throw new Error(`packaged file '${relative}' hash does not match its content pin`);
  return bytes;
}
async function readGltfEntry(directory:string,entry:GltfResourcesBundleEntry,cache:Map<string,Buffer>) {
  const gltf=await readHashed(directory,entry.path,entry.sha256,undefined,MAX_MANIFEST_BYTES),resources=new Map<string,Buffer>();
  for(const resource of entry.resources) {
    let bytes=cache.get(resource.path);
    if(!bytes) {bytes=await readHashed(directory,resource.path,resource.sha256,resource.byteLength,MAX_ASSET_BYTES);cache.set(resource.path,bytes);}
    resources.set(resource.uri,bytes);
  }
  const json=JSON.parse(gltf.toString("utf8")) as GltfJson;
  const uris=[...(json.buffers ?? []),...(json.images ?? [])].map((item:GltfJson)=>item.uri);
  if(uris.some(uri=>typeof uri!=="string" || !resources.has(uri)) || new Set(uris).size!==resources.size) throw new Error(`gltf-resources bundle entry '${entry.key}/${entry.variant}' resource closure does not match its glTF`);
  return {gltf,resources};
}
async function verifyGltfResources(directory:string,manifest:GltfResourcesBundleManifest):Promise<number> {
  const cache=new Map<string,Buffer>(),attachments=new Set<string>();
  for(const entry of manifest.assets) {
    const location=`gltf-resources bundle '${entry.key}/${entry.variant}'`,{gltf,resources}=await readGltfEntry(directory,entry,cache);
    const observations=gltfObservations(await checkExportedGltf(gltf,resources,`${location} glTF`));
    if(canonicalJson(observations)!==canonicalJson(entry.observations)) throw new Error(`${location} observations do not match its packaged glTF`);
    for(const attachment of entry.attachments) {
      if(attachments.has(attachment.path)) continue;
      await checkAttachment(attachment.source,await readHashed(directory,attachment.path,attachment.sha256,attachment.byteLength,MAX_ASSET_BYTES),`${location} attachment '${attachment.name}'`);
      attachments.add(attachment.path);
    }
  }
  return manifest.assets.length+cache.size+attachments.size;
}
/**
 * Read one verified gltf-resources-v1 scene without a source store: the .gltf bytes and every external resource
 * keyed by the exact URI the glTF uses. Every file's pin and the entry's resource closure are re-checked.
 */
export async function readAssetBundleGltf(directory:string,manifestValue:GltfResourcesBundleManifest,key:string,variant:string):Promise<{gltf:Buffer;resources:Map<string,Buffer>}> {
  assertAbsolute(directory);const manifest=parseGltfResourcesBundleManifest(Buffer.from(canonicalJson(manifestValue)));
  return readGltfEntry(directory,resolveAssetBundleEntry(manifest,key,variant),new Map());
}
/** Read one attachment of a verified gltf-resources-v1 entry by name, checking its pin. */
export async function readAssetBundleAttachment(directory:string,manifestValue:GltfResourcesBundleManifest,key:string,variant:string,name:string):Promise<Buffer> {
  assertAbsolute(directory);const manifest=parseGltfResourcesBundleManifest(Buffer.from(canonicalJson(manifestValue)));
  const attachment=resolveAssetBundleEntry(manifest,key,variant).attachments.find(a=>a.name===token(name,"attachment name"));
  if(!attachment) throw new Error(`bundle entry '${key}/${variant}' has no attachment '${name}'`);
  return readHashed(directory,attachment.path,attachment.sha256,attachment.byteLength,MAX_ASSET_BYTES);
}
/** The complete distribution file set of a parsed manifest: manifest.json plus every referenced payload path. */
export function listAssetBundleFiles(manifestValue:AnyAssetBundleManifest):string[] {
  const manifest=parseAnyAssetBundleManifest(Buffer.from(canonicalJson(manifestValue))),files=new Set(["manifest.json"]);
  if(manifest.schemaVersion===4) for(const entry of manifest.assets) for(const file of [entry,...entry.resources,...entry.attachments]) files.add(file.path);
  else for(const resource of bundleResources(manifest)) files.add(resource.path);
  return [...files].sort(compareCodeUnitStrings);
}
type PreparedGltfResources=Awaited<ReturnType<typeof prepareGltfResources>>;
/**
 * gltf-resources-v1 export. Content-addressed resources and attachments are published first, as in @1/@2. Scene
 * paths (`scenes/<key>/<variant>.gltf`) are not content-addressed, so they are written last, immediately before the
 * manifest commit; a failure or cancellation before that commit restores each scene file this call replaced (or
 * removes the ones it added), so the previously accepted manifest keeps verifying.
 */
async function exportGltfResources(root:string,directory:string,prepared:PreparedGltfResources,options:BundleExportOptions) {
  await assertDirectory(directory,true);await mkdir(directory,{recursive:true});
  for(const parent of [...new Set([...prepared.blobs.keys()].map(p=>path.posix.dirname(p)))].sort(compareCodeUnitStrings)) {
    let current=directory;for(const segment of parent.split("/")) {current=path.join(current,segment);await assertDirectory(current,true);await mkdir(current,{recursive:true});}
  }
  await assertRegular(path.join(directory,"manifest.json"),true);
  const ordered=[...prepared.blobs.keys()].sort((a,b)=>Number(a.startsWith("scenes/"))-Number(b.startsWith("scenes/")) || compareCodeUnitStrings(a,b));
  const replacedScenes=new Map<string,Buffer|undefined>();
  let blobsWritten=0,blobsReused=0,bytesWritten=0;
  try {
    for(const portablePath of ordered) {
      const {bytes}=prepared.blobs.get(portablePath)!;options.signal?.throwIfAborted();
      const target=path.join(directory,...portablePath.split("/"));
      if(portablePath.startsWith("scenes/")) {
        await assertRegular(target,true);let previous:Buffer|undefined;
        try { previous=await readFile(target); } catch(error:unknown) { if(!hasCode(error,"ENOENT")) throw error; }
        if(!previous?.equals(bytes)) replacedScenes.set(portablePath,previous);
      }
      const status=await writeAtomicIfChanged(directory,portablePath,bytes,options.signal);
      if(status==="changed") {blobsWritten++;bytesWritten+=bytes.byteLength;} else blobsReused++;
      await options.onArtifact?.({path:portablePath,status,byteLength:bytes.byteLength});
    }
    const manifest=await storeManifest(root,prepared);options.signal?.throwIfAborted();
    // Sole commit point.
    const manifestStatus=await writeAtomicIfChanged(directory,"manifest.json",prepared.bytes,options.signal);
    if(manifestStatus==="changed") bytesWritten+=prepared.bytes.byteLength;
    return {manifest,manifestStatus,files:["manifest.json",...prepared.blobs.keys()].sort(compareCodeUnitStrings),assetsVerified:prepared.manifest.assets.length,blobsWritten,blobsReused,bytesWritten};
  } catch(error:unknown) {
    for(const [portablePath,previous] of replacedScenes) {
      const target=path.join(directory,...portablePath.split("/"));
      try { if(previous) await writeAtomicIfChanged(directory,portablePath,previous);else await rm(target,{force:true}); } catch { /* best effort; the original error is reported */ }
    }
    throw error;
  }
}
