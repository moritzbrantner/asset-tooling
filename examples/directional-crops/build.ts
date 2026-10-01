import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdir,mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {createAssetRef,parseAssetRef,type AssetRef,type CanonicalJsonObject} from "asset-tooling/operations";
import {resolveAssetObject,storeAssetObject} from "asset-tooling/operations/store";
import {prepareDirectionalRenderDerivativeRecipes,readRenderDerivativeRecipeSource,RENDER_DERIVATIVE_PRESETS} from "asset-tooling/recipes/render-derivatives";
import {createImageDecodeOperationBuildIdentity,executeImageDecodeOperation,createImageEncodePngOperationBuildIdentity,executeImageEncodePngOperation} from "asset-tooling/operations/image/codecs";
import {createSpriteAtlasOperationBuildIdentity,executeSpriteAtlasOperation,type SpriteDeclaration} from "asset-tooling/operations/image/atlas";
import {exportAssetBundle,verifyAssetBundle,readAssetBundleAsset,readAssetBundleSpriteAtlas,STATIC_ASSET_BUNDLE_PROFILE,SPRITE_ATLAS_BUNDLE_PROFILE} from "asset-tooling/operations/bundle";
import {canonicalJson} from "../../src/canonical.js";
import {writeIfChanged} from "../reconcile-file.js";
const generationModule:string="asset-tooling";
const {generateAsset,verifyAsset}:{generateAsset:(p:string)=>Promise<{cache:{status:string};receipt:{spec:{sha256:string};observations:{script:CanonicalJsonObject}}}>;
 verifyAsset:(p:string)=>Promise<{status:string}>}=await import(generationModule);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),directory=path.join(root,".artifacts/directional-crops");
const inventory:unknown=JSON.parse(await readFile(path.join(root,".artifacts/corn/assets.json"),"utf8"));
assert.ok(inventory && typeof inventory==="object" && "meshes" in inventory);
const meshes=inventory.meshes;assert.ok(meshes && typeof meshes==="object" && !Array.isArray(meshes));
const renderer=await readRenderDerivativeRecipeSource();
const directions=[{id:"front",viewDirection:[0,.15,1]},{id:"right",viewDirection:[1,.15,0]},
 {id:"back",viewDirection:[0,.15,-1]},{id:"left",viewDirection:[-1,.15,0]}];
const parameters={...RENDER_DERIVATIVE_PRESETS.icon,width:256,height:384,samples:16,padding:.06,
 framing:{type:"shared-orthographic",center:[0,.9,0],horizontalSpan:1.5,pivot:[0,0,0]}};
