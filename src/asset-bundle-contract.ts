/** Public asset.bundle vocabulary: profile names, budgets, manifest types and the versioned operation descriptors. */
import { GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS } from "./gltf-production-operations.js";
import { CANONICAL_AUDIO_MEDIA_TYPE } from "./audio.js";
import { SPRITE_ATLAS_MEDIA_TYPE } from "./sprite-atlas-operations.js";
import { createAssetOperationDescriptor, createAssetOperationRegistry, type AssetRef } from "./operations.js";

export const ASSET_BUNDLE_MEDIA_TYPE = "application/vnd.moritzbrantner.asset-bundle+json";
export const STATIC_ASSET_BUNDLE_PROFILE = "static-glb-png-v1";
export const SPRITE_ATLAS_BUNDLE_PROFILE = "sprite-atlas-png-v1";
/** PNG candidates approved by naming their exact sha256 in the export selection (Atlas Decision 4.1.3). */
export const APPROVED_IMAGE_BUNDLE_PROFILE = "approved-png-v1";
/** Skinned/animated GLBs exported as glTF JSON whose buffers and images are hash-addressed external files (#118 Q4, #110). */
export const GLTF_RESOURCES_BUNDLE_PROFILE = "gltf-resources-v1";
/** Canonical PCM-16 WAV clips plus JSON descriptors, each stored once by hash (#297). */
export const AUDIO_BUNDLE_PROFILE = "audio-wav-v1";
/** The scene.import.gltf@2 warning allowance, applied profile-wide and recorded in build identity and manifest. */
export const GLTF_RESOURCES_BUNDLE_ALLOWED_VALIDATOR_WARNINGS: readonly string[] = Object.freeze([...GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS]);
export const MAX_ASSETS = 256, MAX_ASSET_BYTES = 64*1024*1024, MAX_BUNDLE_BYTES = 256*1024*1024, MAX_MANIFEST_BYTES = 8*1024*1024;
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
export type AudioBundleParameters = { profile:typeof AUDIO_BUNDLE_PROFILE; assets:BundleAssetSelection[] };
export type AudioBundleManifest = { schemaVersion:5; profile:typeof AUDIO_BUNDLE_PROFILE; assets:AssetBundleEntry[] };
export type AnyAssetBundleManifest = AssetBundleManifest|SpriteAtlasBundleManifest|ApprovedImageBundleManifest|GltfResourcesBundleManifest|AudioBundleManifest;
export type BundleProfile = AssetBundleParameters["profile"]|typeof APPROVED_IMAGE_BUNDLE_PROFILE|typeof GLTF_RESOURCES_BUNDLE_PROFILE|typeof AUDIO_BUNDLE_PROFILE;
export type Invocation = { parameters?:unknown; inputs?:unknown };
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
/** asset.bundle@5: canonical PCM-16 WAV clips and JSON descriptors stored by hash (#297). */
export const AUDIO_BUNDLE_OPERATION = createAssetOperationDescriptor({
  schemaVersion:1,id:"asset.bundle",version:"5",label:"Package canonical WAV clips and JSON descriptors",category:"asset.packaging",
  inputs:[{id:"assets",assetKinds:[],mediaTypes:[CANONICAL_AUDIO_MEDIA_TYPE,"application/json"],cardinality:{min:1,max:MAX_ASSETS}}],
  outputs:[{id:"manifest",assetKinds:["asset-bundle"],mediaTypes:[ASSET_BUNDLE_MEDIA_TYPE]}],
  parameterSchema:parameterSchema(AUDIO_BUNDLE_PROFILE),
});
export const MAX_ATTACHMENTS = 16, MAX_SCENE_RESOURCES = 1024;
const GLTF_ATTACHMENT_MEDIA_TYPES: readonly string[] = ["application/json","model/gltf-binary"];
export const GLTF_RESOURCE_EXTENSIONS: Readonly<Record<string,string>> = {"application/octet-stream":"bin","image/png":"png","image/jpeg":"jpg","image/webp":"webp","image/ktx2":"ktx2"};
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
