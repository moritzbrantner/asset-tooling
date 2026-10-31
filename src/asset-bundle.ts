import { canonicalJson } from "./canonical.js";
import { RGBA8_IMAGE_MEDIA_TYPE } from "./image-rgba8.js";
import { parseSpriteAtlasManifest } from "./sprite-atlas-operations.js";
import { createAssetRef, normalizeAssetOperationResult, type AssetOperationBuildIdentity } from "./operations.js";
import { APPROVED_IMAGE_BUNDLE_OPERATION, APPROVED_IMAGE_BUNDLE_PROFILE, ASSET_BUNDLE_MEDIA_TYPE, ASSET_BUNDLE_OPERATION, AUDIO_BUNDLE_OPERATION, AUDIO_BUNDLE_PROFILE, GLTF_RESOURCES_BUNDLE_OPERATION, GLTF_RESOURCES_BUNDLE_PROFILE,
  MAX_MANIFEST_BYTES, SPRITE_ATLAS_BUNDLE_OPERATION, SPRITE_ATLAS_BUNDLE_PROFILE, STATIC_ASSET_BUNDLE_PROFILE, type AnyAssetBundleManifest, type ApprovedImageBundleManifest, type AssetBundleManifest,
  type AudioBundleManifest, type BundleProfile, type BundleResource, type GltfResourcesBundleManifest, type Invocation, type SpriteAtlasBundleManifest } from "./asset-bundle-contract.js";
import { assertAbsolute, readHashed, readPinned } from "./asset-bundle-files.js";
import { verifyGltfResources } from "./asset-bundle-gltf.js";
import { assetPath, bundleResources, object, parseAnyAssetBundleManifest, parseSpriteAtlasBundleManifest, resolveAssetBundleEntry, storeManifest, token, unreachable } from "./asset-bundle-manifest.js";
import { checkAtlas, uniqueResources, validatePayload, type ReadResource } from "./asset-bundle-payload.js";
import { prepare } from "./asset-bundle-prepare.js";

export { APPROVED_IMAGE_BUNDLE_OPERATION, APPROVED_IMAGE_BUNDLE_PROFILE, ASSET_BUNDLE_MEDIA_TYPE, ASSET_BUNDLE_OPERATION, AUDIO_BUNDLE_OPERATION, AUDIO_BUNDLE_PROFILE,
  GLTF_RESOURCES_BUNDLE_ALLOWED_VALIDATOR_WARNINGS, GLTF_RESOURCES_BUNDLE_OPERATION, GLTF_RESOURCES_BUNDLE_PROFILE, SPRITE_ATLAS_BUNDLE_OPERATION, SPRITE_ATLAS_BUNDLE_PROFILE, STATIC_ASSET_BUNDLE_PROFILE } from "./asset-bundle-contract.js";
export type { AnyAssetBundleManifest, ApprovedBundleAssetSelection, ApprovedImageBundleEntry, ApprovedImageBundleManifest, ApprovedImageBundleParameters, AssetBundleEntry, AssetBundleManifest, AssetBundleParameters,
  AudioBundleManifest, AudioBundleParameters, BundleApproval, BundleAssetSelection, BundleExportOptions, BundleExportProgress, BundleResource, GltfBundleAttachment, GltfBundleObservations, GltfBundleResource,
  GltfResourcesAttachmentSelection, GltfResourcesBundleAssetSelection, GltfResourcesBundleEntry, GltfResourcesBundleManifest, GltfResourcesBundleParameters, SpriteAtlasBundleEntry, SpriteAtlasBundleManifest } from "./asset-bundle-contract.js";
export { exportAssetBundle } from "./asset-bundle-export.js";
export { readAssetBundleAttachment, readAssetBundleGltf } from "./asset-bundle-gltf.js";
export { listAssetBundleFiles, parseApprovedImageBundleManifest, parseAssetBundleManifest, parseAudioBundleManifest, parseGltfResourcesBundleManifest, parseSpriteAtlasBundleManifest, resolveAssetBundleEntry } from "./asset-bundle-manifest.js";

export async function createAssetBundleBuildIdentity(root:string,invocation:Invocation={}):Promise<AssetOperationBuildIdentity> { return (await prepare(root,invocation)).build; }
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
    case 5: return AUDIO_BUNDLE_OPERATION;
    default: return unreachable(manifest);
  }
}
type BundleVerification<M extends AnyAssetBundleManifest>={manifest:M;assetsVerified:number;uniquePayloads:number};
export function verifyAssetBundle(directory:string,manifestValue:unknown,options?:{profile:typeof STATIC_ASSET_BUNDLE_PROFILE}):Promise<BundleVerification<AssetBundleManifest>>;
export function verifyAssetBundle(directory:string,manifestValue:unknown,options:{profile:typeof SPRITE_ATLAS_BUNDLE_PROFILE}):Promise<BundleVerification<SpriteAtlasBundleManifest>>;
export function verifyAssetBundle(directory:string,manifestValue:unknown,options:{profile:typeof APPROVED_IMAGE_BUNDLE_PROFILE}):Promise<BundleVerification<ApprovedImageBundleManifest>>;
export function verifyAssetBundle(directory:string,manifestValue:unknown,options:{profile:typeof GLTF_RESOURCES_BUNDLE_PROFILE}):Promise<BundleVerification<GltfResourcesBundleManifest>>;
export function verifyAssetBundle(directory:string,manifestValue:unknown,options:{profile:typeof AUDIO_BUNDLE_PROFILE}):Promise<BundleVerification<AudioBundleManifest>>;
export async function verifyAssetBundle(directory:string,manifestValue:unknown,options:{profile:BundleProfile}={profile:STATIC_ASSET_BUNDLE_PROFILE}):Promise<BundleVerification<AnyAssetBundleManifest>> {
  const selected=object(options,["profile"],"bundle verification profile");
  assertAbsolute(directory);const ref=createAssetRef(manifestValue);
  if(ref.kind!=="asset-bundle" || ref.mediaType!==ASSET_BUNDLE_MEDIA_TYPE || ref.byteLength>MAX_MANIFEST_BYTES) throw new Error("expected a pinned asset-bundle manifest within 8 MiB");
  const manifest=parseAnyAssetBundleManifest(await readPinned(directory,"manifest.json",ref)),verified=new Set<string>();
  if(manifest.profile!==selected.profile) throw new Error("bundle manifest does not match the explicitly selected verification profile");
  const resources=bundleResources(manifest);
  for(const entry of resources) if(!verified.has(entry.path)) {await validatePayload(entry.source,await readPinned(directory,entry.path,entry.source));verified.add(entry.path);}
  switch(manifest.schemaVersion) {
   case 1: case 3: case 5: break;
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
