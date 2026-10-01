import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {storeAssetObject,resolveAssetObject} from "../src/asset-store.js";
import {createAssetRef} from "../src/operations.js";
import {encodeInstanceSet,parseInstanceSet,INSTANCE_SET_MEDIA_TYPE} from "../src/instance-set.js";
import {encodeRgba8Image,RGBA8_IMAGE_MEDIA_TYPE} from "../src/image-rgba8.js";
import {executeInstanceExclusionMaskOperation} from "../src/instance-mask-operations.js";
import {readdir,stat,readFile,writeFile} from "node:fs/promises";
import {assetObjectPortablePath} from "../src/asset-store.js";
import {createInstanceSet,type InstanceSetInstance} from "../src/instance-set.js";
import {INSTANCE_EXCLUSION_MASK_OPERATION,createInstanceExclusionMaskOperationBuildIdentity} from "../src/instance-mask-operations.js";

test("saved exclusion masks keep original candidate IDs, positions and order",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"instance-mask-"));
 try {
  const source=(await storeAssetObject(root,{kind:"instance-set",mediaType:INSTANCE_SET_MEDIA_TYPE,bytes:encodeInstanceSet({schemaVersion:1,coordinateSystem:"right-handed-y-up",coordinateQuantization:"1e-6-unit",bounds:{widthMicro:7,depthMicro:5},instances:[
   {id:"west",positionMicro:[-3,8,-2]},{id:"middle",positionMicro:[0,9,0]},{id:"east",positionMicro:[3,-10,2]},
  ]})})).asset;
  const mask=(await storeAssetObject(root,{kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,bytes:encodeRgba8Image({width:3,height:1,pixels:Buffer.from([0,255,0].flatMap(v=>[v,v,v,255]))})})).asset;
  const result=await executeInstanceExclusionMaskOperation(root,{inputs:{source,mask},parameters:{maxCoverage:127,maskBounds:{widthMicro:7,depthMicro:5}}});
  const output=parseInstanceSet(await resolveAssetObject(root,createAssetRef(result.outputs.output)));
  assert.deepEqual(output.instances,[{id:"west",positionMicro:[-3,8,-2]},{id:"east",positionMicro:[3,-10,2]}]);
 } finally {await rm(root,{recursive:true,force:true});}
});


async function workspace(run:(root:string)=>Promise<void>) {
 const root=await mkdtemp(path.join(tmpdir(),"instance-mask-check-"));
 try {await run(root);} finally {await rm(root,{recursive:true,force:true});}
}
async function sourceSet(root:string,bounds:{widthMicro:number;depthMicro:number},instances:InstanceSetInstance[]) {
 return (await storeAssetObject(root,{kind:"instance-set",mediaType:INSTANCE_SET_MEDIA_TYPE,bytes:encodeInstanceSet({schemaVersion:1,coordinateSystem:"right-handed-y-up",coordinateQuantization:"1e-6-unit",bounds,instances})})).asset;
}
async function sourceMask(root:string,width:number,height:number,values:number[]) {
 return (await storeAssetObject(root,{kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,bytes:encodeRgba8Image({width,height,pixels:Buffer.from(values.flatMap(v=>[v,v,v,255]))}),metadata:{field:"exclusion",sampling:"data",channelColorSpace:"linear"}})).asset;
}
async function inventory(root:string) {
 const files=(await readdir(root,{recursive:true,withFileTypes:true})).filter(e=>e.isFile());
 return Promise.all(files.map(async e=>{const p=path.join(e.parentPath,e.name),s=await stat(p);return [path.relative(root,p),s.size,s.mtimeMs] as const;})).then(v=>v.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0));
}
async function outputSet(root:string,result:Awaited<ReturnType<typeof executeInstanceExclusionMaskOperation>>) {
 return parseInstanceSet(await resolveAssetObject(root,createAssetRef(result.outputs.output)));
}

