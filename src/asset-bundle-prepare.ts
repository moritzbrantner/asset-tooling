/** Dispatch an invocation by profile and resolve, check and describe its dependencies before any export file is touched. */
/// <reference path="./gltf-validator.d.ts" />
import { readDependencyLockSha256 } from "./dependency-lock.js";
import { VERSION } from "@gltf-transform/core";
import { version as validatorVersion } from "gltf-validator";
import { canonicalJson } from "./canonical.js";
import { resolveAssetObject } from "./asset-store.js";
import { sha256Bytes } from "./hash.js";
import { captureToolIdentity } from "./tool.js";
import { RGBA8_IMAGE_MEDIA_TYPE } from "./image-rgba8.js";
import { createAssetOperationBuildIdentity, createAssetRef, type AssetRef } from "./operations.js";
import { APPROVED_IMAGE_BUNDLE_OPERATION, APPROVED_IMAGE_BUNDLE_PROFILE, ASSET_BUNDLE_OPERATION, AUDIO_BUNDLE_OPERATION, AUDIO_BUNDLE_PROFILE, SPRITE_ATLAS_BUNDLE_OPERATION, SPRITE_ATLAS_BUNDLE_PROFILE, STATIC_ASSET_BUNDLE_PROFILE,
  type ApprovedImageBundleEntry, type ApprovedImageBundleManifest, type ApprovedImageBundleParameters, type AssetBundleManifest, type AssetBundleParameters, type AudioBundleManifest,
  type BundleAssetSelection, type BundleResource, type Invocation, type SpriteAtlasBundleEntry, type SpriteAtlasBundleManifest } from "./asset-bundle-contract.js";
import { assertAbsolute } from "./asset-bundle-files.js";
import { gltfResourcesParameters, isGltfResourcesProfile, prepareGltfResources } from "./asset-bundle-gltf.js";
import { approvedSelections, assetPath, checkBudget, compareEntries, object, parseApprovedImageBundleManifest, parseAssetBundleManifest, parseAudioBundleManifest, parseSpriteAtlasBundleManifest, selections, unreachable } from "./asset-bundle-manifest.js";
import { checkAtlas, uniqueResources, validatePayload, type ReadResource } from "./asset-bundle-payload.js";

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
export async function prepare(root:string,invocation:Invocation,signal?:AbortSignal) {
  signal?.throwIfAborted();assertAbsolute(root);
  if(isApprovedProfile(invocation.parameters)) return prepareApproved(root,approvedParameters(invocation.parameters),invocation.inputs,signal);
  if(isGltfResourcesProfile(invocation.parameters)) return prepareGltfResources(root,gltfResourcesParameters(invocation.parameters),invocation.inputs,signal);
  if(isAudioProfile(invocation.parameters)) {
    const p=object(invocation.parameters,["profile","assets"],"audio bundle parameters");
    return prepareFlat(root,AUDIO_BUNDLE_PROFILE,selections(p.assets),invocation.inputs,signal);
  }
  const p=parameters(invocation.parameters);
  switch(p.profile) {
    case SPRITE_ATLAS_BUNDLE_PROFILE: return prepareAtlas(root,p,invocation.inputs,signal);
    case STATIC_ASSET_BUNDLE_PROFILE: return prepareFlat(root,p.profile,p.assets,invocation.inputs,signal);
    default: return unreachable(p.profile);
  }
}
function isAudioProfile(value:unknown):boolean {
  return !!value && typeof value==="object" && !Array.isArray(value) && (value as Record<string,unknown>).profile===AUDIO_BUNDLE_PROFILE;
}
/** static-glb-png-v1 (asset.bundle@1) and audio-wav-v1 (asset.bundle@5): one hash-addressed file per selection. */
async function prepareFlat(root:string,profile:typeof STATIC_ASSET_BUNDLE_PROFILE|typeof AUDIO_BUNDLE_PROFILE,chosen:BundleAssetSelection[],value:unknown,signal?:AbortSignal) {
  const inputs=object(value,["assets"],"bundle inputs");
  if(!Array.isArray(inputs.assets) || inputs.assets.length!==chosen.length) throw new Error("one source AssetRef is required for each bundle selection");
  const refs=inputs.assets.map(createAssetRef),entries=chosen.map((entry,index)=>({ ...entry,source:refs[index]!,path:assetPath(refs[index]!,profile) })).sort(compareEntries);
  checkBudget(entries);const blobs=new Map<string,{source:AssetRef;bytes:Buffer}>();
  // Validate every declared dependency before inspecting/reusing any export file.
  for(const entry of entries) if(!blobs.has(entry.path)) {
    signal?.throwIfAborted();const bytes=await resolveAssetObject(root,entry.source);await validatePayload(entry.source,bytes);signal?.throwIfAborted();blobs.set(entry.path,{source:entry.source,bytes});
  }
  const audio=profile===AUDIO_BUNDLE_PROFILE;
  const build=createAssetOperationBuildIdentity({operation:audio?AUDIO_BUNDLE_OPERATION:ASSET_BUNDLE_OPERATION,parameters:{profile,assets:entries.map(({key,variant})=>({key,variant}))},
    inputs:{assets:entries.map(entry=>entry.source)},implementation:audio
      ?{id:"builtin.asset.bundle",version:"5",profile,dependencyLockSha256:await readDependencyLockSha256(),tool:await captureToolIdentity()}
      :{id:"builtin.asset.bundle",version:"1",profile,gltfTransform:VERSION,validator:validatorVersion(),dependencyLockSha256:await readDependencyLockSha256(),tool:await captureToolIdentity()}});
  const manifest:AssetBundleManifest|AudioBundleManifest=audio?{schemaVersion:5,profile:AUDIO_BUNDLE_PROFILE,assets:entries}:{schemaVersion:1,profile:STATIC_ASSET_BUNDLE_PROFILE,assets:entries};
  const bytes=Buffer.from(`${canonicalJson(manifest)}\n`);if(audio) parseAudioBundleManifest(bytes); else parseAssetBundleManifest(bytes);
  return {build,manifest,bytes,blobs};
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
export type PreparedApproved=Awaited<ReturnType<typeof prepareApproved>>;
