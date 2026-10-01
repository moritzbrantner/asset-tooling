import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NodeIO, type Document } from "@gltf-transform/core";
import { createAssetRef, type AssetRef } from "asset-tooling/operations";
import { resolveAssetObject, storeAssetObject } from "asset-tooling/operations/store";
import { executeGltfBaseColorOperation } from "asset-tooling/operations/processing/gltf-material";
import { prepareRenderDerivativeRecipe, readRenderDerivativeRecipeSource, RENDER_DERIVATIVE_PRESETS } from "asset-tooling/recipes/render-derivatives";
import { exportAssetBundle, verifyAssetBundle, STATIC_ASSET_BUNDLE_PROFILE } from "asset-tooling/operations/bundle";
import { canonicalJson } from "../../src/canonical.js";
import { writeIfChanged } from "../reconcile-file.js";

// The existing generator/backend remains the authority. This bridge keeps legacy core
// declarations outside the strict project's unrelated migration scope.
const {generateAsset,verifyAsset}:{generateAsset:(p:string)=>Promise<unknown>;verifyAsset:(p:string)=>Promise<{status:string}>}=await import(new URL("../../src/core.js",import.meta.url).href);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),directory=path.join(root,".artifacts/leaf-artwork/tree");
const trees:unknown=JSON.parse(await readFile(path.join(root,".artifacts/trees/assets.json"),"utf8"));
const leaves:unknown=JSON.parse(await readFile(path.join(root,".artifacts/leaf-artwork/evidence.json"),"utf8"));
function record(value:unknown,key:string):Record<string,unknown> {
  if(!value || typeof value!=="object" || !(key in value)) throw new Error(`missing ${key} inventory; run the documented example first`);
  const selected=value[key as keyof typeof value];
  if(!selected || typeof selected!=="object" || Array.isArray(selected)) throw new Error(`invalid ${key} inventory`);
  return selected as Record<string,unknown>; // Checked JSON record boundary; each AssetRef is validated below.
}
const source=createAssetRef(record(trees,"assets")["broadleaf.composed"]),pngs=record(leaves,"pngs");
const original=await resolveAssetObject(root,source),io=new NodeIO().setAllowNetwork(false),master=await io.readBinary(original);
function structure(document:Document) {
  return {nodes:document.getRoot().listNodes().map(n=>({name:n.getName(),matrix:n.getMatrix(),children:n.listChildren().map(c=>c.getName())})),
    meshes:document.getRoot().listMeshes().map(m=>({name:m.getName(),primitives:m.listPrimitives().map(p=>({mode:p.getMode(),indices:[...p.getIndices()!.getArray()!],
      attributes:Object.fromEntries(p.listSemantics().map(s=>[s,[...p.getAttribute(s)!.getArray()!]])),material:p.getMaterial()!.getName()}))})),
    bark:document.getRoot().listMaterials().filter(m=>m.getName()==="tree-bark").map(m=>({color:m.getBaseColorFactor(),roughness:m.getRoughnessFactor(),metallic:m.getMetallicFactor(),alpha:m.getAlphaMode(),doubleSided:m.getDoubleSided()}))};
}
const accepted=structure(master),renderer=await readRenderDerivativeRecipeSource(),cold=await mkdtemp(path.join(tmpdir(),"leaf-tree-example-"));
await mkdir(directory,{recursive:true});
const finished:AssetRef[]=[],evidence:Record<string,unknown>={},variants=["broad.summer","broad.autumn","slender.summer"];
try {
  async function render(id:string,mesh:AssetRef) {
    const destination=path.join(directory,id);await mkdir(destination,{recursive:true});
    const recipe=await prepareRenderDerivativeRecipe(root,{assetId:`leaf-review.${id}`,source:mesh,scriptSha256:renderer.sha256,blenderVersion:renderer.blenderVersion,
      parameters:{...RENDER_DERIVATIVE_PRESETS.thumbnail,width:384,height:512,samples:16}});
    await writeIfChanged(path.join(destination,"render_static_glb.py"),renderer.bytes);
    await writeIfChanged(path.join(destination,"source.glb"),recipe.sourceBytes);
    await writeIfChanged(path.join(destination,"asset.json"),Buffer.from(canonicalJson(recipe.spec)+"\n"));
    await generateAsset(path.join(destination,"asset.json"));assert.equal((await verifyAsset(path.join(destination,"asset.json"))).status,"exact");
  }
  await render("source",source);
  for(const id of variants) {
    const png=createAssetRef(pngs[id]),invocation={inputs:{source,"base-color":png},parameters:{materialName:"tree-foliage",baseColorFactor:[1,1,1,1],texCoord:0,
      sampler:{magFilter:"linear",minFilter:"linear",wrapS:"clamp-to-edge",wrapT:"clamp-to-edge"},alpha:{mode:"MASK",cutoff:0.5}}};
    const result=await executeGltfBaseColorOperation(root,invocation),mesh=createAssetRef(result.outputs.output),bytes=await resolveAssetObject(root,mesh);
    for(const ref of [source,png]) await storeAssetObject(cold,{kind:ref.kind,mediaType:ref.mediaType,metadata:ref.metadata,bytes:await resolveAssetObject(root,ref)});
    assert.deepEqual(await executeGltfBaseColorOperation(cold,invocation),result);
    const parsed=await io.readBinary(bytes);assert.deepEqual(structure(parsed),accepted);
    const material=parsed.getRoot().listMaterials().find(m=>m.getName()==="tree-foliage")!;
    assert.equal(material.getAlphaMode(),"MASK");assert.equal(material.getAlphaCutoff(),0.5);
    assert.deepEqual(Buffer.from(material.getBaseColorTexture()!.getImage()!),await resolveAssetObject(root,png));
    finished.push(mesh);await writeIfChanged(path.join(directory,`${id}.glb`),bytes);
    evidence[id]={source,png,result,geometryAndBarkUnchanged:true,coldReplayMatches:true};await render(id,mesh);
  }
  const packaged=await exportAssetBundle(root,path.join(directory,"package"),{inputs:{assets:finished},parameters:{profile:STATIC_ASSET_BUNDLE_PROFILE,assets:variants.map(id=>({key:`tree.${id}`,variant:"alpha-foliage"}))}});
  await verifyAssetBundle(path.join(directory,"package"),packaged.manifest);
  await writeIfChanged(path.join(directory,"package.ref.json"),Buffer.from(canonicalJson(packaged.manifest)+"\n"));
  await writeIfChanged(path.join(directory,"evidence.json"),Buffer.from(canonicalJson({variants,evidence,geometryGeneratorsExecuted:0,renderReplays:4})+"\n"));
  console.log(JSON.stringify({variants,geometryGeneratorsExecuted:0,materialColdReplays:3,renderReplays:4,packageBytesWritten:packaged.bytesWritten}));
} finally {await rm(cold,{recursive:true,force:true});}