test("non-square nearest endpoint exclusion agrees with an independent exhaustive micro-grid",()=>workspace(async root=>{
 const bounds={widthMicro:7,depthMicro:5},instances:InstanceSetInstance[]=[];
 for(let z=-2;z<=2;z++) for(let x=-3;x<=3;x++) instances.push({id:`cell.${x}.${z}`,positionMicro:[x,x-z,z]});
 const source=await sourceSet(root,bounds,instances),values=[0,127,128,255,64,192],mask=await sourceMask(root,3,2,values);
 const invocation={inputs:{source,mask},parameters:{maxCoverage:127,maskBounds:bounds}};
 const result=await executeInstanceExclusionMaskOperation(root,invocation),actual=await outputSet(root,result);
 // Independent rational reference covers negative endpoints, odd spans and midpoint ties.
 const expected=instances.filter(({positionMicro:[x,,z]})=>values[Math.floor(((z+2)+2)/4)*3+Math.floor(((x+3)*2+3)/6)]!<=127);
 assert.deepEqual(actual.instances,expected);
 assert.deepEqual(actual.bounds,bounds);
 assert.equal(result.observations.positionsChanged,0);assert.equal(result.observations.candidatesGenerated,0);
 assert.deepEqual(result.observations.maskBounds,{...bounds,minX:-3,maxX:3,minZ:-2,maxZ:2});
 const increased=await outputSet(root,await executeInstanceExclusionMaskOperation(root,{...invocation,parameters:{maxCoverage:128,maskBounds:bounds}}));
 assert.ok(increased.instances.length>actual.instances.length);
 for(const kept of actual.instances) assert.deepEqual(increased.instances.find(i=>i.id===kept.id),kept);
 assert.notDeepEqual(await createInstanceExclusionMaskOperationBuildIdentity(root,invocation),await createInstanceExclusionMaskOperationBuildIdentity(root,{...invocation,parameters:{maxCoverage:128,maskBounds:bounds}}));
}));

test("zero/full masks, empty sets and degenerate sample axes have exact subset semantics",()=>workspace(async root=>{
 const bounds={widthMicro:1,depthMicro:1},instances:InstanceSetInstance[]=[{id:"fixed",positionMicro:[0,-33,0]}],source=await sourceSet(root,bounds,instances);
 for(const [values,maxCoverage,kept] of [[[0,255],0,true],[[255,0],254,false],[[255,255],255,true]] as const) {
  const mask=await sourceMask(root,2,1,[...values]);
  const result=await executeInstanceExclusionMaskOperation(root,{inputs:{source,mask},parameters:{maxCoverage,maskBounds:bounds}}),actual=await outputSet(root,result);
  assert.deepEqual(actual.instances,kept?instances:[]);
  if(kept) assert.equal(createAssetRef(result.outputs.output).sha256,source.sha256);
 }
 const empty=await sourceSet(root,bounds,[]),mask=await sourceMask(root,1,1,[0]);
 assert.deepEqual((await outputSet(root,await executeInstanceExclusionMaskOperation(root,{inputs:{source:empty,mask},parameters:{maxCoverage:0,maskBounds:bounds}}))).instances,[]);
 const huge={widthMicro:1_000_000_000_000,depthMicro:1},extreme=await sourceSet(root,huge,[{id:"negative",positionMicro:[-500_000_000_000,0,0]},{id:"positive",positionMicro:[499_999_999_999,0,0]}]);
 const endpoints=await sourceMask(root,2,1,[0,255]);
 assert.deepEqual((await outputSet(root,await executeInstanceExclusionMaskOperation(root,{inputs:{source:extreme,mask:endpoints},parameters:{maxCoverage:0,maskBounds:huge}}))).instances,[{id:"negative",positionMicro:[-500_000_000_000,0,0]}]);
}));

test("localized saved-mask edits retain unrelated detail and replay in a cold store",()=>workspace(async root=>{
 const bounds={widthMicro:7,depthMicro:5},instances:InstanceSetInstance[]=[];
 for(let z=-2;z<=2;z++) for(let x=-3;x<=3;x++) instances.push({id:`saved.${x}.${z}`,positionMicro:[x,7,z]});
 const source=await sourceSet(root,bounds,instances),mask=await sourceMask(root,3,2,[0,255,0,0,255,0]);
 const first=await executeInstanceExclusionMaskOperation(root,{inputs:{source,mask},parameters:{maxCoverage:127,maskBounds:bounds}}),before=await inventory(root);
 assert.deepEqual(await executeInstanceExclusionMaskOperation(root,{inputs:{source,mask},parameters:{maxCoverage:127,maskBounds:bounds}}),first);
 assert.deepEqual(await inventory(root),before);
 const changed=await sourceMask(root,3,2,[255,255,0,0,255,0]);
 const invocation={inputs:{source,mask:changed},parameters:{maxCoverage:127,maskBounds:bounds}},second=await executeInstanceExclusionMaskOperation(root,invocation);
 const actual=await outputSet(root,second),old=await outputSet(root,first);
 assert.deepEqual(actual.instances,old.instances.filter(i=>!(i.positionMicro[0]<=-2 && i.positionMicro[2]<0)));
 for(const kept of actual.instances) assert.deepEqual(instances.find(i=>i.id===kept.id),kept);
 await workspace(async cold=>{
  for(const ref of [source,changed]) await storeAssetObject(cold,{kind:ref.kind,mediaType:ref.mediaType,metadata:ref.metadata,bytes:await resolveAssetObject(root,ref)});
  assert.deepEqual(await executeInstanceExclusionMaskOperation(cold,invocation),second);
 });
 assert.deepEqual(await executeInstanceExclusionMaskOperation(root,{inputs:{source,mask},parameters:{maxCoverage:127,maskBounds:bounds}}),first);
 assert.equal(createAssetRef(second.outputs.output).metadata.sourceInstanceSetSha256,source.sha256);
 assert.equal(createAssetRef(second.outputs.output).metadata.sourceMaskSha256,changed.sha256);
}));

