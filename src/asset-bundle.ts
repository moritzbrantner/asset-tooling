import { readDependencyLockSha256 } from "./dependency-lock.js";
/// <reference path="./gltf-validator.d.ts" />
import { ImageUtils, NodeIO, VERSION } from "@gltf-transform/core";
import { version as validatorVersion } from "gltf-validator";
import path from "node:path";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { canonicalJson, compareCodeUnitStrings } from "./canonical.js";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { sha256Bytes } from "./hash.js";
import { checkStaticGltfAccessorBudget, parseCheckedGltfBytes } from "./gltf-processing.js";
import { captureToolIdentity } from "./tool.js";
import { parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "./image-rgba8.js";
import { parseSpriteAtlasManifest, SPRITE_ATLAS_MEDIA_TYPE, type SpriteAtlasManifest } from "./sprite-atlas-operations.js";
import { createAssetOperationBuildIdentity, createAssetOperationDescriptor, createAssetRef, normalizeAssetOperationResult,
  createAssetOperationRegistry, parseAssetRef, type AssetRef, type AssetOperationBuildIdentity } from "./operations.js";

export const ASSET_BUNDLE_MEDIA_TYPE = "application/vnd.moritzbrantner.asset-bundle+json";
export const STATIC_ASSET_BUNDLE_PROFILE = "static-glb-png-v1";
export const SPRITE_ATLAS_BUNDLE_PROFILE = "sprite-atlas-png-v1";
const MAX_ASSETS = 256, MAX_ASSET_BYTES = 64*1024*1024, MAX_BUNDLE_BYTES = 256*1024*1024, MAX_MANIFEST_BYTES = 8*1024*1024;
export type BundleAssetSelection = { key:string; variant:string };
export type AssetBundleParameters = { profile:typeof STATIC_ASSET_BUNDLE_PROFILE|typeof SPRITE_ATLAS_BUNDLE_PROFILE; assets:BundleAssetSelection[] };
export type AssetBundleEntry = BundleAssetSelection & { source:AssetRef; path:string };
export type AssetBundleManifest = { schemaVersion:1; profile:typeof STATIC_ASSET_BUNDLE_PROFILE; assets:AssetBundleEntry[] };
export type BundleResource = { source:AssetRef; path:string };
export type SpriteAtlasBundleEntry = AssetBundleEntry & { image:BundleResource };
export type SpriteAtlasBundleManifest = { schemaVersion:2; profile:typeof SPRITE_ATLAS_BUNDLE_PROFILE; assets:SpriteAtlasBundleEntry[]; resources:BundleResource[] };
export type AnyAssetBundleManifest = AssetBundleManifest|SpriteAtlasBundleManifest;
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
function parameters(value:unknown):AssetBundleParameters {
  const p=object(value,["profile","assets"],"bundle parameters");
  if(p.profile!==STATIC_ASSET_BUNDLE_PROFILE && p.profile!==SPRITE_ATLAS_BUNDLE_PROFILE) throw new Error("unsupported bundle profile");
  return {profile:p.profile,assets:selections(p.assets)};
}
function compareEntries(a:BundleAssetSelection,b:BundleAssetSelection):number { return compareCodeUnitStrings(a.key,b.key)||compareCodeUnitStrings(a.variant,b.variant); }
function unreachable(value:never):never { throw new Error(`unsupported owned bundle variant: ${String(value)}`); }
function assetPath(source:AssetRef,profile:AssetBundleParameters["profile"]=STATIC_ASSET_BUNDLE_PROFILE):string {
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
function parseAnyAssetBundleManifest(bytes:Uint8Array):AnyAssetBundleManifest {
  const raw=manifestJson(bytes);
  return raw && typeof raw==="object" && "schemaVersion" in raw && raw.schemaVersion===2 ? parseAtlasBundle(raw) : parseStaticBundle(raw);
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
  signal?.throwIfAborted();assertAbsolute(root);const p=parameters(invocation.parameters);
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
    default: return unreachable(manifest);
  }
}
function bundleResources(manifest:AnyAssetBundleManifest):BundleResource[] {
  switch(manifest.schemaVersion) {
    case 1: return manifest.assets;
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
export function resolveAssetBundleEntry(manifest:AssetBundleManifest,key:string,variant:string):AssetBundleEntry;
export function resolveAssetBundleEntry(manifest:SpriteAtlasBundleManifest,key:string,variant:string):SpriteAtlasBundleEntry;
export function resolveAssetBundleEntry(manifest:AnyAssetBundleManifest,key:string,variant:string):AssetBundleEntry|SpriteAtlasBundleEntry;
export function resolveAssetBundleEntry(manifest:AnyAssetBundleManifest,key:string,variant:string):AssetBundleEntry|SpriteAtlasBundleEntry {
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
export async function verifyAssetBundle(directory:string,manifestValue:unknown,options:{profile:AssetBundleParameters["profile"]}={profile:STATIC_ASSET_BUNDLE_PROFILE}):Promise<BundleVerification<AnyAssetBundleManifest>> {
  const selected=object(options,["profile"],"bundle verification profile");
  assertAbsolute(directory);const ref=createAssetRef(manifestValue);
  if(ref.kind!=="asset-bundle" || ref.mediaType!==ASSET_BUNDLE_MEDIA_TYPE || ref.byteLength>MAX_MANIFEST_BYTES) throw new Error("expected a pinned asset-bundle manifest within 8 MiB");
  const manifest=parseAnyAssetBundleManifest(await readPinned(directory,"manifest.json",ref)),verified=new Set<string>();
  if(manifest.profile!==selected.profile) throw new Error("bundle manifest does not match the explicitly selected verification profile");
  const resources=bundleResources(manifest);
  for(const entry of resources) if(!verified.has(entry.path)) {await validatePayload(entry.source,await readPinned(directory,entry.path,entry.source));verified.add(entry.path);}
  switch(manifest.schemaVersion) {
   case 1: break;
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
