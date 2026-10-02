import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {mkdtemp,rm,readdir,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolveAssetObject} from "../src/asset-store.js";
import {createAssetRef} from "../src/operations.js";
import {parseRgba8Image} from "../src/image-rgba8.js";
import {type FeedbackKitVariantManifest as VariantManifest,executeFeedbackKitRecipe,normalizeFeedbackKitRecipe,FEEDBACK_KIT_PRESETS,FEEDBACK_KIT_MEDIA_TYPE} from "../src/feedback-kits.js";

const artwork={shape:"puff",width:11,height:13,centerX:5,centerY:6,radius:2,softness:1,color:[31,129,240],opacity:180} as const;
const visual={schemaVersion:1,sequence:"fixture.puff",loop:false,atlas:{columns:2,padding:1,extrusion:1,trim:false},frames:[
 {index:0,timeMs:0,durationMs:3,artwork:{...artwork,opacity:0}},
 {index:1,timeMs:3,durationMs:7,artwork},
 {index:2,timeMs:10,durationMs:5,artwork:{...artwork,opacity:0}},
]};
const flat={attackMs:0,decayMs:0,sustainLevelQ15:32767,releaseMs:0};
// 12 kHz at 48 kHz is a four-frame triangle period: 0, +A, 0, -A.
const blip={waveform:"triangle",frequencyHz:12000,amplitude:1000,startMs:1,durationMs:1,...flat};
const recipe={schemaVersion:1,kit:"fixture.kit",concurrency:{maxActive:2,overflow:"drop-new"},variants:{
 strong:{visual,visualOnsetMs:0,reducedMotionFrameIndex:1,audioOnsetMs:5,tones:[blip]},
 subtle:{visual,visualOnsetMs:2,reducedMotionFrameIndex:1,audioOnsetMs:5,tones:[{...blip,amplitude:400}]},
}};

/** Independent canonical WAV reader: 44-byte header followed by signed 16-bit little-endian samples. */
function pcm(bytes:Buffer) {
 assert.equal(bytes.toString("ascii",0,4),"RIFF");assert.equal(bytes.toString("ascii",8,12),"WAVE");
 assert.equal(bytes.readUInt16LE(22),1);assert.equal(bytes.readUInt32LE(24),48000);assert.equal(bytes.readUInt16LE(34),16);
 return Array.from({length:(bytes.length-44)/2},(_,i)=>bytes.readInt16LE(44+i*2));
}
async function workspace(run:(root:string)=>Promise<void>) {
 const root=await mkdtemp(path.join(tmpdir(),"feedback-kits-"));
 try {await run(root);} finally {await rm(root,{recursive:true,force:true});}
}
async function inventory(root:string) {
 return Promise.all((await readdir(root,{recursive:true,withFileTypes:true})).filter(e=>e.isFile()).map(async e=>{
  const p=path.join(e.parentPath,e.name),s=await stat(p);return [path.relative(root,p),s.size,s.mtimeMs] as const;
 })).then(v=>v.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0));
}

test("kit pairs authored frames with an exactly timed synthesized cue per intensity",()=>workspace(async root=>{
 const result=await executeFeedbackKitRecipe(root,recipe);
 const manifest=JSON.parse((await resolveAssetObject(root,result.kit)).toString());
 assert.equal(result.kit.mediaType,FEEDBACK_KIT_MEDIA_TYPE);
 assert.deepEqual(manifest,JSON.parse(JSON.stringify(result.manifest)));
 assert.deepEqual(manifest.time,{unit:"ms",origin:"accepted-cosmetic-event"});
 assert.equal(manifest.presentation,"cosmetic-only");
 const strong:VariantManifest=manifest.variants.strong,subtle:VariantManifest=manifest.variants.subtle;
 const expected=(a:number)=>[...Array(48).fill(0),...Array.from({length:48},(_,i)=>[0,a,0,-a][i%4]!)];
 assert.deepEqual(pcm(await resolveAssetObject(root,strong.audio.cue)),expected(1000));
 assert.deepEqual(pcm(await resolveAssetObject(root,subtle.audio.cue)),expected(400));
 assert.deepEqual([strong.audio.onsetMs,strong.audio.durationMs,strong.audio.frameCount],[5,2,96]);
 assert.deepEqual([strong.visual.onsetMs,strong.visual.durationMs,strong.endMs],[0,15,15]);
 assert.deepEqual([subtle.visual.onsetMs,subtle.endMs],[2,17]);
 assert.equal(strong.audio.clipping,"amplitude-sum-headroom");
 const still=parseRgba8Image(await resolveAssetObject(root,strong.visual.reducedMotion.image));
 assert.deepEqual([...still.pixels.subarray((6*11+5)*4,(6*11+5)*4+4)],[31,129,240,180]);
 assert.equal(strong.visual.reducedMotion.frameId,"fixture.puff.frame.001");
 // Identical visual recipes resolve to the same content-addressed visual objects across intensities.
 assert.deepEqual(subtle.visual.atlas,strong.visual.atlas);
}));