test("invalid calibration, channels, references and budgets fail before derived writes",()=>workspace(async root=>{
 const bounds={widthMicro:7,depthMicro:5},source=await sourceSet(root,bounds,[{id:"one",positionMicro:[0,1,0]}]),mask=await sourceMask(root,1,1,[0]);
 const invocation={inputs:{source,mask},parameters:{maxCoverage:127,maskBounds:bounds}},before=await inventory(root);
 for(const p of [{maxCoverage:-1,maskBounds:bounds},{maxCoverage:256,maskBounds:bounds},{maxCoverage:NaN,maskBounds:bounds},{maxCoverage:1.5,maskBounds:bounds},
  {maxCoverage:0,maskBounds:{...bounds,widthMicro:0}},{maxCoverage:0,maskBounds:{...bounds,widthMicro:8}},
  {maxCoverage:0,maskBounds:{...bounds,originX:0}},{maxCoverage:0,maskBounds:bounds,sampling:"bilinear"}]) {
  await assert.rejects(executeInstanceExclusionMaskOperation(root,{...invocation,parameters:p}));assert.deepEqual(await inventory(root),before);
 }
 for(const ref of [createAssetRef({...mask,sha256:"0".repeat(64)}),createAssetRef({...mask,byteLength:8*1024*1024+1})]) {
  await assert.rejects(executeInstanceExclusionMaskOperation(root,{...invocation,inputs:{source,mask:ref}}));assert.deepEqual(await inventory(root),before);
 }
 await assert.rejects(executeInstanceExclusionMaskOperation(root,{...invocation,inputs:{source:createAssetRef({...source,byteLength:2*1024*1024+1}),mask}}),/budgets/);
 for(const pixels of [[0,1,0,255],[0,0,0,254]]) {
  const invalid=(await storeAssetObject(root,{kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,bytes:encodeRgba8Image({width:1,height:1,pixels:Buffer.from(pixels)})})).asset,inventoryBefore=await inventory(root);
  await assert.rejects(executeInstanceExclusionMaskOperation(root,{...invocation,inputs:{source,mask:invalid}}),/opaque grayscale/);assert.deepEqual(await inventory(root),inventoryBefore);
 }
 const oversized=await sourceMask(root,4097,1,Array(4097).fill(0)),oversizedBefore=await inventory(root);
 await assert.rejects(executeInstanceExclusionMaskOperation(root,{...invocation,inputs:{source,mask:oversized}}),/budget/);assert.deepEqual(await inventory(root),oversizedBefore);
 const tooManyPixels=await sourceMask(root,1025,1024,Array(1025*1024).fill(0)),pixelBudgetBefore=await inventory(root);
 await assert.rejects(executeInstanceExclusionMaskOperation(root,{...invocation,inputs:{source,mask:tooManyPixels}}),/pixel budget/);assert.deepEqual(await inventory(root),pixelBudgetBefore);
 await assert.rejects(executeInstanceExclusionMaskOperation("relative",invocation),/absolute/);
 const filename=path.join(root,assetObjectPortablePath(mask)),original=await readFile(filename);await writeFile(filename,"tampered");
 const corrupted=await inventory(root);await assert.rejects(executeInstanceExclusionMaskOperation(root,invocation),/byte|sha256|hash/i);assert.deepEqual(await inventory(root),corrupted);await writeFile(filename,original);
 assert.equal(Reflect.set(INSTANCE_EXCLUSION_MASK_OPERATION,"version","99"),false);
 assert.equal(Reflect.set(INSTANCE_EXCLUSION_MASK_OPERATION.parameterSchema,"additionalProperties",true),false);
 assert.deepEqual(createInstanceSet(await outputSet(root,await executeInstanceExclusionMaskOperation(root,invocation))).instances,[{id:"one",positionMicro:[0,1,0]}]);
}));
