import {test,type TestContext} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,readdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {NodeIO,type Document} from "@gltf-transform/core";
import {materialGlb} from "./fixtures/material-glb.js";
import {storeAssetObject,resolveAssetObject,assetObjectPortablePath} from "../src/asset-store.js";
import {createAssetRef} from "../src/operations.js";
import {normalizeTreeAppearanceFamily,executeTreeAppearanceFamily,executeTreeAppearanceState} from "../src/tree-appearance-recipes.js";
import {exportAssetBundle,verifyAssetBundle,readAssetBundleAsset,STATIC_ASSET_BUNDLE_PROFILE} from "../src/asset-bundle.js";
const placement={axes:"right-handed-y-up",unit:"meter",origin:"native-root-ground-anchor"};
const white=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=","base64");
function nativeTree(change:Record<string,unknown>={}) {
 return materialGlb({scenes:[{nodes:[0,1,2]}],nodes:[{name:"trunk",mesh:0},{name:"branches",mesh:0},{name:"foliage",mesh:1}],
  meshes:[{name:"bark",primitives:[{attributes:{POSITION:0,NORMAL:1,TEXCOORD_0:2,TANGENT:4},indices:3,material:1}]},
   {name:"foliage",primitives:[{attributes:{POSITION:0,NORMAL:1,TEXCOORD_0:2,TANGENT:4},indices:3,material:0}]}],
  materials:[{name:"tree-foliage",pbrMetallicRoughness:{baseColorTexture:{index:0},roughnessFactor:.8},doubleSided:true},
   {name:"tree-bark",pbrMetallicRoughness:{baseColorFactor:[.4,.2,.1,1],roughnessFactor:.9}}],...change});
}
async function fixture(t:TestContext,bytes=nativeTree()) {
 const root=await mkdtemp(path.join(tmpdir(),"tree-appearance-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=(await storeAssetObject(root,{kind:"mesh",mediaType:"model/gltf-binary",bytes,metadata:placement})).asset;
 const png=(await storeAssetObject(root,{kind:"image",mediaType:"image/png",bytes:white})).asset;
 const family={schemaVersion:1,id:"oak.reference",source,placement,states:[
  {id:"summer",baseColor:png,factor:[.2,.7,.1,1]}, {id:"autumn",baseColor:png,factor:[.9,.3,.05,1]}, {id:"winter",baseColor:png,factor:[1,1,1,0]}]};
 return {root,source,png,family};
}
function structure(document:Document) {
 return {nodes:document.getRoot().listNodes().map(n=>({name:n.getName(),matrix:n.getMatrix(),children:n.listChildren().map(c=>c.getName())})),
  meshes:document.getRoot().listMeshes().map(m=>m.listPrimitives().map(p=>({indices:[...p.getIndices()!.getArray()!],attributes:Object.fromEntries(p.listSemantics().map(s=>[s,[...p.getAttribute(s)!.getArray()!]]))}))),
  bark:document.getRoot().listMaterials().filter(m=>m.getName()==="tree-bark").map(m=>({factor:m.getBaseColorFactor(),roughness:m.getRoughnessFactor(),alpha:m.getAlphaMode()}))};
}
test("seasonal state derivation preserves the independently authored native-ground structure and bark",async t=>{
 const {root,family,source}=await fixture(t),accepted=await executeTreeAppearanceFamily(root,family);
 assert.deepEqual(accepted.states.map(s=>s.id),["autumn","summer","winter"]);assert.deepEqual(accepted.execution,{materialOperations:3,geometryGenerators:0});
 const io=new NodeIO(),original=await io.readBinary(await resolveAssetObject(root,source));
 assert.deepEqual(original.getRoot().listNodes().map(n=>n.getWorldTranslation()),[[0,0,0],[0,0,0],[0,0,0]]);
 for(const state of accepted.states) {
  const document=await io.readBinary(await resolveAssetObject(root,state.output));assert.deepEqual(structure(document),structure(original));
  const leaves=document.getRoot().listMaterials().find(m=>m.getName()==="tree-foliage")!;
  assert.deepEqual(leaves.getBaseColorFactor(),family.states.find(s=>s.id===state.id)!.factor);
  assert.equal(leaves.getAlphaMode(),"MASK");assert.equal(leaves.getAlphaCutoff(),.5);
  assert.equal(state.output.metadata.sourceSha256,source.sha256);assert.deepEqual(state.build.inputs.source,source);
 }
 assert.deepEqual(await executeTreeAppearanceFamily(root,{...family,states:[...family.states].reverse()}),accepted);
});
test("an isolated material edit leaves siblings and source objects untouched and matches full cold replay",async t=>{
 const {root,family}=await fixture(t),first=await executeTreeAppearanceFamily(root,family);
 const changed={...family,states:family.states.map(s=>s.id==="autumn"?{...s,factor:[.6,.1,.04,1]}:s)};
 const writer=NodeIO.prototype.writeBinary;let writes=0;
 let selected:Awaited<ReturnType<typeof executeTreeAppearanceState>>;
 NodeIO.prototype.writeBinary=async function(document) {writes++;return writer.call(this,document);};
 try {selected=await executeTreeAppearanceState(root,changed,"autumn");} finally {NodeIO.prototype.writeBinary=writer;}
 assert.equal(writes,1,"isolated edit performs exactly one authoritative material export");assert.notEqual(selected.output.sha256,first.states[0]!.output.sha256);
 for(const id of ["summer","winter"]) assert.deepEqual(await executeTreeAppearanceState(root,changed,id),first.states.find(s=>s.id===id));
 const replay=await executeTreeAppearanceFamily(root,changed);assert.deepEqual(replay.states[0],selected);
 const fresh=await fixture(t);
 assert.deepEqual(await executeTreeAppearanceFamily(fresh.root,{...changed,source:fresh.source,states:changed.states.map(s=>({...s,baseColor:fresh.png}))}),replay);
 const removed={...family,states:family.states.filter(s=>s.id!=="winter")};assert.deepEqual((await executeTreeAppearanceFamily(root,removed)).states,first.states.filter(s=>s.id!=="winter"));
 const added={...family,states:[...family.states,{...family.states[0]!,id:"spring"}]};
 for(const state of (await executeTreeAppearanceFamily(root,added)).states.filter(s=>s.id!=="spring")) assert.deepEqual(state,first.states.find(s=>s.id===state.id));
});
test("family IDs, placement, material references and native component anchors fail closed",async t=>{
 const {root,family,png}=await fixture(t);
 for(const mutant of [{...family,states:[family.states[0],family.states[0]]},{...family,states:[]},
  {...family,placement:{...placement,unit:"centimeter"}},{...family,placement:{...placement,origin:"center"}},
  {...family,states:[{...family.states[0],factor:[1,1,1,2]}]},{...family,states:[{...family.states[0],baseColor:createAssetRef({...png,kind:"scene"})}]}]) assert.throws(()=>normalizeTreeAppearanceFamily(mutant));
 await assert.rejects(executeTreeAppearanceState(root,family,"missing"),/unknown appearance/);
 for(const nodes of [[{name:"trunk",mesh:0},{name:"trunk",mesh:0},{name:"foliage",mesh:1}],
  [{name:"trunk",mesh:0,translation:[0,1,0]},{name:"branches",mesh:0},{name:"foliage",mesh:1}]]) {
  const bad=await fixture(t,nativeTree({nodes}));await assert.rejects(executeTreeAppearanceFamily(bad.root,bad.family),/component|origin/);
 }
});
test("absent or corrupt state dependencies cannot publish over the last accepted selected family",async t=>{
 const {root,family,png}=await fixture(t),first=await executeTreeAppearanceFamily(root,family),directory=path.join(root,"package");
 const invocation={parameters:{profile:STATIC_ASSET_BUNDLE_PROFILE,assets:first.states.map(s=>({key:family.id,variant:s.id}))},inputs:{assets:first.states.map(s=>s.output)}};
 const packaged=await exportAssetBundle(root,directory,invocation),files=(await readdir(path.join(root,".asset-tooling/objects"),{recursive:true})).sort();
 const absent=createAssetRef({...png,sha256:"0".repeat(64)});
 await assert.rejects(executeTreeAppearanceFamily(root,{...family,states:[family.states[0],{...family.states[1],baseColor:absent}]}),/missing/);
 assert.deepEqual((await readdir(path.join(root,".asset-tooling/objects"),{recursive:true})).sort(),files);
 await writeFile(path.join(root,...assetObjectPortablePath(png).split("/")),Buffer.alloc(png.byteLength));
 await assert.rejects(executeTreeAppearanceFamily(root,family),/hash/);
 await rm(path.join(root,".asset-tooling"),{recursive:true,force:true});
 const checked=await verifyAssetBundle(directory,packaged.manifest);
 for(const state of first.states) assert.ok((await readAssetBundleAsset(directory,checked.manifest,family.id,state.id)).length>0);
});

test("shared source edits change every dependent build and excessive accessor claims fail before decoding",async t=>{
 const {root,family}=await fixture(t),first=await executeTreeAppearanceFamily(root,family);
 const source=(await storeAssetObject(root,{kind:"mesh",mediaType:"model/gltf-binary",metadata:placement,bytes:nativeTree({asset:{version:"2.0",generator:"independent-source-edit"}})})).asset;
 const changed=await executeTreeAppearanceFamily(root,{...family,source});
 for(const state of changed.states) {
  assert.deepEqual(state.build.inputs.source,source);assert.notDeepEqual(state.build,first.states.find(s=>s.id===state.id)!.build);
 }
 const oversized=await fixture(t,nativeTree({accessors:[{componentType:5126,count:3000001,type:"VEC3",min:[0,0,0],max:[1,1,0]}]}));
 await assert.rejects(executeTreeAppearanceFamily(oversized.root,oversized.family),/accessor exceeds count/);
});

test("oversized declared PNG refs fail at family admission before object lookup or writes",async t=>{
 const {root,family,png}=await fixture(t);
 const oversized=createAssetRef({...png,sha256:"0".repeat(64),byteLength:64*1024*1024+1});
 const invalid={...family,states:[{...family.states[0],baseColor:oversized}]};
 assert.throws(()=>normalizeTreeAppearanceFamily(invalid),/64 MiB/);
 const files=(await readdir(path.join(root,".asset-tooling/objects"),{recursive:true})).sort();
 await assert.rejects(executeTreeAppearanceFamily(root,invalid),/64 MiB/);
 await assert.rejects(executeTreeAppearanceState(root,invalid,"summer"),/64 MiB/);
 assert.deepEqual((await readdir(path.join(root,".asset-tooling/objects"),{recursive:true})).sort(),files);
});
