import {test,type TestContext} from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {tmpdir} from "node:os";
import {mkdtemp,readFile,rm,stat,writeFile} from "node:fs/promises";
import {storeAssetObject,assetObjectPortablePath} from "../src/asset-store.js";
import {canonicalJson} from "../src/canonical.js";
import {encodeRgba8Image,RGBA8_IMAGE_MEDIA_TYPE} from "../src/image-rgba8.js";
import {SPRITE_ATLAS_MEDIA_TYPE} from "../src/sprite-atlas-operations.js";
import {createAssetRef} from "../src/operations.js";
import {sha256Bytes} from "../src/hash.js";
import {exportAssetBundle,verifyAssetBundle,readAssetBundleAsset,readAssetBundleSpriteAtlas,parseSpriteAtlasBundleManifest,parseAssetBundleManifest,
 createAssetBundleBuildIdentity,executeAssetBundleOperation,SPRITE_ATLAS_BUNDLE_OPERATION,SPRITE_ATLAS_BUNDLE_PROFILE,ASSET_BUNDLE_MEDIA_TYPE} from "../src/asset-bundle.js";

// Independent original atlas with a sparse producer frame and a pinned white pixel PNG.
const white=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=","base64");
async function fixture(t:TestContext) {
 const root=await mkdtemp(path.join(tmpdir(),"atlas-bundle-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const image=(await storeAssetObject(root,{kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,bytes:encodeRgba8Image({width:1,height:1,pixels:Buffer.from([255,255,255,255])}),metadata:{license:"CC0-1.0",producer:"independent-pixel"}})).asset;
 const document={schemaVersion:1,image,width:1,height:1,coordinates:"top-left-pixels",colorSpace:"srgb",alphaMode:"straight",padding:0,extrusion:0,
  sprites:[{id:"white",pivot:{x:.5,y:.5},frame:{sequence:"sparse",index:7,timeMs:90,durationMs:20,loop:false},source:image,sourceSize:{width:1,height:1},rect:{x:0,y:0,width:1,height:1},trimOffset:{x:0,y:0},empty:false,rotated:false}]};
 const atlas=(await storeAssetObject(root,{kind:"sprite-atlas",mediaType:SPRITE_ATLAS_MEDIA_TYPE,bytes:Buffer.from(canonicalJson(document)+"\n"),metadata:{producer:"independent-atlas",license:"CC0-1.0"}})).asset;
 const png=(await storeAssetObject(root,{kind:"image",mediaType:"image/png",bytes:white,metadata:{sourceSha256:image.sha256,width:1,height:1,codec:"png",sourceColorSpace:"srgb"}})).asset;
 const invocation={parameters:{profile:"sprite-atlas-png-v1",assets:[{key:"effect",variant:"default"}]},inputs:{assets:[atlas],images:[png]}};
 return {root,directory:path.join(root,"export"),cold:path.join(root,"cold"),image,atlas,png,document,invocation};
}
test("atlas package carries original metadata and complete pinned resources without its source store",async t=>{
 const {root,directory,cold,atlas,invocation}=await fixture(t),first=await exportAssetBundle(root,directory,invocation);
 assert.equal(first.assetsVerified,1);assert.equal(first.blobsWritten,3);
 await assert.rejects(verifyAssetBundle(directory,first.manifest),/selected verification profile/);
 const manifestBytes=await readFile(path.join(directory,"manifest.json"));
 assert.throws(()=>parseAssetBundleManifest(manifestBytes),/bundle manifest requires exactly/);
 const checked=await verifyAssetBundle(directory,first.manifest,{profile:SPRITE_ATLAS_BUNDLE_PROFILE});
 assert.equal(checked.manifest.schemaVersion,2);assert.deepEqual(checked.manifest.assets[0]!.source,atlas);
 assert.equal((await createAssetBundleBuildIdentity(root,invocation)).operation.version,"2");
 assert.deepEqual(createAssetRef((await executeAssetBundleOperation(root,invocation)).outputs.manifest),first.manifest);
 assert.ok(Object.isFrozen(SPRITE_ATLAS_BUNDLE_OPERATION.parameterSchema));
 const before=await stat(path.join(directory,"manifest.json"));assert.equal((await exportAssetBundle(root,directory,invocation)).bytesWritten,0);
 assert.equal((await stat(path.join(directory,"manifest.json"))).mtimeMs,before.mtimeMs);
 assert.equal((await exportAssetBundle(root,cold,invocation)).manifest.sha256,first.manifest.sha256);
 await rm(path.join(root,".asset-tooling"),{recursive:true,force:true});
 const original=JSON.parse((await readAssetBundleAsset(directory,checked.manifest,"effect","default")).toString("utf8"));
 assert.equal(original.sprites[0].frame.index,7);assert.equal(original.sprites[0].frame.timeMs,90);
 assert.equal(checked.manifest.schemaVersion,2);if(checked.manifest.schemaVersion!==2) throw new Error("fixture needs atlas profile");
 const loaded=await readAssetBundleSpriteAtlas(directory,checked.manifest,"effect","default");
 assert.deepEqual(loaded.atlas,original);assert.deepEqual(loaded.png,white);
 assert.deepEqual(await verifyAssetBundle(directory,first.manifest,{profile:SPRITE_ATLAS_BUNDLE_PROFILE}),checked);
 await assert.rejects(stat(path.join(root,".asset-tooling")),{code:"ENOENT"});
});

test("atlas edits and interrupted export retain accepted packages and reuse completed dependencies",async t=>{
 const {root,directory,cold,png,atlas,document,invocation}=await fixture(t),first=await exportAssetBundle(root,directory,invocation);
 const checked=await verifyAssetBundle(directory,first.manifest,{profile:SPRITE_ATLAS_BUNDLE_PROFILE}),before=await readFile(path.join(directory,"manifest.json"));
 const changed={...document,sprites:document.sprites.map(s=>({...s,frame:{...s.frame,timeMs:120}}))};
 const edited=(await storeAssetObject(root,{kind:atlas.kind,mediaType:atlas.mediaType,metadata:atlas.metadata,bytes:Buffer.from(canonicalJson(changed)+"\n")})).asset;
 const invocation2={...invocation,inputs:{assets:[edited],images:[png]}},controller=new AbortController();
 await assert.rejects(exportAssetBundle(root,directory,invocation2,{signal:controller.signal,onArtifact:e=>{if(e.status==="changed") controller.abort();}}),/abort/i);
 assert.deepEqual(await readFile(path.join(directory,"manifest.json")),before);await verifyAssetBundle(directory,first.manifest,{profile:SPRITE_ATLAS_BUNDLE_PROFILE});
 const resumed=await exportAssetBundle(root,directory,invocation2);assert.equal(resumed.blobsWritten,0);assert.equal(resumed.blobsReused,3);
 assert.equal((await exportAssetBundle(root,cold,invocation2)).manifest.sha256,resumed.manifest.sha256);
 assert.equal((await verifyAssetBundle(directory,resumed.manifest,{profile:SPRITE_ATLAS_BUNDLE_PROFILE})).uniquePayloads,3);
 // Old readers retain the original atlas and image after publication.
 assert.deepEqual(JSON.parse((await readAssetBundleAsset(directory,checked.manifest,"effect","default")).toString()),document);
 const current=(await verifyAssetBundle(directory,resumed.manifest,{profile:SPRITE_ATLAS_BUNDLE_PROFILE})).manifest;
 if(current.schemaVersion!==2) throw new Error("fixture needs atlas profile");
 const imageFile=path.join(directory,current.assets[0]!.image.path),mtime=(await stat(path.join(directory,"manifest.json"))).mtimeMs;
 await writeFile(imageFile,Buffer.alloc(png.byteLength));await assert.rejects(verifyAssetBundle(directory,resumed.manifest,{profile:SPRITE_ATLAS_BUNDLE_PROFILE}),/hash/);
 const repaired=await exportAssetBundle(root,directory,invocation2);assert.equal(repaired.blobsWritten,1);assert.equal(repaired.manifestStatus,"unchanged");
 assert.equal((await stat(path.join(directory,"manifest.json"))).mtimeMs,mtime);
});

test("invalid atlas/PNG relationships, bounds and resource closure fail without replacing accepted output",async t=>{
 const {root,directory,png,document,invocation}=await fixture(t),accepted=await exportAssetBundle(root,directory,invocation),previous=await readFile(path.join(directory,"manifest.json"));
 const badPng=createAssetRef({...png,metadata:{...png.metadata,sourceSha256:"0".repeat(64)}});
 await assert.rejects(exportAssetBundle(root,directory,{...invocation,inputs:{assets:invocation.inputs.assets,images:[badPng]}}),/original image pin/);
 const sprite=document.sprites[0]!;
 const mutants=[{...document,coordinates:"bottom-left"}, {...document,sprites:[{...sprite,rotated:true}]},
  {...document,sprites:[{...sprite,rect:{...sprite.rect,x:1}}]}, {...document,sprites:[{...sprite,pivot:{x:2,y:0}}]},
  {...document,sprites:[sprite,{...sprite,id:"z"}]}, {...document,sprites:[{...sprite,sourceSize:{width:2,height:1}}]},
  {...document,sprites:[{...sprite,frame:{...sprite.frame,durationMs:0}}]}];
 for(const mutant of mutants) {
  const source=(await storeAssetObject(root,{kind:"sprite-atlas",mediaType:SPRITE_ATLAS_MEDIA_TYPE,bytes:Buffer.from(canonicalJson(mutant)+"\n")})).asset;
  await assert.rejects(exportAssetBundle(root,directory,{...invocation,inputs:{assets:[source],images:[png]}}));
  assert.deepEqual(await readFile(path.join(directory,"manifest.json")),previous);
 }
 const manifest=parseSpriteAtlasBundleManifest(previous);if(manifest.schemaVersion!==2) throw new Error("fixture needs atlas profile");
 // Independent forged transport cannot omit a pinned resource, even if its file remains beside the package.
 const forged={...manifest,resources:[]};assert.throws(()=>parseSpriteAtlasBundleManifest(Buffer.from(canonicalJson(forged))),/resources/);
 const unrelated=(await storeAssetObject(root,{kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,bytes:encodeRgba8Image({width:1,height:1,pixels:Buffer.from([0,0,0,255])})})).asset;
 const missing={...manifest,resources:[{source:unrelated,path:`assets/${unrelated.sha256}.rgba.json`}]};
 const bytes=Buffer.from(canonicalJson(missing)+"\n");await writeFile(path.join(directory,"manifest.json"),bytes);
 // Reuse a valid existing byte payload at its own pin, so rejection must concern closure membership.
 await writeFile(path.join(directory,missing.resources[0]!.path),encodeRgba8Image({width:1,height:1,pixels:Buffer.from([0,0,0,255])}));
 const pin=createAssetRef({kind:"asset-bundle",mediaType:ASSET_BUNDLE_MEDIA_TYPE,sha256:sha256Bytes(bytes),byteLength:bytes.length});
 await assert.rejects(verifyAssetBundle(directory,pin,{profile:SPRITE_ATLAS_BUNDLE_PROFILE}),/closure/);
 await writeFile(path.join(directory,"manifest.json"),previous);await verifyAssetBundle(directory,accepted.manifest,{profile:SPRITE_ATLAS_BUNDLE_PROFILE});
});

test("atlas dependency corruption fails before reuse and leaves accepted package intact",async t=>{
 const {root,directory,image,invocation}=await fixture(t),accepted=await exportAssetBundle(root,directory,invocation);
 const previous=await readFile(path.join(directory,"manifest.json"));
 await writeFile(path.join(root,...assetObjectPortablePath(image).split("/")),Buffer.alloc(image.byteLength));
 await assert.rejects(exportAssetBundle(root,directory,invocation),/hash/);
 assert.deepEqual(await readFile(path.join(directory,"manifest.json")),previous);
 await verifyAssetBundle(directory,accepted.manifest,{profile:SPRITE_ATLAS_BUNDLE_PROFILE});
});

test("non-square trimmed and empty sparse frames retain original pivots through paired order changes",async t=>{
 const {root,directory,cold}=await fixture(t);
 const bytes=Buffer.alloc(3*2*4);bytes.set([255,255,255,255],(1*3+1)*4);
 const source=(await storeAssetObject(root,{kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,bytes:encodeRgba8Image({width:3,height:2,pixels:bytes})})).asset;
 const empty=(await storeAssetObject(root,{kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,bytes:encodeRgba8Image({width:2,height:3,pixels:Buffer.alloc(24)})})).asset;
 const pixels=Buffer.alloc(6*3*4);pixels.set([255,255,255,255],(1*6+1)*4);
 const image=(await storeAssetObject(root,{kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,bytes:encodeRgba8Image({width:6,height:3,pixels})})).asset;
 const document={schemaVersion:1,image,width:6,height:3,coordinates:"top-left-pixels",colorSpace:"srgb",alphaMode:"straight",padding:1,extrusion:0,sprites:[
  {id:"a",source,sourceSize:{width:3,height:2},pivot:{x:1.5,y:1},rect:{x:1,y:1,width:1,height:1},trimOffset:{x:1,y:1},empty:false,rotated:false,frame:{sequence:"sparse",index:7,timeMs:90,durationMs:20,loop:false}},
  {id:"z",source:empty,sourceSize:{width:2,height:3},pivot:{x:1,y:2.5},rect:{x:4,y:1,width:1,height:1},trimOffset:{x:0,y:0},empty:true,rotated:false,frame:{sequence:"sparse",index:99,timeMs:200,durationMs:10,loop:false}}]};
 const atlas=(await storeAssetObject(root,{kind:"sprite-atlas",mediaType:SPRITE_ATLAS_MEDIA_TYPE,bytes:Buffer.from(canonicalJson(document)+"\n")})).asset;
 // Independently encoded 6x3 transparent PNG with one white pixel at (1,1).
 const png=(await storeAssetObject(root,{kind:"image",mediaType:"image/png",bytes:Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAYAAAADCAYAAACwAX77AAAAFElEQVR4nGNgwAf+////H68CZAAArZ0D/c5UTRUAAAAASUVORK5CYII=","base64"),metadata:{sourceSha256:image.sha256,width:6,height:3,codec:"png",sourceColorSpace:"srgb"}})).asset;
 const invocation={parameters:{profile:"sprite-atlas-png-v1",assets:[{key:"second",variant:"default"},{key:"first",variant:"default"}]},inputs:{assets:[atlas,atlas],images:[png,png]}};
 const reversed={parameters:{...invocation.parameters,assets:[...invocation.parameters.assets].reverse()},inputs:{assets:[...invocation.inputs.assets].reverse(),images:[...invocation.inputs.images].reverse()}};
 assert.deepEqual(await createAssetBundleBuildIdentity(root,invocation),await createAssetBundleBuildIdentity(root,reversed));
 const result=await exportAssetBundle(root,directory,invocation),checked=await verifyAssetBundle(directory,result.manifest,{profile:SPRITE_ATLAS_BUNDLE_PROFILE});
 assert.equal(result.blobsWritten,5);assert.equal((await exportAssetBundle(root,cold,reversed)).manifest.sha256,result.manifest.sha256);
 if(checked.manifest.schemaVersion!==2) throw new Error("fixture needs atlas profile");
 assert.deepEqual((await readAssetBundleSpriteAtlas(directory,checked.manifest,"first","default")).atlas,document);
 assert.deepEqual(checked.manifest.assets.map(e=>e.key),["first","second"]);
});

test("atlas encoded/dimension budgets and missing sources fail before export publication",async t=>{
 const {root,directory,atlas,png,image,document,invocation}=await fixture(t),accepted=await exportAssetBundle(root,directory,invocation),previous=await readFile(path.join(directory,"manifest.json"));
 const oversized=createAssetRef({...atlas,byteLength:8*1024*1024+1});
 await assert.rejects(exportAssetBundle(root,directory,{...invocation,inputs:{assets:[oversized],images:[png]}}),/8 MiB/);
 // Tiny encoded fixture declares enormous decoded dimensions; reject before base64 decoding/allocation.
 const bad=(await storeAssetObject(root,{kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,bytes:Buffer.from(canonicalJson({schemaVersion:1,width:4096,height:4096,colorSpace:"srgb",alphaMode:"straight",pixelsBase64:""})+"\n")})).asset;
 const badAtlas=(await storeAssetObject(root,{kind:atlas.kind,mediaType:atlas.mediaType,bytes:Buffer.from(canonicalJson({...document,image:bad,width:4096,height:4096})+"\n")})).asset;
 await assert.rejects(exportAssetBundle(root,directory,{...invocation,inputs:{assets:[badAtlas],images:[png]}}),/decode budget/);
 await rm(path.join(root,...assetObjectPortablePath(image).split("/")));
 await assert.rejects(exportAssetBundle(root,directory,invocation),/missing/);
 assert.deepEqual(await readFile(path.join(directory,"manifest.json")),previous);await verifyAssetBundle(directory,accepted.manifest,{profile:SPRITE_ATLAS_BUNDLE_PROFILE});
});

test("repeated canonical source references obey the same 4096 cap during export and package-only verify",async t=>{
 const {root,directory,image,document,invocation}=await fixture(t),accepted=await exportAssetBundle(root,directory,invocation),previous=await readFile(path.join(directory,"manifest.json"));
 const pixels=Buffer.alloc(512*4,255),wide=(await storeAssetObject(root,{kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,bytes:encodeRgba8Image({width:512,height:1,pixels})})).asset;
 const sprite=document.sprites[0]!,large={...document,image:wide,width:512,sprites:Array.from({length:512},(_,i)=>({
  ...sprite,id:`sprite.${String(i).padStart(4,"0")}`,frame:{sequence:`pose.${i}`,index:0,timeMs:0,durationMs:1,loop:false},rect:{x:i,y:0,width:1,height:1}}))};
 const atlasBytes=Buffer.from(canonicalJson(large)+"\n"),atlas=(await storeAssetObject(root,{kind:"sprite-atlas",mediaType:SPRITE_ATLAS_MEDIA_TYPE,bytes:atlasBytes})).asset;
 const pngBytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAgAAAAABCAYAAACouxZ2AAAAGklEQVR4nO3BAQEAAAiAoPo/2oYEbNUAAK8c69kD/lrnIlcAAAAASUVORK5CYII=","base64"),png=(await storeAssetObject(root,{kind:"image",mediaType:"image/png",bytes:pngBytes,metadata:{sourceSha256:wide.sha256,width:512,height:1,codec:"png",sourceColorSpace:"srgb"}})).asset;
 const assets=Array.from({length:8},(_,i)=>({key:`copy.${i}`,variant:"default"}));
 await assert.rejects(exportAssetBundle(root,directory,{parameters:{profile:"sprite-atlas-png-v1",assets},inputs:{assets:assets.map(()=>atlas),images:assets.map(()=>png)}}),/4096/);
 assert.deepEqual(await readFile(path.join(directory,"manifest.json")),previous);await verifyAssetBundle(directory,accepted.manifest,{profile:SPRITE_ATLAS_BUNDLE_PROFILE});
 const resources=[image,wide].map(source=>({source,path:`assets/${source.sha256}.rgba.json`})).sort((a,b)=>a.path<b.path?-1:1);
 const manifest={schemaVersion:2,profile:"sprite-atlas-png-v1",assets:assets.map(e=>({...e,source:atlas,path:`assets/${atlas.sha256}.atlas.json`,image:{source:png,path:`assets/${png.sha256}.png`}})),resources};
 for(const [relative,bytes] of [[`assets/${wide.sha256}.rgba.json`,encodeRgba8Image({width:512,height:1,pixels})],[`assets/${atlas.sha256}.atlas.json`,atlasBytes],[`assets/${png.sha256}.png`,pngBytes]] as const) await writeFile(path.join(directory,relative),bytes);
 const bytes=Buffer.from(canonicalJson(manifest)+"\n"),ref=createAssetRef({kind:"asset-bundle",mediaType:ASSET_BUNDLE_MEDIA_TYPE,byteLength:bytes.length,sha256:sha256Bytes(bytes)});
 await writeFile(path.join(directory,"manifest.json"),bytes);await assert.rejects(verifyAssetBundle(directory,ref,{profile:SPRITE_ATLAS_BUNDLE_PROFILE}),/4096/);
 assert.deepEqual(await readFile(path.join(directory,"manifest.json")),bytes);
});


test("v2 admission rejects omitted or defaultable required refs without normalizing pinned transport",async t=>{
 const {root,directory,invocation}=await fixture(t),accepted=await exportAssetBundle(root,directory,invocation);
 const original=await readFile(path.join(directory,"manifest.json"));
 const manifest=parseSpriteAtlasBundleManifest(original);
 assert.deepEqual(JSON.parse(original.toString()),manifest);
 for(const location of ["atlas","png","rgba"] as const) for(const field of ["schemaVersion","metadata"] as const) for(const mutation of ["missing","null"] as const) {
  const forged=structuredClone(manifest);
  const ref=location==="atlas"?forged.assets[0]!.source:location==="png"?forged.assets[0]!.image.source:forged.resources[0]!.source;
  if(mutation==="missing") Reflect.deleteProperty(ref,field);else Reflect.set(ref,field,null);
  const bytes=Buffer.from(canonicalJson(forged)+"\n");
  assert.throws(()=>parseSpriteAtlasBundleManifest(bytes),/serialized asset ref/);
  await writeFile(path.join(directory,"manifest.json"),bytes);
  const before=await stat(path.join(directory,"manifest.json"));
  const pin=createAssetRef({kind:"asset-bundle",mediaType:ASSET_BUNDLE_MEDIA_TYPE,byteLength:bytes.length,sha256:sha256Bytes(bytes)});
  await assert.rejects(verifyAssetBundle(directory,pin,{profile:SPRITE_ATLAS_BUNDLE_PROFILE}),/serialized asset ref/);
  assert.deepEqual(await readFile(path.join(directory,"manifest.json")),bytes);
  assert.equal((await stat(path.join(directory,"manifest.json"))).mtimeMs,before.mtimeMs);
 }
 await writeFile(path.join(directory,"manifest.json"),original);
 await verifyAssetBundle(directory,accepted.manifest,{profile:SPRITE_ATLAS_BUNDLE_PROFILE});
 assert.equal((await exportAssetBundle(root,directory,invocation)).bytesWritten,0);
});


test("original atlas image and sprite refs cannot invent omitted provenance fields",async t=>{
 const {root,directory,atlas,png,document,invocation}=await fixture(t),accepted=await exportAssetBundle(root,directory,invocation);
 const previous=await readFile(path.join(directory,"manifest.json")),manifest=parseSpriteAtlasBundleManifest(previous);
 for(const location of ["image","sprite"] as const) for(const field of ["schemaVersion","metadata"] as const) for(const mutation of ["missing","null"] as const) {
  const changed=structuredClone(document),ref=location==="image"?changed.image:changed.sprites[0]!.source;
  if(mutation==="missing") Reflect.deleteProperty(ref,field);else Reflect.set(ref,field,null);
  const bytes=Buffer.from(canonicalJson(changed)+"\n");
  const source=(await storeAssetObject(root,{kind:atlas.kind,mediaType:atlas.mediaType,metadata:atlas.metadata,bytes})).asset;
  await assert.rejects(exportAssetBundle(root,directory,{...invocation,inputs:{assets:[source],images:[png]}}),/serialized asset ref/);
  assert.deepEqual(await readFile(path.join(directory,"manifest.json")),previous);
  const forged={...manifest,assets:manifest.assets.map(e=>({...e,source,path:`assets/${source.sha256}.atlas.json`}))};
  await writeFile(path.join(directory,forged.assets[0]!.path),bytes);
  const transport=Buffer.from(canonicalJson(forged)+"\n"),pin=createAssetRef({kind:"asset-bundle",mediaType:ASSET_BUNDLE_MEDIA_TYPE,byteLength:transport.length,sha256:sha256Bytes(transport)});
  await writeFile(path.join(directory,"manifest.json"),transport);
  const before=await stat(path.join(directory,"manifest.json"));
  await assert.rejects(verifyAssetBundle(directory,pin,{profile:SPRITE_ATLAS_BUNDLE_PROFILE}),/serialized asset ref/);
  assert.deepEqual(await readFile(path.join(directory,"manifest.json")),transport);
  assert.equal((await stat(path.join(directory,"manifest.json"))).mtimeMs,before.mtimeMs);
  await writeFile(path.join(directory,"manifest.json"),previous);
 }
 await verifyAssetBundle(directory,accepted.manifest,{profile:SPRITE_ATLAS_BUNDLE_PROFILE});
});
