/** gltf-resources-v1 (asset.bundle@4, #118 Q4, #110): GLB externalization, source and export checks, and its prepare, verify, read and export paths. */
/// <reference path="./gltf-validator.d.ts" />
import { readDependencyLockSha256 } from "./dependency-lock.js";
import { NodeIO, VERSION, type GLTF } from "@gltf-transform/core";
import { validateBytes, version as validatorVersion } from "gltf-validator";
import path from "node:path";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { canonicalJson, compareCodeUnitStrings } from "./canonical.js";
import { resolveAssetObject } from "./asset-store.js";
import { sha256Bytes } from "./hash.js";
import { checkStaticGltfAccessorBudget, gltfSummary, parseCheckedGltfBytes, PRODUCTION_SUPERSEDED_VALIDATOR_CODES, validateGltf } from "./gltf-processing.js";
import { checkWeightSums, GLTF_WEIGHT_SUM_POLICY } from "./gltf-production-operations.js";
import { captureToolIdentity } from "./tool.js";
import { createAssetOperationBuildIdentity, createAssetRef, type AssetRef } from "./operations.js";
import { GLTF_RESOURCES_BUNDLE_ALLOWED_VALIDATOR_WARNINGS, GLTF_RESOURCES_BUNDLE_OPERATION, GLTF_RESOURCES_BUNDLE_PROFILE, MAX_ASSET_BYTES, MAX_ATTACHMENTS, MAX_BUNDLE_BYTES, MAX_MANIFEST_BYTES, MAX_SCENE_RESOURCES,
  type BundleExportOptions, type GltfBundleAttachment, type GltfBundleObservations, type GltfBundleResource, type GltfResourcesAttachmentSelection, type GltfResourcesBundleEntry,
  type GltfResourcesBundleManifest, type GltfResourcesBundleParameters } from "./asset-bundle-contract.js";
import { assertAbsolute, assertDirectory, assertRegular, hasCode, readHashed, writeAtomicIfChanged } from "./asset-bundle-files.js";
import { attachmentPath, compareEntries, gltfResourcePath, gltfResourcesPolicy, object, parseGltfResourcesBundleManifest, resolveAssetBundleEntry, RESOURCE_URI_PREFIX, scenePath, selections, storeManifest, token } from "./asset-bundle-manifest.js";

type GltfJson = Record<string,any>;
type PreparedGltfFile = { bytes:Buffer };
export function isGltfResourcesProfile(value:unknown):boolean {
  return !!value && typeof value==="object" && !Array.isArray(value) && (value as Record<string,unknown>).profile===GLTF_RESOURCES_BUNDLE_PROFILE;
}
function attachmentNames(value:unknown,location:string):GltfResourcesAttachmentSelection[] {
  if(!Array.isArray(value) || value.length>MAX_ATTACHMENTS) throw new Error(`${location} attachments must be a list of at most ${MAX_ATTACHMENTS}`);
  const names=value.map((entry,index)=>({name:token(object(entry,["name"],`${location} attachment[${index}]`).name,"attachment name")}));
  if(new Set(names.map(n=>n.name)).size!==names.length) throw new Error(`${location} has duplicate attachment names`);
  return names;
}
export function gltfResourcesParameters(value:unknown):GltfResourcesBundleParameters {
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
export async function prepareGltfResources(root:string,p:GltfResourcesBundleParameters,value:unknown,signal?:AbortSignal) {
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
export async function verifyGltfResources(directory:string,manifest:GltfResourcesBundleManifest):Promise<number> {
  const cache=new Map<string,Buffer>(),attachments=new Set<string>(),declared=new Map<string,number>();
  for(const entry of manifest.assets) for(const file of [...entry.resources,...entry.attachments]) declared.set(file.path,file.byteLength);
  // Scene .gltf files count toward the distinct-payload budget too; measure them before reading any payload.
  let total=[...declared.values()].reduce((sum,n)=>sum+n,0);
  for(const entry of manifest.assets) {
    const file=path.join(directory,...entry.path.split("/"));await assertRegular(file);
    total+=(await lstat(file)).size;
    if(total>MAX_BUNDLE_BYTES) throw new Error("bundle exceeds the 256 MiB unique payload budget");
  }
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
export type PreparedGltfResources=Awaited<ReturnType<typeof prepareGltfResources>>;
/**
 * gltf-resources-v1 export. Content-addressed resources and attachments are published first, as in @1/@2. Scene
 * paths (`scenes/<key>/<variant>.gltf`) are not content-addressed, so they are written last, immediately before the
 * manifest commit; a failure or cancellation before that commit restores each scene file this call replaced (or
 * removes the ones it added), so the previously accepted manifest keeps verifying.
 */
export async function exportGltfResources(root:string,directory:string,prepared:PreparedGltfResources,options:BundleExportOptions) {
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
