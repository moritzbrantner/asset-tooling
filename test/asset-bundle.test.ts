import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, symlink } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { canonicalJson } from "../src/canonical.js";
import { sha256Bytes } from "../src/hash.js";
import { storeAssetObject, assetObjectPortablePath, resolveAssetObject } from "../src/asset-store.js";
import { createAssetRef } from "../src/operations.js";
import { ASSET_BUNDLE_MEDIA_TYPE, STATIC_ASSET_BUNDLE_PROFILE, createAssetBundleBuildIdentity, executeAssetBundleOperation,
  exportAssetBundle, parseAssetBundleManifest, readAssetBundleAsset, resolveAssetBundleEntry, verifyAssetBundle, type AssetBundleManifest } from "../src/asset-bundle.js";

// Independently authored 1px white PNG and triangle GLB; packaging never authors geometry.
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=","base64");
function triangle(scale=1,external=false,color=[1,1,1,1]):Buffer {
  const binary=Buffer.alloc(80);
  [0,0,0,scale,0,0,0,scale,0,0,0,1,0,0,1,0,0,1].forEach((n,i)=>binary.writeFloatLE(n,i*4));
  [0,1,2].forEach((n,i)=>binary.writeUInt16LE(n,72+i*2));
  const json=Buffer.from(JSON.stringify({asset:{version:"2.0"},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],
    meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1},indices:2,material:0}]}],materials:[{pbrMetallicRoughness:{baseColorFactor:color}}],buffers:[{byteLength:binary.length,...(external?{uri:"missing.bin"}:{})}],
    bufferViews:[{buffer:0,byteOffset:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:36},{buffer:0,byteOffset:72,byteLength:6}],
    accessors:[{bufferView:0,componentType:5126,count:3,type:"VEC3",min:[0,0,0],max:[scale,scale,0]},
      {bufferView:1,componentType:5126,count:3,type:"VEC3"},{bufferView:2,componentType:5123,count:3,type:"SCALAR"}]}));
  return glb(json,binary);
}
function glb(json:Buffer,binary:Buffer):Buffer {
  const padded=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]),header=Buffer.alloc(20),bin=Buffer.alloc(8);
  header.write("glTF");header.writeUInt32LE(2,4);header.writeUInt32LE(28+padded.length+binary.length,8);
  header.writeUInt32LE(padded.length,12);header.writeUInt32LE(0x4e4f534a,16);bin.writeUInt32LE(binary.length);bin.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([header,padded,bin,binary]);
}
async function workspace(t:TestContext) {
  const root=await mkdtemp(path.join(tmpdir(),"asset-bundle-")),directory=path.join(root,"export"),cold=path.join(root,"cold");
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=(await storeAssetObject(root,{bytes:triangle(),kind:"mesh",mediaType:"model/gltf-binary",metadata:{sourceSha256:"a".repeat(64),license:"CC0-1.0",sourceId:"fixture.original"}})).asset;
  const image=(await storeAssetObject(root,{bytes:png,kind:"image",mediaType:"image/png",metadata:{producer:"independent-fixture",license:"CC0-1.0"}})).asset;
  const invocation={parameters:{profile:STATIC_ASSET_BUNDLE_PROFILE,assets:[{key:"prop",variant:"default"},{key:"icon",variant:"small"},{key:"prop-copy",variant:"default"}]},inputs:{assets:[source,image,source]}};
  return {root,directory,cold,source,image,invocation};
}
async function snapshot(directory:string):Promise<Record<string,{mtime:number;sha:string}>> {
  const result:Record<string,{mtime:number;sha:string}>={};
  for(const child of await readdir(directory,{withFileTypes:true})) {
    if(child.isDirectory()) for(const [name,value] of Object.entries(await snapshot(path.join(directory,child.name)))) result[`${child.name}/${name}`]=value;
    else result[child.name]={mtime:(await stat(path.join(directory,child.name))).mtimeMs,sha:sha256Bytes(await readFile(path.join(directory,child.name)))};
  }
  return result;
}

