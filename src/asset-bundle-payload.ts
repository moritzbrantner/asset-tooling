/** Content checks shared by preparation and verification: per-media-type payload validation and the atlas closure. */
import { ImageUtils, NodeIO } from "@gltf-transform/core";
import { canonicalJson } from "./canonical.js";
import { sha256Bytes } from "./hash.js";
import { checkStaticGltfAccessorBudget, parseCheckedGltfBytes } from "./gltf-processing.js";
import { parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "./image-rgba8.js";
import { assertCanonicalAudioBytes, CANONICAL_AUDIO_MEDIA_TYPE } from "./audio.js";
import { parseSpriteAtlasManifest, SPRITE_ATLAS_MEDIA_TYPE, type SpriteAtlasManifest } from "./sprite-atlas-operations.js";
import type { AssetRef } from "./operations.js";
import { SPRITE_ATLAS_BUNDLE_PROFILE, type BundleResource, type SpriteAtlasBundleEntry } from "./asset-bundle-contract.js";
import { assetPath, compareResources } from "./asset-bundle-manifest.js";

export async function validatePayload(source:AssetRef,bytes:Buffer):Promise<void> {
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
  else if(source.mediaType===CANONICAL_AUDIO_MEDIA_TYPE) assertCanonicalAudioBytes(bytes,source.metadata);
  else if(source.mediaType==="application/json") JSON.parse(bytes.toString("utf8"));
  else throw new Error("unsupported bundle payload media type");
}
export function boundedRgba(bytes:Buffer,expected?:{width:number;height:number}) {
  // Check declared dimensions before the existing parser allocates decoded pixels.
  const value:unknown=JSON.parse(bytes.toString("utf8"));
  if(!value || typeof value!=="object" || !("width" in value) || !("height" in value) ||
     typeof value.width!=="number" || typeof value.height!=="number" || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) ||
     value.width<1 || value.height<1 || value.width>4096 || value.height>4096 || value.width*value.height>4*1024*1024) throw new Error("atlas resource exceeds its 4096-axis/4-megapixel decode budget");
  return parseRgba8Image(bytes,expected);
}
export type ReadResource=(source:AssetRef)=>Promise<Buffer>;
export async function checkAtlas(entry:SpriteAtlasBundleEntry,read:ReadResource):Promise<{atlas:SpriteAtlasManifest;resources:BundleResource[]}> {
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
export function uniqueResources(resources:BundleResource[]):BundleResource[] {
  return [...new Map(resources.map(r=>[canonicalJson(r),r])).values()].sort(compareResources);
}
