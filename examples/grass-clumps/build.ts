import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdir,readFile} from "node:fs/promises";
import {createGrassAssetSpec,GRASS_PRESETS,readGrassRecipeSource} from "asset-tooling/recipes/grass";
import {type AssetRef} from "asset-tooling/operations";
import {storeAssetObject} from "asset-tooling/operations/store";
import {readRenderDerivativeRecipeSource,RENDER_DERIVATIVE_PRESETS} from "asset-tooling/recipes/render-derivatives";
import {canonicalJson} from "../../src/canonical.js";
import {writeIfChanged} from "../reconcile-file.js";
import {generateAsset,verifyAsset,inspectNativeVegetationMesh,renderNativeVegetationPreview,packageNativeVegetation} from "../native-vegetation.js";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),directory=path.join(root,".artifacts/grass-clumps");
const source=await readGrassRecipeSource(),renderer=await readRenderDerivativeRecipeSource();
const variants=GRASS_PRESETS;
const meshes:Record<string,AssetRef>={},images:Record<string,AssetRef>={},evidence:Record<string,unknown>={};
let geometryStagesExecuted=0,renderStagesExecuted=0;
 await mkdir(directory,{recursive:true});
 for(const [id,parameters] of Object.entries(variants)) {
   const key=id,geometryWorkspace=path.join(directory,key);await mkdir(geometryWorkspace,{recursive:true});
   await writeIfChanged(path.join(geometryWorkspace,"grass.py"),source.bytes);await writeIfChanged(path.join(geometryWorkspace,"wheat.py"),source.authoring.bytes);
   const spec=createGrassAssetSpec({assetId:`grass.${key}`,parameters,scriptSha256:source.sha256,authoringSha256:source.authoring.sha256,blenderVersion:source.blenderVersion});
   const geometrySpecPath=path.join(geometryWorkspace,"asset.json");await writeIfChanged(geometrySpecPath,Buffer.from(canonicalJson(spec)+"\n"));
   const generated=await generateAsset(geometrySpecPath);assert.equal((await verifyAsset(geometrySpecPath)).status,"exact");
   if(generated.cache.status!=="hit") {geometryStagesExecuted++;}
   const geometry=generated.receipt.observations.script;
   const bytes=await readFile(path.join(geometryWorkspace,"grass.glb"));
   const mesh=(await storeAssetObject(root,{bytes,kind:"mesh",mediaType:"model/gltf-binary",metadata:{generator:"external.blender.script@1",recipe:"grass-v1",
    presetId:id,scriptSha256:source.sha256,authoringSha256:source.authoring.sha256,sourceSpecSha256:generated.receipt.spec.sha256,geometry}})).asset;
   const {imported,bounds}=await inspectNativeVegetationMesh(root,mesh,parameters.maxTriangles);
   assert.ok(bounds.min[1]!>=-1e-5);
   assert.ok(Math.abs(bounds.min[1]!)<1e-5);assert.ok(bounds.max[1]!<=parameters.bladeHeight+1e-5);
   meshes[key]=mesh;evidence[key]={receipt:generated.receipt,imported,bounds};
  const rendered=await renderNativeVegetationPreview({root,directory,renderer,prefix:"grass",id,mesh:meshes[id]!,
   parameters:{...RENDER_DERIVATIVE_PRESETS.icon,width:384,height:384,samples:16,padding:.04,
    framing:{type:"shared-orthographic",center:[0,0.22,0],horizontalSpan:1.25,pivot:[0,0,0]}}});
  if(rendered.executed) {renderStagesExecuted++;}
  images[id]=rendered.image;evidence[`${id}-render`]={receipt:rendered.receipt};
 }
 const packaged=await packageNativeVegetation(root,directory,"grass",meshes,images);
 await writeIfChanged(path.join(directory,"evidence.json"),Buffer.from(canonicalJson({schemaVersion:1,evidence,distributionFiles:packaged.files,packageOnlyMatches:true,
  unit:"meter",origin:"native-root-ground-anchor",consumerPlacementAuthority:false})+"\n"));
 console.log(JSON.stringify({geometryStagesExecuted,geometryReplayStages:Object.keys(meshes).length,renderStagesExecuted,renderReplayStages:Object.keys(images).length,packageBytesWritten:packaged.bytesWritten,packageFiles:packaged.files.length,
  packageOnlyMatches:true}));