test("two tones mix at their declared offsets without saturation",()=>workspace(async root=>{
 const tones=[blip,{...blip,startMs:0,durationMs:2,amplitude:2000}];
 const two={...recipe,variants:{...recipe.variants,strong:{...recipe.variants.strong,tones}}};
 const result=await executeFeedbackKitRecipe(root,two);
 const samples=pcm(await resolveAssetObject(root,result.manifest.variants.strong.audio.cue));
 const a=(amp:number,i:number)=>[0,amp,0,-amp][i%4]!;
 assert.deepEqual(samples,Array.from({length:96},(_,i)=>a(2000,i)+(i>=48?a(1000,i-48):0)));
}));

test("every intensity, tone and budget validates before any object is written",()=>workspace(async root=>{
 const s=recipe.variants.strong;
 const strong=(patch:object)=>({...recipe,variants:{...recipe.variants,strong:{...s,...patch}}});
 const invalid=[
  {...recipe,schemaVersion:2},{...recipe,kit:"Unsafe/Kit"},{...recipe,extra:true},
  {...recipe,concurrency:{maxActive:0,overflow:"drop-new"}},{...recipe,concurrency:{maxActive:2,overflow:"queue"}},
  {...recipe,variants:{strong:s}},{...recipe,variants:{...recipe.variants,off:s}},
  strong({reducedMotionFrameIndex:0}),strong({reducedMotionFrameIndex:3}),strong({tones:[]}),
  strong({tones:Array(5).fill(blip)}),strong({tones:[{...blip,amplitude:20000},{...blip,amplitude:12768}]}),
  strong({tones:[{...blip,attackMs:1,releaseMs:1}]}),strong({tones:[{...blip,startMs:1999,durationMs:2}]}),
  strong({tones:[{...blip,waveform:"saw"}]}),strong({tones:[{...blip,frequencyHz:24001}]}),strong({tones:[{...blip,script:"play()"}]}),
  strong({audioOnsetMs:1001}),strong({visualOnsetMs:-1}),strong({visual:{...visual,loop:true}}),
  strong({visual:{...visual,frames:[...visual.frames.slice(0,2),{...visual.frames[2],durationMs:2991}]}}),
 ];
 for(const value of invalid) {
  assert.throws(()=>normalizeFeedbackKitRecipe(value));
  await assert.rejects(executeFeedbackKitRecipe(root,value));
  await assert.rejects(stat(path.join(root,".asset-tooling")),{code:"ENOENT"});
 }
 await assert.rejects(executeFeedbackKitRecipe("relative",recipe),/absolute/);
}));

test("replay is idempotent and an intensity-only edit leaves the sibling intensity untouched",{timeout:60000},()=>workspace(async root=>{
 const first=await executeFeedbackKitRecipe(root,recipe),before=await inventory(root);
 assert.deepEqual(await executeFeedbackKitRecipe(root,recipe),first);assert.deepEqual(await inventory(root),before);
 await workspace(async cold=>{assert.deepEqual(await executeFeedbackKitRecipe(cold,recipe),first);});
 const edited=await executeFeedbackKitRecipe(root,{...recipe,variants:{...recipe.variants,subtle:{...recipe.variants.subtle,tones:[{...blip,amplitude:300}]}}});
 assert.deepEqual(edited.manifest.variants.strong,first.manifest.variants.strong);
 assert.notDeepEqual(edited.manifest.variants.subtle,first.manifest.variants.subtle);
 assert.notEqual(edited.kit.sha256,first.kit.sha256);
 assert.deepEqual(await executeFeedbackKitRecipe(root,recipe),first);
}));

test("aborted kits write nothing and accepted objects stay intact",()=>workspace(async root=>{
 const controller=new AbortController();controller.abort(new Error("cancelled"));
 await assert.rejects(executeFeedbackKitRecipe(root,recipe,{signal:controller.signal}),/cancelled/);
 await assert.rejects(stat(path.join(root,".asset-tooling")),{code:"ENOENT"});
 const accepted=await executeFeedbackKitRecipe(root,recipe),bytes=await resolveAssetObject(root,accepted.kit),before=await inventory(root);
 await assert.rejects(executeFeedbackKitRecipe(root,recipe,{signal:controller.signal}),/cancelled/);
 assert.deepEqual(await inventory(root),before);assert.deepEqual(await resolveAssetObject(root,accepted.kit),bytes);
}));

test("frozen reward and harvest presets produce audible cues and visible reduced-motion stills",{timeout:60000},()=>workspace(async root=>{
 assert.ok(Object.isFrozen(FEEDBACK_KIT_PRESETS.uiReward.variants.strong.tones[0]));
 for(const preset of [FEEDBACK_KIT_PRESETS.uiReward,FEEDBACK_KIT_PRESETS.harvest]) {
  const result=await executeFeedbackKitRecipe(root,preset);
  const peaks:number[]=[];
  for(const intensity of ["strong","subtle"] as const) {
   const v=result.manifest.variants[intensity],samples=pcm(await resolveAssetObject(root,v.audio.cue));
   assert.equal(samples.length,v.audio.frameCount);
   peaks.push(Math.max(...samples.map(Math.abs)));
   assert.ok(peaks.at(-1)!>0 && peaks.at(-1)!<32767);
   const still=parseRgba8Image(await resolveAssetObject(root,v.visual.reducedMotion.image));
   assert.ok(still.pixels.some((value,index)=>index%4===3 && value>0));
   assert.ok(v.endMs<=3000);
  }
  assert.ok(peaks[1]!<peaks[0]!,"subtle cue is quieter than strong");
  assert.equal(createAssetRef(result.kit).kind,"feedback-kit");
 }
}));