test("selected bundle preserves logical variants and provenance while deduplicating real payloads",async t=>{
  const {root,directory,cold,source,image,invocation}=await workspace(t);
  const build=await createAssetBundleBuildIdentity(root,invocation);
  const reversed={parameters:{...invocation.parameters,assets:[...invocation.parameters.assets].reverse()},inputs:{assets:[...invocation.inputs.assets].reverse()}};
  assert.deepEqual(await createAssetBundleBuildIdentity(root,reversed),build);
  const operation=await executeAssetBundleOperation(root,invocation),manifestRef=createAssetRef(operation.outputs.manifest);
  assert.equal(manifestRef.mediaType,ASSET_BUNDLE_MEDIA_TYPE);
  const first=await exportAssetBundle(root,directory,invocation);
  assert.deepEqual(first.manifest,manifestRef);assert.equal(first.blobsWritten,2);assert.equal(first.blobsReused,0);assert.equal(first.assetsVerified,3);
  const verified=await verifyAssetBundle(directory,first.manifest);
  const manifest:AssetBundleManifest=verified.manifest;
  const parsed:AssetBundleManifest=parseAssetBundleManifest(await readFile(path.join(directory,"manifest.json")));
  assert.deepEqual(parsed,manifest);
  assert.deepEqual(manifest.assets.map(e=>`${e.key}/${e.variant}`),["icon/small","prop/default","prop-copy/default"]);
  assert.deepEqual(resolveAssetBundleEntry(manifest,"prop","default").source,source);
  assert.deepEqual(resolveAssetBundleEntry(manifest,"icon","small").source,image);
  assert.equal(resolveAssetBundleEntry(manifest,"prop-copy","default").path,resolveAssetBundleEntry(manifest,"prop","default").path);
  assert.equal(verified.uniquePayloads,2);
  assert.throws(()=>resolveAssetBundleEntry(manifest,"prop","unknown"),/does not contain/);
  const before=await snapshot(directory),warm=await exportAssetBundle(root,directory,reversed);
  assert.equal(warm.bytesWritten,0);assert.equal(warm.manifestStatus,"unchanged");assert.equal(warm.blobsReused,2);assert.deepEqual(await snapshot(directory),before);
  const fresh=await exportAssetBundle(root,cold,invocation);assert.equal(fresh.manifest.sha256,first.manifest.sha256);
  assert.deepEqual(await readFile(path.join(cold,"manifest.json")),await readFile(path.join(directory,"manifest.json")));
  // Consumer load works after removing the source store, without recreating it.
  await rm(path.join(root,".asset-tooling"),{recursive:true,force:true});
  const bytes=await readAssetBundleAsset(directory,manifest,"prop","default");assert.deepEqual(bytes,triangle());
  const doc=await new NodeIO().setAllowNetwork(false).readBinary(bytes);
  assert.deepEqual(Array.from(doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute("POSITION")!.getArray()!),[0,0,0,1,0,0,0,1,0]);
  assert.deepEqual(await readAssetBundleAsset(directory,manifest,"icon","small"),png);
  assert.deepEqual(await verifyAssetBundle(directory,first.manifest),verified);assert.deepEqual(await snapshot(directory),before);
  await assert.rejects(stat(path.join(root,".asset-tooling")),{code:"ENOENT"});
});

