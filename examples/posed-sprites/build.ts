// Pose-time derivatives of approved animated sources (#142): a directional Zebra walk-cycle
// sprite sheet and a cropped Mannequin portrait, both through the pinned Blender renderer.
import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdir,readFile} from "node:fs/promises";
import {canonicalJson} from "../../src/canonical.js";
import {createAssetCatalog} from "../../src/catalog.js";
import {importAssetCatalogStorageSource} from "../../src/catalog-storage.js";
import {resolveAssetObject,storeAssetObject} from "../../src/asset-store.js";
import {createAssetRef,type AssetRef,type CanonicalJsonObject} from "../../src/operations.js";
import {generateAsset,verifyAsset} from "../../src/core.js";
import {prepareDirectionalRenderDerivativeRecipes,prepareRenderDerivativeRecipe,readRenderDerivativeRecipeSource,RENDER_DERIVATIVE_PRESETS} from "../../src/render-derivative-recipes.js";
import {createImageDecodeOperationBuildIdentity,executeImageDecodeOperation,createImageEncodePngOperationBuildIdentity,executeImageEncodePngOperation} from "../../src/image-codec-operations.js";
import {createSpriteAtlasOperationBuildIdentity,executeSpriteAtlasOperation,type SpriteDeclaration} from "../../src/sprite-atlas-operations.js";
import {writeIfChanged} from "../reconcile-file.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),directory=path.join(root,".artifacts/posed-sprites");
const read=async(file:string)=>JSON.parse(await readFile(path.join(root,file),"utf8"));
const catalog=createAssetCatalog({providers:(await read("catalog/providers.json")).providers,sources:(await read("catalog/sources.json")).sources});
const storage=await read("catalog/storage.json");
const canonical=async(sourceId:string)=>(await importAssetCatalogStorageSource({catalog,sourceId,storageRoot:root,objectStoreRoot:root,storage})).asset;
const renderer=await readRenderDerivativeRecipeSource();
const pin={scriptSha256:renderer.sha256,blenderVersion:renderer.blenderVersion};
const evidence:Record<string,unknown>={};let renderStagesExecuted=0;

async function render(id:string,prepared:{spec:unknown;sourceBytes:Buffer},source:AssetRef,metadata:CanonicalJsonObject) {
 const workspace=path.join(directory,id);await mkdir(workspace,{recursive:true});
 await writeIfChanged(path.join(workspace,"render_static_glb.py"),renderer.bytes);await writeIfChanged(path.join(workspace,"source.glb"),prepared.sourceBytes);
 const specPath=path.join(workspace,"asset.json");await writeIfChanged(specPath,Buffer.from(canonicalJson(prepared.spec as CanonicalJsonObject)+"\n"));
 const generated=await generateAsset(specPath),verified=await verifyAsset(specPath);
 if(generated.cache.status!=="hit") {renderStagesExecuted++;}
 const observations=generated.receipt.observations.script as CanonicalJsonObject;
 const image=(await storeAssetObject(root,{bytes:await readFile(path.join(workspace,"render.png")),kind:"image",mediaType:"image/png",
  metadata:{source:{...source},...metadata,rendererScriptSha256:renderer.sha256,sourceSpecSha256:generated.receipt.spec.sha256,render:observations}})).asset;
 evidence[id]={receipt:generated.receipt,verified:verified.status};
 return {image,observations,verified:verified.status};
}

await mkdir(directory,{recursive:true});

// Zebra walk: four declared directions x eight evenly spaced clip times, one world frame. The source is
// the released expressive zebra (#589) from `bun scripts/build-zoo-animals.ts --out .artifacts/zoo-animals`.
// The Zoo animals face +X, so "east" (camera on +X) is head-on and "south" (camera on +Z) its left flank.
const zooStore=path.join(root,".artifacts/zoo-animals");
const lineage=JSON.parse(await readFile(path.join(zooStore,"lineage.json"),"utf8").catch(()=>{throw new Error("run bun scripts/build-zoo-animals.ts --out .artifacts/zoo-animals first");}));
const released=createAssetRef(lineage.animals["zoo.animal.zebra"].imported);
const zebra=(await storeAssetObject(root,{bytes:await resolveAssetObject(zooStore,released),kind:released.kind,mediaType:released.mediaType,metadata:released.metadata})).asset;
assert.deepEqual(zebra,released);
const directions=[{id:"east",viewDirection:[1,.35,0]},{id:"north",viewDirection:[0,.35,-1]},{id:"south",viewDirection:[0,.35,1]},{id:"west",viewDirection:[-1,.35,0]}];
const walkParameters={...RENDER_DERIVATIVE_PRESETS.icon,width:128,height:128,samples:16,padding:.04,
 framing:{type:"shared-orthographic",center:[0,.95,0],horizontalSpan:2.5,pivot:[0,0,0]}};
