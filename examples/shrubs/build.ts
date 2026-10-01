import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdir,readFile} from "node:fs/promises";
import {createTreeAssetSpec,TREE_PRESETS,SAPLING_TREE_SOURCE,readTreeRecipeSource} from "asset-tooling/recipes/trees";
import {type AssetRef} from "asset-tooling/operations";
import {storeAssetObject} from "asset-tooling/operations/store";
import {readRenderDerivativeRecipeSource,RENDER_DERIVATIVE_PRESETS} from "asset-tooling/recipes/render-derivatives";
import {canonicalJson} from "../../src/canonical.js";
import {writeIfChanged} from "../reconcile-file.js";
import {sha256Bytes} from "../../src/hash.js";
import {generateAsset,verifyAsset,inspectNativeVegetationMesh,renderNativeVegetationPreview,packageNativeVegetation} from "../native-vegetation.js";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),directory=path.join(root,".artifacts/shrubs");
const archive=await readFile(process.argv[2]?path.resolve(process.argv[2]):path.join(root,".artifacts/sapling/sapling-0.3.7.zip"));
assert.equal(archive.length,SAPLING_TREE_SOURCE.byteLength);assert.equal(sha256Bytes(archive),SAPLING_TREE_SOURCE.sha256);
const source=await readTreeRecipeSource(),renderer=await readRenderDerivativeRecipeSource();
const variants={compact:TREE_PRESETS.shrub,upright:{...TREE_PRESETS.shrub,height:1.4,branchAngle:55},
 loose:{...TREE_PRESETS.shrub,primaryBranches:12,secondaryBranches:3,foliageDensity:128,leafScale:.12}};
const meshes:Record<string,AssetRef>={},images:Record<string,AssetRef>={},evidence:Record<string,unknown>={};
let geometryStagesExecuted=0,renderStagesExecuted=0;
 await mkdir(directory,{recursive:true});
 let compactGeometry:unknown;
 for(const [id,parameters] of Object.entries(variants)) {
  const components: ("composed"|"trunk"|"branches"|"foliage")[]=id==="compact"?["composed","trunk","branches","foliage"]:["composed"];
  for(const component of components) {
   const key=component==="composed"?id:`${id}.${component}`,workspace=path.join(directory,key);await mkdir(workspace,{recursive:true});
   await writeIfChanged(path.join(workspace,"tree.py"),source.bytes);await writeIfChanged(path.join(workspace,"sapling.zip"),archive);
   const spec=createTreeAssetSpec({assetId:`shrub.${key}`,parameters:{...parameters,component},scriptSha256:source.sha256,blenderVersion:source.blenderVersion});
   const specPath=path.join(workspace,"asset.json");await writeIfChanged(specPath,Buffer.from(canonicalJson(spec)+"\n"));
   const generated=await generateAsset(specPath);assert.equal((await verifyAsset(specPath)).status,"exact");
   if(generated.cache.status!=="hit") {geometryStagesExecuted++;}
   const geometry=generated.receipt.observations.script;
   if(key==="compact") {compactGeometry=geometry.componentGeometrySha256;}
   if(id==="compact") {assert.deepEqual(geometry.componentGeometrySha256,compactGeometry);}
   const bytes=await readFile(path.join(workspace,"tree.glb"));
   const mesh=(await storeAssetObject(root,{bytes,kind:"mesh",mediaType:"model/gltf-binary",metadata:{generator:"external.blender.script@1",recipe:"sapling-tree-v1",
    presetId:"shrub",variantId:id,component,scriptSha256:source.sha256,sourceSpecSha256:generated.receipt.spec.sha256,source:{...SAPLING_TREE_SOURCE},geometry}})).asset;
   const {imported,bounds}=await inspectNativeVegetationMesh(root,mesh,parameters.maxTriangles);
   assert.ok(bounds.min[1]!>=-1e-5);
   if(component==="composed") {assert.ok(Math.abs(bounds.min[1]!)<1e-5);assert.ok(Math.abs(bounds.max[1]!-parameters.height)<1e-5);}
   meshes[key]=mesh;evidence[key]={receipt:generated.receipt,imported,bounds};
  }
  const rendered=await renderNativeVegetationPreview({root,directory,renderer,prefix:"shrub",id,mesh:meshes[id]!,
   parameters:{...RENDER_DERIVATIVE_PRESETS.icon,width:320,height:384,samples:16,padding:.04,
    framing:{type:"shared-orthographic",center:[0,0.65,0],horizontalSpan:2.2,pivot:[0,0,0]}}});
  if(rendered.executed) {renderStagesExecuted++;}
  images[id]=rendered.image;evidence[`${id}-render`]={receipt:rendered.receipt};
 }
 const packaged=await packageNativeVegetation(root,directory,"shrub",meshes,images);
 await writeIfChanged(path.join(directory,"evidence.json"),Buffer.from(canonicalJson({schemaVersion:1,evidence,distributionFiles:packaged.files,packageOnlyMatches:true,
  componentGeometryMatches:true,unit:"meter",origin:"native-root-ground-anchor",consumerPlacementAuthority:false})+"\n"));
 console.log(JSON.stringify({geometryStagesExecuted,geometryReplayStages:Object.keys(meshes).length,renderStagesExecuted,renderReplayStages:Object.keys(images).length,packageBytesWritten:packaged.bytesWritten,packageFiles:packaged.files.length,
  componentGeometryMatches:true,packageOnlyMatches:true}));
