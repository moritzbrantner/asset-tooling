import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdir,mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {NodeIO,type Document} from "@gltf-transform/core";
import {createAssetRef,type AssetRef} from "asset-tooling/operations";
import {resolveAssetObject,storeAssetObject} from "asset-tooling/operations/store";
import {executeLeafArtworkRecipe,executePreservedLeafArtworkRecipe,LEAF_ARTWORK_PRESETS} from "asset-tooling/recipes/leaf-artwork";
import {executeImageEncodePngOperation} from "asset-tooling/operations/image/codecs";
import {executeTreeAppearanceFamily,executeTreeAppearanceState,type TreeAppearanceFamily} from "asset-tooling/recipes/tree-appearances";
import {exportAssetBundle,verifyAssetBundle,readAssetBundleAsset,STATIC_ASSET_BUNDLE_PROFILE} from "asset-tooling/operations/bundle";
import {prepareRenderDerivativeRecipe,readRenderDerivativeRecipeSource,RENDER_DERIVATIVE_PRESETS} from "asset-tooling/recipes/render-derivatives";
import {canonicalJson} from "../../src/canonical.js";
import {writeIfChanged} from "../reconcile-file.js";
const {generateAsset,verifyAsset}:{generateAsset:(p:string)=>Promise<unknown>;verifyAsset:(p:string)=>Promise<{status:string}>}=await import(new URL("../../src/core.js",import.meta.url).href);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),directory=path.join(root,".artifacts/tree-appearances");
const inventory:unknown=JSON.parse(await readFile(path.join(root,".artifacts/trees/assets.json"),"utf8"));
if(!inventory || typeof inventory!=="object" || !("assets" in inventory) || !inventory.assets || typeof inventory.assets!=="object" || !("broadleaf.composed" in inventory.assets)) throw new Error("run the documented tree example first");
const source=createAssetRef(inventory.assets["broadleaf.composed"]),original=await resolveAssetObject(root,source),io=new NodeIO();
function structure(document:Document) {
 return {nodes:document.getRoot().listNodes().map(n=>({name:n.getName(),matrix:n.getMatrix(),children:n.listChildren().map(c=>c.getName())})),
  meshes:document.getRoot().listMeshes().map(m=>({name:m.getName(),primitives:m.listPrimitives().map(p=>({indices:[...p.getIndices()!.getArray()!],attributes:Object.fromEntries(p.listSemantics().map(s=>[s,[...p.getAttribute(s)!.getArray()!]]))}))})),
  bark:document.getRoot().listMaterials().filter(m=>m.getName()==="tree-bark").map(m=>({factor:m.getBaseColorFactor(),roughness:m.getRoughnessFactor(),metallic:m.getMetallicFactor(),alpha:m.getAlphaMode(),doubleSided:m.getDoubleSided()}))};
}
const accepted=structure(await io.readBinary(original)),cold=await mkdtemp(path.join(tmpdir(),"tree-appearance-example-"));
try {
 await mkdir(directory,{recursive:true});
 const summer=await executeLeafArtworkRecipe(root,LEAF_ARTWORK_PRESETS.broad);
 const autumn=await executePreservedLeafArtworkRecipe(root,{...LEAF_ARTWORK_PRESETS.broad,low:[240,176,51],high:[120,49,14]},{mask:summer.maskStep});
 assert.deepEqual(autumn.outputs.mask,summer.outputs.mask);assert.equal(autumn.execution.maskPixelsGenerated,0);
 async function png(image:AssetRef) {
  return createAssetRef((await executeImageEncodePngOperation(root,{inputs:{source:image},parameters:{compressionLevel:9}})).outputs.output);
 }
 const green=await png(summer.outputs.image),orange=await png(autumn.outputs.image);
 const family:TreeAppearanceFamily={schemaVersion:1,id:"broadleaf.reference",source,
  placement:{axes:"right-handed-y-up",unit:"meter",origin:"native-root-ground-anchor"},states:[
   {id:"summer",baseColor:green,factor:[1,1,1,1]}, {id:"autumn",baseColor:orange,factor:[1,1,1,1]}, {id:"winter",baseColor:green,factor:[1,1,1,0]}]};
 for(const ref of [source,green,orange]) await storeAssetObject(cold,{kind:ref.kind,mediaType:ref.mediaType,metadata:ref.metadata,bytes:await resolveAssetObject(root,ref)});
 const full=await executeTreeAppearanceFamily(root,family);assert.deepEqual(await executeTreeAppearanceFamily(cold,{...family,states:[...family.states].reverse()}),full);
 const edited:TreeAppearanceFamily={...family,states:family.states.map(s=>s.id==="autumn"?{...s,factor:[0.8,0.9,1,1]}:s)};
 const selected=await executeTreeAppearanceState(root,edited,"autumn"),clean=await executeTreeAppearanceFamily(cold,edited);
 assert.deepEqual(clean.states,full.states.map(s=>s.id==="autumn"?selected:s));
 const renderer=await readRenderDerivativeRecipeSource();
 async function render(id:string,mesh:AssetRef) {
  const destination=path.join(directory,id);await mkdir(destination,{recursive:true});
  const prepared=await prepareRenderDerivativeRecipe(root,{assetId:`tree-appearance.${id}`,source:mesh,scriptSha256:renderer.sha256,blenderVersion:renderer.blenderVersion,
   parameters:{...RENDER_DERIVATIVE_PRESETS.thumbnail,width:384,height:512,samples:16}});
  await writeIfChanged(path.join(destination,"render_static_glb.py"),renderer.bytes);await writeIfChanged(path.join(destination,"source.glb"),prepared.sourceBytes);
  await writeIfChanged(path.join(destination,"asset.json"),Buffer.from(canonicalJson(prepared.spec)+"\n"));
  await generateAsset(path.join(destination,"asset.json"));assert.equal((await verifyAsset(path.join(destination,"asset.json"))).status,"exact");
 }
 await render("source",source);
 for(const state of full.states) {
  const bytes=await resolveAssetObject(root,state.output);assert.deepEqual(structure(await io.readBinary(bytes)),accepted);
  await writeIfChanged(path.join(directory,`${state.id}.glb`),bytes);await render(state.id,state.output);
 }
 const invocation={parameters:{profile:STATIC_ASSET_BUNDLE_PROFILE,assets:full.states.map(s=>({key:family.id,variant:s.id}))},inputs:{assets:full.states.map(s=>s.output)}};
 const packaged=await exportAssetBundle(root,path.join(directory,"package"),invocation),independent=await exportAssetBundle(cold,path.join(cold,"package"),invocation);
 assert.deepEqual(independent.manifest,packaged.manifest);await rm(path.join(cold,".asset-tooling"),{recursive:true,force:true});
 const verified=await verifyAssetBundle(path.join(cold,"package"),independent.manifest);
 for(const state of full.states) assert.deepEqual(await readAssetBundleAsset(path.join(cold,"package"),verified.manifest,family.id,state.id),await resolveAssetObject(root,state.output));
 await writeIfChanged(path.join(directory,"package.ref.json"),Buffer.from(canonicalJson(packaged.manifest)+"\n"));
 await writeIfChanged(path.join(directory,"evidence.json"),Buffer.from(canonicalJson({full,edited,selected,summer,autumn,structuralEquality:true,coldReplayMatches:true,isolatedMaterialOperations:1,geometryGenerators:0})+"\n"));
 console.log(JSON.stringify({states:full.states.map(s=>s.id),geometryGenerators:0,isolatedMaterialOperations:1,coldReplayMatches:true,packageOnlyMatches:true,packageBytesWritten:packaged.bytesWritten,files:packaged.files.length}));
} finally {await rm(cold,{recursive:true,force:true});}