const walk=await prepareDirectionalRenderDerivativeRecipes(root,{assetId:"zoo.zebra.expressive.walk.sprite",source:zebra,parameters:walkParameters,directions,sequence:{clip:"walk",frames:8},...pin});
assert.deepEqual(await prepareDirectionalRenderDerivativeRecipes(root,{assetId:"zoo.zebra.expressive.walk.sprite",source:zebra,parameters:walkParameters,directions:directions.toReversed(),sequence:{clip:"walk",frames:8},...pin}),walk);
const sprites:SpriteDeclaration[]=[],decoded:AssetRef[]=[],frames:{id:string;directionId:string;sampleId:string;timeSeconds:number;image:AssetRef}[]=[];
for(const entry of walk) {
 const id=`zebra-walk.${entry.directionId}.${entry.sampleId}`;
 const {image,observations}=await render(id,entry,zebra,{directionId:entry.directionId,sampleId:entry.sampleId,pose:{...entry.pose}});
 const pivot=observations.pivot as {x:number;y:number};
 frames.push({id,directionId:entry.directionId,sampleId:entry.sampleId,timeSeconds:entry.pose.timeSeconds,image});
 sprites.push({id,pivot:{x:pivot.x,y:pivot.y}});
 const frame=createAssetRef((await executeImageDecodeOperation(root,{inputs:{source:image}})).outputs.output);
 decoded.push(createAssetRef({...frame,metadata:{...frame.metadata,originalSource:{...image}}}));
}
// The existing atlas packer keeps each frame's shared pivot through trimming.
const atlasInvocation={parameters:{width:1024,maxHeight:1024,padding:2,extrusion:1,trim:true,sprites},inputs:{sprites:decoded}};
const atlasBuild=await createSpriteAtlasOperationBuildIdentity(root,atlasInvocation),atlas=await executeSpriteAtlasOperation(root,atlasInvocation);
const encode={inputs:{source:createAssetRef(atlas.outputs.image)},parameters:{compressionLevel:9}};
const pngBuild=await createImageEncodePngOperationBuildIdentity(root,encode),atlasPng=createAssetRef((await executeImageEncodePngOperation(root,encode)).outputs.output);
await writeIfChanged(path.join(directory,"zebra-walk.atlas.json"),await resolveAssetObject(root,createAssetRef(atlas.outputs.manifest)));
await writeIfChanged(path.join(directory,"zebra-walk.atlas.png"),await resolveAssetObject(root,atlasPng));

// Mannequin portrait: front bust at a declared Idle_Loop time, deliberately cropped below the chest.
const mannequin=await canonical("quaternius.universal-animation-library-standard.animationlibrary-godot-standard-glb");
const portraitParameters={...RENDER_DERIVATIVE_PRESETS.portrait,samples:32,selection:{type:"nodes",names:["Mannequin"]},pose:{clip:"Idle_Loop",timeSeconds:1},
 framing:{type:"shared-orthographic",center:[0,1.5,0],horizontalSpan:.7,pivot:[0,1.25,0],overflow:"crop"}};
const portraitPrepared=await prepareRenderDerivativeRecipe(root,{assetId:"humanoid.mannequin.portrait",source:mannequin,parameters:portraitParameters,...pin});
const portrait=await render("mannequin-portrait",portraitPrepared,mannequin,{pose:{...portraitParameters.pose},clip:{...portraitPrepared.clip!}});
assert.equal((portrait.observations.framing as CanonicalJsonObject).cropped,true);

const outputs={schemaVersion:1,walk:{clip:"walk",frames,atlas:{manifest:createAssetRef(atlas.outputs.manifest),png:atlasPng}},portrait:{image:portrait.image}};
await writeIfChanged(path.join(directory,"outputs.json"),Buffer.from(canonicalJson(outputs as unknown as CanonicalJsonObject)+"\n"));
await writeIfChanged(path.join(directory,"evidence.json"),Buffer.from(canonicalJson({schemaVersion:1,walkParameters,directions,portraitParameters,evidence,
 atlas:{build:atlasBuild,result:atlas,png:atlasPng,pngBuild},decodeBuild:await createImageDecodeOperationBuildIdentity(root,{inputs:{source:frames[0]!.image}})} as unknown as CanonicalJsonObject)+"\n"));
console.log(JSON.stringify({walkFrames:frames.length,portraits:1,renderStagesExecuted,
 verified:Object.values(evidence).map(e=>(e as {verified:string}).verified).reduce((counts,status)=>({...counts,[status]:(counts[status]??0)+1}),{} as Record<string,number>)}));