test("mesh edits, corrupt export repair and cold builds preserve unrelated files",async t=>{
  const {root,directory,cold,image,invocation}=await workspace(t);const first=await exportAssetBundle(root,directory,invocation);
  const before=await snapshot(directory),manifest=parseAssetBundleManifest(await readFile(path.join(directory,"manifest.json")));
  const changed=(await storeAssetObject(root,{bytes:triangle(2),kind:"mesh",mediaType:"model/gltf-binary",metadata:{license:"CC0-1.0",sourceId:"fixture.changed"}})).asset;
  const edit={parameters:invocation.parameters,inputs:{assets:[changed,image,changed]}};
  const updated=await exportAssetBundle(root,directory,edit);assert.equal(updated.blobsWritten,1);assert.equal(updated.blobsReused,1);assert.equal(updated.manifestStatus,"changed");
  const unchanged=resolveAssetBundleEntry(manifest,"icon","small").path;
  assert.deepEqual((await snapshot(directory))[unchanged],before[unchanged]);
  const coldResult=await exportAssetBundle(root,cold,edit);assert.equal(coldResult.manifest.sha256,updated.manifest.sha256);
  assert.deepEqual(await readFile(path.join(cold,"manifest.json")),await readFile(path.join(directory,"manifest.json")));
  const accepted=await snapshot(directory),pngPath=path.join(directory,unchanged);
  const corruption=Buffer.from(png);corruption[corruption.length-1]=corruption[corruption.length-1]!^1;await writeFile(pngPath,corruption);
  await assert.rejects(verifyAssetBundle(directory,updated.manifest),/hash/);
  const repaired=await exportAssetBundle(root,directory,edit);assert.equal(repaired.blobsWritten,1);assert.equal(repaired.manifestStatus,"unchanged");
  assert.deepEqual(await readFile(pngPath),png);
  assert.equal((await snapshot(directory))["manifest.json"]!.mtime,accepted["manifest.json"]!.mtime);
  await assert.rejects(verifyAssetBundle(directory,first.manifest),/hash|length/);
});

test("material-only edits retain geometry and source outputs while publishing only changed payloads",async t=>{
  const {root,directory,cold,source,image,invocation}=await workspace(t);
  const first=await exportAssetBundle(root,directory,invocation),old=(await verifyAssetBundle(directory,first.manifest)).manifest;
  const changed=(await storeAssetObject(root,{bytes:triangle(1,false,[.2,.3,.4,1]),kind:"mesh",mediaType:"model/gltf-binary",metadata:{sourceSha256:source.sha256,processor:"fixture.material-only"}})).asset;
  const edit={parameters:invocation.parameters,inputs:{assets:[changed,image,changed]}},result=await exportAssetBundle(root,directory,edit);
  assert.equal(result.blobsWritten,1);assert.equal(result.blobsReused,1);
  const current=(await verifyAssetBundle(directory,result.manifest)).manifest;
  const original=await new NodeIO().readBinary(await readAssetBundleAsset(directory,old,"prop","default"));
  const updated=await new NodeIO().readBinary(await readAssetBundleAsset(directory,current,"prop","default"));
  assert.deepEqual(original.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute("POSITION")!.getArray(),updated.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute("POSITION")!.getArray());
  assert.deepEqual(updated.getRoot().listMaterials()[0]!.getBaseColorFactor(),[.2,.3,.4,1]);
  assert.deepEqual(await resolveAssetObject(root,source),triangle());
  assert.equal((await exportAssetBundle(root,cold,edit)).manifest.sha256,result.manifest.sha256);
});

