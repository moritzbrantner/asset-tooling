import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../src/canonical.js";
import { resolveAssetObject } from "../../src/asset-store.js";
import { createAssetRef, type AssetRef, type AssetOperationBuildIdentity, type CanonicalJsonObject } from "../../src/operations.js";
import { EFFECT_ARTWORK_PRESETS, createEffectArtworkBuildIdentity, executeEffectArtwork } from "../../src/effect-artwork-recipes.js";
import { createSpriteAtlasOperationBuildIdentity, executeSpriteAtlasOperation } from "../../src/sprite-atlas-operations.js";
import { createImageEncodePngOperationBuildIdentity, executeImageEncodePngOperation } from "../../src/image-codec-operations.js";
import { writeIfChanged } from "../reconcile-file.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const directory=path.join(root,".artifacts/effect-artwork");
await mkdir(directory,{recursive:true});
const steps:{build:AssetOperationBuildIdentity;outputs:Record<string,AssetRef>;observations:CanonicalJsonObject}[]=[];
const sprites:{id:string;source:AssetRef}[]=[],pngs:Record<string,AssetRef>={};
async function png(id:string,source:AssetRef) {
  const invocation={inputs:{source},parameters:{compressionLevel:9}};
  const build=await createImageEncodePngOperationBuildIdentity(root,invocation);
  const result=await executeImageEncodePngOperation(root,invocation),output=createAssetRef(result.outputs.output);
  // Replay the configured encoder; compare actual bytes, independently of output reuse.
  const replay=await executeImageEncodePngOperation(root,invocation);
  if(createAssetRef(replay.outputs.output).sha256!==output.sha256) throw new Error(`${id} PNG replay differs`);
  steps.push({build,outputs:{output},observations:result.observations});pngs[id]=output;
  await writeIfChanged(path.join(directory,`${id}.png`),await resolveAssetObject(root,output));
}
for(const shape of ["puff","ring"] as const) for(const intensity of ["subtle","strong","off"] as const) {
  const id=`${shape}.${intensity}`,parameters=EFFECT_ARTWORK_PRESETS[shape][intensity];
  const build=await createEffectArtworkBuildIdentity(root,{parameters}),result=await executeEffectArtwork(root,{parameters});
  const image=createAssetRef(result.outputs.image),mask=createAssetRef(result.outputs.mask);
  const replay=await executeEffectArtwork(root,{parameters});
  if(createAssetRef(replay.outputs.image).sha256!==image.sha256 || createAssetRef(replay.outputs.mask).sha256!==mask.sha256) throw new Error(`${id} artwork replay differs`);
  steps.push({build,outputs:{image,mask},observations:result.observations});sprites.push({id,source:image});
  await png(id,image);
}
const atlasInvocation={parameters:{width:256,maxHeight:256,padding:2,extrusion:1,trim:true,sprites:sprites.map(s=>({id:s.id,pivot:{x:32,y:32}}))},inputs:{sprites:sprites.map(s=>s.source)}};
const atlasBuild=await createSpriteAtlasOperationBuildIdentity(root,atlasInvocation),atlas=await executeSpriteAtlasOperation(root,atlasInvocation);
const atlasImage=createAssetRef(atlas.outputs.image),atlasManifest=createAssetRef(atlas.outputs.manifest);
const replay=await executeSpriteAtlasOperation(root,atlasInvocation);
if(createAssetRef(replay.outputs.image).sha256!==atlasImage.sha256 || createAssetRef(replay.outputs.manifest).sha256!==atlasManifest.sha256) throw new Error("atlas replay differs");
steps.push({build:atlasBuild,outputs:{image:atlasImage,manifest:atlasManifest},observations:atlas.observations});
await png("atlas",atlasImage);
await writeIfChanged(path.join(directory,"atlas.json"),await resolveAssetObject(root,atlasManifest));
await writeIfChanged(path.join(directory,"evidence.json"),Buffer.from(`${canonicalJson({sprites,pngs,steps,static:true,producerFrameSequence:false})}\n`));
console.log(JSON.stringify({directory,sprites:sprites.map(s=>s.id),rawPixelsPerIngredient:64*64,fileCount:9,static:true}));