const outputs:{id:string;state:string;directionId:string;image:AssetRef}[]=[],sprites:SpriteDeclaration[]=[],decoded:AssetRef[]=[];
const evidence:Record<string,unknown>={};let renderStagesExecuted=0;
const cold=await mkdtemp(path.join(tmpdir(),"directional-crops-"));
async function copy(ref:AssetRef) {
 const copied=await storeAssetObject(cold,{bytes:await resolveAssetObject(root,ref),kind:ref.kind,mediaType:ref.mediaType,metadata:ref.metadata});assert.deepEqual(copied.asset,ref);
}
try {
 await mkdir(directory,{recursive:true});
 for(const state of ["early","mature-straw","harvested"]) {
  const value:unknown=Reflect.get(meshes,state),source=parseAssetRef(value);
  const options={assetId:`corn.${state}.sprite`,source,parameters,directions,scriptSha256:renderer.sha256,blenderVersion:renderer.blenderVersion};
  const prepared=await prepareDirectionalRenderDerivativeRecipes(root,options);
  assert.deepEqual(await prepareDirectionalRenderDerivativeRecipes(root,{...options,directions:directions.toReversed()}),prepared);
  for(const render of prepared) {
   const id=`${state}.${render.directionId}`,workspace=path.join(directory,id);await mkdir(workspace,{recursive:true});
   await writeIfChanged(path.join(workspace,"render_static_glb.py"),renderer.bytes);await writeIfChanged(path.join(workspace,"source.glb"),render.sourceBytes);
   const specPath=path.join(workspace,"asset.json");await writeIfChanged(specPath,Buffer.from(canonicalJson(render.spec)+"\n"));
   const generated=await generateAsset(specPath);assert.equal((await verifyAsset(specPath)).status,"exact");
   if(generated.cache.status!=="hit") {renderStagesExecuted++;}
   const observations=generated.receipt.observations.script,pivot=observations.pivot;
   assert.ok(pivot && typeof pivot==="object" && !Array.isArray(pivot) && typeof pivot.x==="number" && typeof pivot.y==="number");
   const image=(await storeAssetObject(root,{bytes:await readFile(path.join(workspace,"render.png")),kind:"image",mediaType:"image/png",
    metadata:{source:{...source},state,directionId:render.directionId,rendererScriptSha256:renderer.sha256,sourceSpecSha256:generated.receipt.spec.sha256,render:observations}})).asset;
   outputs.push({id,state,directionId:render.directionId,image});sprites.push({id,pivot:{x:pivot.x,y:pivot.y}});await copy(image);
   const invocation={inputs:{source:image}},build=await createImageDecodeOperationBuildIdentity(root,invocation),result=await executeImageDecodeOperation(root,invocation);
   assert.deepEqual(await executeImageDecodeOperation(cold,invocation),result);
   const frame=createAssetRef(result.outputs.output);
   // The existing decoder records its source byte pin. Retain the complete
   // rendered source/configuration lineage on the same canonical frame bytes.
   decoded.push(createAssetRef({...frame,metadata:{...frame.metadata,originalSource:{...image},decodeBuild:{...build}}}));
   evidence[id]={sourceSummary:render.sourceSummary,resources:render.resources,receipt:generated.receipt,decode:{build,result}};
  }
 }
 const atlasInvocation={parameters:{width:1024,maxHeight:2048,padding:2,extrusion:1,trim:true,sprites},inputs:{sprites:decoded}};
 const atlasBuild=await createSpriteAtlasOperationBuildIdentity(root,atlasInvocation),atlas=await executeSpriteAtlasOperation(root,atlasInvocation);
 assert.deepEqual(await executeSpriteAtlasOperation(cold,atlasInvocation),atlas);
 const manifest=createAssetRef(atlas.outputs.manifest),encoding={inputs:{source:createAssetRef(atlas.outputs.image)},parameters:{compressionLevel:9}};
 const pngBuild=await createImageEncodePngOperationBuildIdentity(root,encoding),png=createAssetRef((await executeImageEncodePngOperation(root,encoding)).outputs.output);
 assert.deepEqual(createAssetRef((await executeImageEncodePngOperation(cold,encoding)).outputs.output),png);
 const individualInvocation={parameters:{profile:STATIC_ASSET_BUNDLE_PROFILE,assets:outputs.map(o=>({key:"corn.sprite",variant:o.id}))},inputs:{assets:outputs.map(o=>o.image)}};
 const atlasPackageInvocation={parameters:{profile:SPRITE_ATLAS_BUNDLE_PROFILE,assets:[{key:"corn.directions",variant:"stages"}]},inputs:{assets:[manifest],images:[png]}};
 const individual=await exportAssetBundle(root,path.join(directory,"individual-package"),individualInvocation);
 const atlasPackage=await exportAssetBundle(root,path.join(directory,"atlas-package"),atlasPackageInvocation);
 const coldIndividual=await exportAssetBundle(cold,path.join(cold,"individual-package"),individualInvocation);
 const coldAtlas=await exportAssetBundle(cold,path.join(cold,"atlas-package"),atlasPackageInvocation);
 assert.deepEqual(coldIndividual.manifest,individual.manifest);assert.deepEqual(coldAtlas.manifest,atlasPackage.manifest);
 await rm(path.join(cold,".asset-tooling"),{recursive:true,force:true});
 const checked=await verifyAssetBundle(path.join(cold,"individual-package"),coldIndividual.manifest);
 for(const output of outputs) {assert.deepEqual(await readAssetBundleAsset(path.join(cold,"individual-package"),checked.manifest,"corn.sprite",output.id),await resolveAssetObject(root,output.image));}
 const checkedAtlas=await verifyAssetBundle(path.join(cold,"atlas-package"),coldAtlas.manifest,{profile:SPRITE_ATLAS_BUNDLE_PROFILE});
 assert.equal(checkedAtlas.manifest.schemaVersion,2);if(checkedAtlas.manifest.schemaVersion!==2) {throw new Error("expected atlas bundle profile");}
 const loaded=await readAssetBundleSpriteAtlas(path.join(cold,"atlas-package"),checkedAtlas.manifest,"corn.directions","stages");
 assert.deepEqual(loaded.png,await resolveAssetObject(root,png));assert.equal(loaded.atlas.sprites.length,12);
 await writeIfChanged(path.join(directory,"atlas.json"),await resolveAssetObject(root,manifest));await writeIfChanged(path.join(directory,"atlas.png"),await resolveAssetObject(root,png));
 await writeIfChanged(path.join(directory,"outputs.json"),Buffer.from(canonicalJson({schemaVersion:1,outputs})+"\n"));
 await writeIfChanged(path.join(directory,"individual-package.ref.json"),Buffer.from(canonicalJson(individual.manifest)+"\n"));
 await writeIfChanged(path.join(directory,"atlas-package.ref.json"),Buffer.from(canonicalJson(atlasPackage.manifest)+"\n"));
 await writeIfChanged(path.join(directory,"evidence.json"),Buffer.from(canonicalJson({schemaVersion:1,parameters,directions,evidence,atlas:{build:atlasBuild,result:atlas,png,pngBuild},
  distributionFiles:{individual:individual.files,atlas:atlasPackage.files},packageOnlyMatches:true,coldAtlasMatches:true,sourceGenerationStages:0})+"\n"));
 console.log(JSON.stringify({sprites:outputs.length,renderStagesExecuted,replayStagesExecuted:outputs.length,decodeStagesExecuted:outputs.length,sourceGenerationStages:0,
  individualPackageFiles:individual.files.length,atlasPackageFiles:atlasPackage.files.length,packageBytesWritten:individual.bytesWritten+atlasPackage.bytesWritten,packageOnlyMatches:true,coldAtlasMatches:true}));
} finally {await rm(cold,{recursive:true,force:true});}