test("invalid dependencies, transport, paths and cancellation preserve the last accepted manifest",async t=>{
  const {root,directory,source,image,invocation}=await workspace(t);const first=await exportAssetBundle(root,directory,invocation),before=await snapshot(directory);
  const invalidPng=(await storeAssetObject(root,{bytes:Buffer.from("not a PNG"),kind:"image",mediaType:"image/png"})).asset;
  await assert.rejects(exportAssetBundle(root,directory,{parameters:invocation.parameters,inputs:{assets:[source,invalidPng,source]}}),/PNG/);
  const bad=(await storeAssetObject(root,{bytes:triangle(1,true),kind:"mesh",mediaType:"model/gltf-binary"})).asset;
  await assert.rejects(exportAssetBundle(root,directory,{parameters:invocation.parameters,inputs:{assets:[bad,image,bad]}}),/resource|validation|buffer|GLB/i);
  assert.deepEqual(await snapshot(directory),before);
  for(const unsafe of [root,path.dirname(root),path.join(root,".asset-tooling"),path.join(root,"assets/canonical"),path.join(root,".GIT"),path.join(root,".ASSET-TOOLING"),path.join(root,"Assets/CANONICAL"),path.join(root,".git."),path.join(root,".asset-tooling "),path.join(root,"assets/canonical.")]) await assert.rejects(exportAssetBundle(root,unsafe,invocation),/output directory/);
  for(const invalid of [ {profile:"unknown",assets:invocation.parameters.assets},
    {profile:STATIC_ASSET_BUNDLE_PROFILE,assets:[{key:"../escape",variant:"default"}]},
    {profile:STATIC_ASSET_BUNDLE_PROFILE,assets:[{key:"x",variant:"a"},{key:"x",variant:"a"}]},
    {profile:STATIC_ASSET_BUNDLE_PROFILE,assets:[]}, {...invocation.parameters,unknown:true} ]) await assert.rejects(exportAssetBundle(root,directory,{parameters:invalid,inputs:invocation.inputs}));
  await assert.rejects(exportAssetBundle(root,directory,{parameters:invocation.parameters,inputs:{assets:[source]}}),/one source/);
  const unsupported=createAssetRef({...image,kind:"audio",mediaType:"audio/wav"});
  await assert.rejects(exportAssetBundle(root,directory,{parameters:invocation.parameters,inputs:{assets:[source,unsupported,source]}}),/incompatible/);
  const tooMany={parameters:{profile:STATIC_ASSET_BUNDLE_PROFILE,assets:Array.from({length:257},(_,i)=>({key:`item-${i}`,variant:"default"}))},inputs:{assets:Array.from({length:257},()=>image)}};
  await assert.rejects(exportAssetBundle(root,directory,tooMany),/256/);
  await assert.rejects(verifyAssetBundle(directory,{...first.manifest,byteLength:8*1024*1024+1}),/8 MiB/);
  assert.throws(()=>parseAssetBundleManifest(Buffer.alloc(8*1024*1024+1)),/budget/);
  const overTotal={parameters:{profile:STATIC_ASSET_BUNDLE_PROFILE,assets:Array.from({length:5},(_,i)=>({key:`large-${i}`,variant:"default"}))},inputs:{assets:Array.from({length:5},(_,i)=>createAssetRef({...image,sha256:String(i+1).repeat(64),byteLength:64*1024*1024}))}};
  await assert.rejects(exportAssetBundle(root,directory,overTotal),/256 MiB/);
  const excessive=createAssetRef({...image,byteLength:64*1024*1024+1});
  await assert.rejects(exportAssetBundle(root,directory,{parameters:invocation.parameters,inputs:{assets:[source,excessive,source]}}),/budget/);
  const changed=(await storeAssetObject(root,{bytes:triangle(3),kind:"mesh",mediaType:"model/gltf-binary"})).asset;
  const controller=new AbortController();
  await assert.rejects(exportAssetBundle(root,directory,{parameters:invocation.parameters,inputs:{assets:[changed,image,changed]}},
    {signal:controller.signal,onArtifact:artifact=>{if(artifact.status==="changed") controller.abort();}}),/abort/i);
  assert.deepEqual(await readFile(path.join(directory,"manifest.json")),await resolveAssetObject(root,first.manifest));
  await verifyAssetBundle(directory,first.manifest);
  const resumed=await exportAssetBundle(root,directory,{parameters:invocation.parameters,inputs:{assets:[changed,image,changed]}});
  assert.equal(resumed.blobsWritten,0);assert.equal(resumed.blobsReused,2);assert.equal(resumed.manifestStatus,"changed");
  const accepted=await snapshot(directory),storePath=path.join(root,...assetObjectPortablePath(changed).split("/"));
  await writeFile(storePath,Buffer.alloc(changed.byteLength));
  await assert.rejects(exportAssetBundle(root,directory,{parameters:invocation.parameters,inputs:{assets:[changed,image,changed]}}),/hash/);
  assert.deepEqual(await snapshot(directory),accepted);
  await rm(storePath);await assert.rejects(exportAssetBundle(root,directory,{parameters:invocation.parameters,inputs:{assets:[changed,image,changed]}}),/missing/);
  assert.deepEqual(await snapshot(directory),accepted);
  const decoded=parseAssetBundleManifest(await readFile(path.join(directory,"manifest.json")));
  assert.throws(()=>parseAssetBundleManifest(Buffer.from(canonicalJson({...decoded,assets:decoded.assets.map((e,index)=>index===0?{...e,path:"../escape.png"}:e)}))),/path/);
  assert.throws(()=>parseAssetBundleManifest(Buffer.from(canonicalJson({...decoded,assets:[...decoded.assets].reverse()}))),/ordering/);
});

