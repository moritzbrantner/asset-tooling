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
import { createAssetOperationBuildIdentity, createAssetOperationDescriptor, createAssetRef, normalizeAssetOperationResult,
  type AssetRef, type AssetOperationBuildIdentity } from "./operations.js";

export const ASSET_BUNDLE_MEDIA_TYPE = "application/vnd.moritzbrantner.asset-bundle+json";
export const STATIC_ASSET_BUNDLE_PROFILE = "static-glb-png-v1";
const MAX_ASSETS = 256, MAX_ASSET_BYTES = 64*1024*1024, MAX_BUNDLE_BYTES = 256*1024*1024, MAX_MANIFEST_BYTES = 8*1024*1024;
export type BundleAssetSelection = { key:string; variant:string };
export type AssetBundleParameters = { profile:typeof STATIC_ASSET_BUNDLE_PROFILE; assets:BundleAssetSelection[] };
export type AssetBundleEntry = BundleAssetSelection & { source:AssetRef; path:string };
export type AssetBundleManifest = { schemaVersion:1; profile:typeof STATIC_ASSET_BUNDLE_PROFILE; assets:AssetBundleEntry[] };
type Invocation = { parameters?:unknown; inputs?:unknown };
export type BundleExportProgress = { path:string; status:"changed"|"unchanged"; byteLength:number };
export type BundleExportOptions = { signal?:AbortSignal; onArtifact?:(artifact:BundleExportProgress)=>void|Promise<void> };

export const ASSET_BUNDLE_OPERATION = createAssetOperationDescriptor({
  schemaVersion:1,id:"asset.bundle",version:"1",label:"Package a selected static asset subset",category:"asset.packaging",
  inputs:[{id:"assets",assetKinds:["scene","mesh","image"],mediaTypes:["model/gltf-binary","image/png"],cardinality:{min:1,max:MAX_ASSETS}}],
  outputs:[{id:"manifest",assetKinds:["asset-bundle"],mediaTypes:[ASSET_BUNDLE_MEDIA_TYPE]}],
  parameterSchema:{type:"object",additionalProperties:false,required:["profile","assets"],properties:{
    profile:{const:STATIC_ASSET_BUNDLE_PROFILE},assets:{type:"array",minItems:1,maxItems:MAX_ASSETS,items:{type:"object",additionalProperties:false,
      required:["key","variant"],properties:{key:{type:"string",pattern:"^[a-z0-9]+(?:[._-][a-z0-9]+)*$",maxLength:128},variant:{type:"string",pattern:"^[a-z0-9]+(?:[._-][a-z0-9]+)*$",maxLength:128}}}},
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
function parameters(value:unknown):AssetBundleParameters {
  const p=object(value,["profile","assets"],"bundle parameters");
  if(p.profile!==STATIC_ASSET_BUNDLE_PROFILE) throw new Error("unsupported bundle profile");
  return {profile:STATIC_ASSET_BUNDLE_PROFILE,assets:selections(p.assets)};
}
function compareEntries(a:BundleAssetSelection,b:BundleAssetSelection):number { return compareCodeUnitStrings(a.key,b.key)||compareCodeUnitStrings(a.variant,b.variant); }
function assetPath(source:AssetRef):string {
  if(source.byteLength<1 || source.byteLength>MAX_ASSET_BYTES) throw new Error("bundle asset exceeds 64 MiB byte budget");
  if(source.mediaType==="model/gltf-binary" && ["scene","mesh"].includes(source.kind)) return `assets/${source.sha256}.glb`;
  if(source.mediaType==="image/png" && source.kind==="image") return `assets/${source.sha256}.png`;
  throw new Error(`asset kind/media type '${source.kind}/${source.mediaType}' is incompatible with ${STATIC_ASSET_BUNDLE_PROFILE}`);
}
function checkBudget(entries:AssetBundleEntry[]):void {
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
  } else throw new Error("unsupported bundle payload media type");
}
export function parseAssetBundleManifest(bytes:Uint8Array):AssetBundleManifest {
  if(!(bytes instanceof Uint8Array) || bytes.byteLength>MAX_MANIFEST_BYTES) throw new Error("bundle manifest exceeds its 8 MiB byte budget");
  const raw:unknown=JSON.parse(Buffer.from(bytes).toString("utf8")),p=object(raw,["schemaVersion","profile","assets"],"bundle manifest");
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
async function prepare(root:string,invocation:Invocation,signal?:AbortSignal) {
  signal?.throwIfAborted();assertAbsolute(root);const p=parameters(invocation.parameters),inputs=object(invocation.inputs,["assets"],"bundle inputs");
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
export async function createAssetBundleBuildIdentity(root:string,invocation:Invocation={}):Promise<AssetOperationBuildIdentity> { return (await prepare(root,invocation)).build; }
async function storeManifest(root:string,prepared:Awaited<ReturnType<typeof prepare>>) {
  return (await storeAssetObject(root,{bytes:prepared.bytes,kind:"asset-bundle",mediaType:ASSET_BUNDLE_MEDIA_TYPE,
    metadata:{profile:prepared.manifest.profile,operation:prepared.build.operation,implementation:prepared.build.implementation,assetCount:prepared.manifest.assets.length,
      sourceSha256s:prepared.manifest.assets.map(entry=>entry.source.sha256)}})).asset;
}
export async function executeAssetBundleOperation(root:string,invocation:Invocation={}) {
  const prepared=await prepare(root,invocation),manifest=await storeManifest(root,prepared);
  return normalizeAssetOperationResult(ASSET_BUNDLE_OPERATION,{outputs:{manifest},observations:{build:prepared.build,assetCount:prepared.manifest.assets.length,uniquePayloads:prepared.blobs.size}});
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
export function resolveAssetBundleEntry(manifest:AssetBundleManifest,key:string,variant:string):AssetBundleEntry {
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
export async function verifyAssetBundle(directory:string,manifestValue:unknown) {
  assertAbsolute(directory);const ref=createAssetRef(manifestValue);
  if(ref.kind!=="asset-bundle" || ref.mediaType!==ASSET_BUNDLE_MEDIA_TYPE || ref.byteLength>MAX_MANIFEST_BYTES) throw new Error("expected a pinned asset-bundle manifest within 8 MiB");
  const manifest=parseAssetBundleManifest(await readPinned(directory,"manifest.json",ref)),verified=new Set<string>();
  for(const entry of manifest.assets) if(!verified.has(entry.path)) {await validatePayload(entry.source,await readPinned(directory,entry.path,entry.source));verified.add(entry.path);}
  return {manifest,assetsVerified:manifest.assets.length,uniquePayloads:verified.size};
}
export async function readAssetBundleAsset(directory:string,manifest:AssetBundleManifest,key:string,variant:string):Promise<Buffer> {
  assertAbsolute(directory);const entry=resolveAssetBundleEntry(parseAssetBundleManifest(Buffer.from(canonicalJson(manifest))),key,variant);
  return readPinned(directory,entry.path,entry.source);
}