test("export and verification reject symlinked resources instead of crossing the declared directory",async t=>{
  if(process.platform==="win32") {t.skip("Windows symlink privilege is not a deterministic prerequisite");return;}
  const {root,directory,invocation}=await workspace(t);const first=await exportAssetBundle(root,directory,invocation);
  const manifest=parseAssetBundleManifest(await readFile(path.join(directory,"manifest.json"))),entry=manifest.assets[0]!,file=path.join(directory,entry.path);
  const outside=path.join(root,"outside.png");await writeFile(outside,await readFile(file));await rm(file);await symlink(outside,file);
  await assert.rejects(verifyAssetBundle(directory,first.manifest),/regular/);
  await assert.rejects(exportAssetBundle(root,directory,invocation),/regular/);
});

test("static bundle rejects sparse decoded-memory and vertex budgets before densification",async t=>{
  const {root,directory,source,image,invocation}=await workspace(t);
  await exportAssetBundle(root,directory,invocation);const before=await snapshot(directory);
  for(const count of [1000000000,1000001]) {
    // Two sparse vertices use 36 payload bytes regardless of its declared dense count.
    const binary=Buffer.alloc(36);binary[0]=1;binary[1]=2;
    [1,0,0,0,1,0].forEach((n,i)=>binary.writeFloatLE(n,4+i*4));
    [0,1,2].forEach((n,i)=>binary.writeUInt16LE(n,28+i*2));
    const json=Buffer.from(JSON.stringify({asset:{version:"2.0"},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],
      meshes:[{primitives:[{attributes:{POSITION:0},indices:1}]}],buffers:[{byteLength:36}],
      bufferViews:[{buffer:0,byteOffset:0,byteLength:2},{buffer:0,byteOffset:4,byteLength:24},{buffer:0,byteOffset:28,byteLength:6}],
      accessors:[{componentType:5126,count,type:"VEC3",min:[0,0,0],max:[1,1,0],
        sparse:{count:2,indices:{bufferView:0,componentType:5121},values:{bufferView:1}}},
        {bufferView:2,componentType:5123,count:3,type:"SCALAR"}]}));
    const bytes=glb(json,binary),large=(await storeAssetObject(root,{bytes,kind:"mesh",mediaType:"model/gltf-binary"})).asset;
    assert.ok(bytes.length<1024);
    await assert.rejects(exportAssetBundle(root,directory,{parameters:invocation.parameters,inputs:{assets:[large,image,source]}}),/(?:accessor|vertex).*budget/);
    assert.deepEqual(await snapshot(directory),before);
  }
  // Independently assemble a package so verification exercises the same preflight.
  const binary=Buffer.alloc(16),json=Buffer.from(JSON.stringify({asset:{version:"2.0"},
    accessors:[{componentType:5126,count:2100000,type:"MAT4",sparse:{count:1,indices:{bufferView:0,componentType:5121},values:{bufferView:1}}}],
    buffers:[{byteLength:16}],bufferViews:[{buffer:0,byteOffset:0,byteLength:1},{buffer:0,byteOffset:4,byteLength:12}]}));
  const bytes=glb(json,binary),large=createAssetRef({sha256:sha256Bytes(bytes),byteLength:bytes.length,kind:"mesh",mediaType:"model/gltf-binary"});
  const portable=`assets/${large.sha256}.glb`,manifest=Buffer.from(canonicalJson({schemaVersion:1,profile:STATIC_ASSET_BUNDLE_PROFILE,assets:[{key:"large",variant:"default",source:large,path:portable}]}));
  await writeFile(path.join(directory,portable),bytes);await writeFile(path.join(directory,"manifest.json"),manifest);
  const pinned=createAssetRef({sha256:sha256Bytes(manifest),byteLength:manifest.length,kind:"asset-bundle",mediaType:ASSET_BUNDLE_MEDIA_TYPE}),accepted=await snapshot(directory);
  await assert.rejects(verifyAssetBundle(directory,pinned),/64 MiB decoded memory budget/);
  assert.deepEqual(await snapshot(directory),accepted);
});
