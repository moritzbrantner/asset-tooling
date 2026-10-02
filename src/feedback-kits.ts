import path from "node:path";
import {storeAssetObject} from "./asset-store.js";
import {canonicalJson} from "./canonical.js";
import {sha256Text} from "./hash.js";
import {createAssetRef,type AssetRef,type AssetOperationBuildIdentity,type DeepReadonly} from "./operations.js";
import {AUTHORED_EFFECT_SEQUENCE_PRESETS,executeAuthoredEffectSequenceRecipe,normalizeAuthoredEffectSequenceRecipe,type AuthoredEffectSequenceRecipe} from "./authored-effect-sequences.js";

// The audio operations are not yet in the strict TypeScript project; type only the authoritative calls used here.
type AudioInvocation={parameters:unknown;inputs?:unknown};
type AudioResult={outputs:Record<string,unknown>};
type ProceduralAudio={
 createAudioOscillatorOperationBuildIdentity:(root:string,invocation:AudioInvocation)=>Promise<AssetOperationBuildIdentity>;
 executeAudioOscillatorOperation:(root:string,invocation:AudioInvocation)=>Promise<AudioResult>;
 createAudioAdsrOperationBuildIdentity:(root:string,invocation:AudioInvocation)=>Promise<AssetOperationBuildIdentity>;
 executeAudioAdsrOperation:(root:string,invocation:AudioInvocation)=>Promise<AudioResult>};
type AudioMix={
 createAudioMixOperationBuildIdentity:(invocation:AudioInvocation)=>Promise<AssetOperationBuildIdentity>;
 executeAudioMixOperation:(root:string,invocation:AudioInvocation)=>Promise<AudioResult>};
const loadAudio=async()=>{
 const procedural:ProceduralAudio=await import(new URL("./audio-procedural-operations.js",import.meta.url).href);
 const mix:AudioMix=await import(new URL("./audio-operations.js",import.meta.url).href);
 return {...procedural,...mix};
};

/** One fixed canonical rate makes millisecond-to-frame conversion exact (48 frames per ms, no rounding). */
export const FEEDBACK_KIT_SAMPLE_RATE=48000;
const FRAMES_PER_MS=FEEDBACK_KIT_SAMPLE_RATE/1000;
const Q15_FULL_SCALE=32767;
export const FEEDBACK_KIT_MEDIA_TYPE="application/vnd.moritzbrantner.feedback-kit+json";
export const FEEDBACK_KIT_INTENSITIES=Object.freeze(["strong","subtle"] as const);
export type FeedbackKitIntensity=typeof FEEDBACK_KIT_INTENSITIES[number];

export type FeedbackTone={waveform:"sine"|"triangle";frequencyHz:number;amplitude:number;startMs:number;durationMs:number;
 attackMs:number;decayMs:number;sustainLevelQ15:number;releaseMs:number};
export type FeedbackKitVariant={visual:AuthoredEffectSequenceRecipe;visualOnsetMs:number;reducedMotionFrameIndex:number;
 audioOnsetMs:number;tones:FeedbackTone[]};
export type FeedbackKitRecipe={schemaVersion:1;kit:string;concurrency:{maxActive:number;overflow:"drop-new"|"replace-oldest"};
 variants:Record<FeedbackKitIntensity,FeedbackKitVariant>};

function object(value:unknown,keys:readonly string[],label:string):Record<string,unknown> {
 if(!value || typeof value!=="object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be a plain object`);
 // Plain-object validation establishes this external JSON boundary.
 const p=value as Record<string,unknown>;
 if(Object.keys(p).some(k=>!keys.includes(k)) || keys.some(k=>!Object.hasOwn(p,k))) throw new Error(`${label} requires exactly ${keys.join(", ")}`);
 return p;
}
function integer(value:unknown,label:string,min:number,max:number):number {
 if(typeof value!=="number" || !Number.isSafeInteger(value) || value<min || value>max) throw new Error(`${label} must be an integer in ${min}..${max}`);
 return value;
}
function tone(value:unknown,label:string):FeedbackTone {
 const t=object(value,["waveform","frequencyHz","amplitude","startMs","durationMs","attackMs","decayMs","sustainLevelQ15","releaseMs"],label);
 if(t.waveform!=="sine" && t.waveform!=="triangle") throw new Error(`${label} waveform must be sine or triangle`);
 const durationMs=integer(t.durationMs,`${label} durationMs`,1,2000);
 const result:FeedbackTone={waveform:t.waveform,frequencyHz:integer(t.frequencyHz,`${label} frequencyHz`,20,12000),
  amplitude:integer(t.amplitude,`${label} amplitude`,0,Q15_FULL_SCALE),startMs:integer(t.startMs,`${label} startMs`,0,2000),durationMs,
  attackMs:integer(t.attackMs,`${label} attackMs`,0,2000),decayMs:integer(t.decayMs,`${label} decayMs`,0,2000),
  sustainLevelQ15:integer(t.sustainLevelQ15,`${label} sustainLevelQ15`,0,Q15_FULL_SCALE),releaseMs:integer(t.releaseMs,`${label} releaseMs`,0,2000)};
 if(result.attackMs+result.decayMs+result.releaseMs>durationMs) throw new Error(`${label} envelope exceeds its duration`);
 if(result.startMs+durationMs>2000) throw new Error(`${label} must end within the 2000ms audio cue budget`);
 return result;
}
function variant(value:unknown,label:string):FeedbackKitVariant {
 const v=object(value,["visual","visualOnsetMs","reducedMotionFrameIndex","audioOnsetMs","tones"],label);
 const visual=normalizeAuthoredEffectSequenceRecipe(v.visual);
 const reducedMotionFrameIndex=integer(v.reducedMotionFrameIndex,`${label} reducedMotionFrameIndex`,0,visual.frames.length-1);
 if(visual.frames[reducedMotionFrameIndex]!.artwork.opacity===0) throw new Error(`${label} reduced-motion frame must be visible`);
 if(!Array.isArray(v.tones) || v.tones.length<1 || v.tones.length>4) throw new Error(`${label} requires 1..4 tones`);
 const tones=v.tones.map((t,index)=>tone(t,`${label} tone ${index}`));
 // Oscillator samples never exceed their amplitude and ADSR only attenuates, so this bound rules out mix saturation.
 if(tones.reduce((sum,t)=>sum+t.amplitude,0)>Q15_FULL_SCALE) throw new Error(`${label} tone amplitudes must sum to at most ${Q15_FULL_SCALE} (no clipping)`);
 return {visual,visualOnsetMs:integer(v.visualOnsetMs,`${label} visualOnsetMs`,0,1000),reducedMotionFrameIndex,
  audioOnsetMs:integer(v.audioOnsetMs,`${label} audioOnsetMs`,0,1000),tones};
}
const visualDurationMs=(v:FeedbackKitVariant)=>v.visual.frames.at(-1)!.timeMs+v.visual.frames.at(-1)!.durationMs;
const audioDurationMs=(v:FeedbackKitVariant)=>Math.max(...v.tones.map(t=>t.startMs+t.durationMs));

/** Validates the complete kit (both intensities, every pose and tone) before any generated object. */
export function normalizeFeedbackKitRecipe(value:unknown):FeedbackKitRecipe {
 const p=object(value,["schemaVersion","kit","concurrency","variants"],"feedback kit");
 if(p.schemaVersion!==1) throw new Error("feedback kit requires schemaVersion 1");
 if(typeof p.kit!=="string" || p.kit.length>64 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(p.kit)) throw new Error("kit must be a portable lowercase token of at most 64 characters");
 const c=object(p.concurrency,["maxActive","overflow"],"feedback kit concurrency");
 if(c.overflow!=="drop-new" && c.overflow!=="replace-oldest") throw new Error("concurrency overflow must be drop-new or replace-oldest");
 const raw=object(p.variants,FEEDBACK_KIT_INTENSITIES,"feedback kit variants");
 const variants={strong:variant(raw.strong,"strong variant"),subtle:variant(raw.subtle,"subtle variant")};
 for(const v of Object.values(variants)) if(Math.max(v.visualOnsetMs+visualDurationMs(v),v.audioOnsetMs+audioDurationMs(v))>3000) throw new Error("feedback kit variant exceeds its 3000ms presentation budget");
 return {schemaVersion:1,kit:p.kit,concurrency:{maxActive:integer(c.maxActive,"concurrency maxActive",1,8),overflow:c.overflow},variants};
}

export type FeedbackKitVariantManifest={
 visual:{onsetMs:number;durationMs:number;loop:false;atlas:AssetRef;image:AssetRef;reducedMotion:{frameId:string;image:AssetRef}};
 audio:{onsetMs:number;durationMs:number;cue:AssetRef;sampleRate:typeof FEEDBACK_KIT_SAMPLE_RATE;channels:1;frameCount:number;clipping:"amplitude-sum-headroom"};
 endMs:number};
export type FeedbackKitManifest={schemaVersion:1;kit:string;recipeSha256:string;presentation:"cosmetic-only";
 time:{unit:"ms";origin:"accepted-cosmetic-event"};concurrency:FeedbackKitRecipe["concurrency"];
 variants:Record<FeedbackKitIntensity,FeedbackKitVariantManifest>};
type Step={build:AssetOperationBuildIdentity;output:AssetRef};
async function step(signal:AbortSignal|undefined,create:()=>Promise<AssetOperationBuildIdentity>,execute:()=>Promise<{outputs:Record<string,unknown>}>):Promise<Step> {
 signal?.throwIfAborted();
 const build=await create();
 signal?.throwIfAborted();
 const result=await execute();
 return {build,output:createAssetRef(result.outputs.output)};
}
async function audioCue(root:string,tones:FeedbackTone[],signal?:AbortSignal) {
 const {createAudioOscillatorOperationBuildIdentity,executeAudioOscillatorOperation,createAudioAdsrOperationBuildIdentity,executeAudioAdsrOperation,
  createAudioMixOperationBuildIdentity,executeAudioMixOperation}=await loadAudio();
 const steps:Step[]=[],shaped:AssetRef[]=[];
 for(const t of tones) {
  const osc={parameters:{waveform:t.waveform,sampleRate:FEEDBACK_KIT_SAMPLE_RATE,channels:1,frameCount:t.durationMs*FRAMES_PER_MS,frequencyHz:t.frequencyHz,amplitude:t.amplitude}};
  const source=await step(signal,()=>createAudioOscillatorOperationBuildIdentity(root,osc),()=>executeAudioOscillatorOperation(root,osc));
  const adsr={inputs:{source:source.output},parameters:{attackFrames:t.attackMs*FRAMES_PER_MS,decayFrames:t.decayMs*FRAMES_PER_MS,sustainLevelQ15:t.sustainLevelQ15,releaseFrames:t.releaseMs*FRAMES_PER_MS}};
  const enveloped=await step(signal,()=>createAudioAdsrOperationBuildIdentity(root,adsr),()=>executeAudioAdsrOperation(root,adsr));
  steps.push(source,enveloped);shaped.push(enveloped.output);
 }
 const mix={inputs:{sources:shaped},parameters:{tracks:tones.map(t=>({startFrame:t.startMs*FRAMES_PER_MS,gainNumerator:1,gainDenominator:1}))}};
 const mixed=await step(signal,()=>createAudioMixOperationBuildIdentity(mix),()=>executeAudioMixOperation(root,mix));
 steps.push(mixed);
 return {cue:mixed.output,steps};
}

export async function executeFeedbackKitRecipe(root:string,value:unknown,{signal}:{signal?:AbortSignal}={}) {
 if(typeof root!=="string" || !path.isAbsolute(root)) throw new Error("feedback kit root must be absolute");
 signal?.throwIfAborted();
 const recipe=normalizeFeedbackKitRecipe(value),recipeSha256=sha256Text(canonicalJson(recipe));
 const variants:Partial<Record<FeedbackKitIntensity,FeedbackKitVariantManifest>>={};
 const evidence:Partial<Record<FeedbackKitIntensity,{visual:Awaited<ReturnType<typeof executeAuthoredEffectSequenceRecipe>>;audioSteps:Step[]}>>={};
 let operations=0;
 for(const intensity of FEEDBACK_KIT_INTENSITIES) {
  const v=recipe.variants[intensity];
  const visual=await executeAuthoredEffectSequenceRecipe(root,v.visual,signal?{signal}:{});
  const audio=await audioCue(root,v.tones,signal);
  signal?.throwIfAborted();
  const staticFrame=visual.frames[v.reducedMotionFrameIndex]!,durationMs=audioDurationMs(v);
  variants[intensity]={
   visual:{onsetMs:v.visualOnsetMs,durationMs:visual.durationMs,loop:false,
    atlas:createAssetRef(visual.atlas.result.outputs.manifest),image:createAssetRef(visual.atlas.result.outputs.image),
    reducedMotion:{frameId:staticFrame.id,image:staticFrame.image}},
   audio:{onsetMs:v.audioOnsetMs,durationMs,cue:audio.cue,sampleRate:FEEDBACK_KIT_SAMPLE_RATE,channels:1,frameCount:durationMs*FRAMES_PER_MS,clipping:"amplitude-sum-headroom"},
   endMs:Math.max(v.visualOnsetMs+visual.durationMs,v.audioOnsetMs+durationMs),
  };
  evidence[intensity]={visual,audioSteps:audio.steps};
  operations+=visual.execution.artworkOperations+visual.execution.atlasOperations+audio.steps.length;
 }
 const manifest:FeedbackKitManifest={schemaVersion:1,kit:recipe.kit,recipeSha256,presentation:"cosmetic-only",
  time:{unit:"ms",origin:"accepted-cosmetic-event"},concurrency:recipe.concurrency,
  variants:{strong:variants.strong!,subtle:variants.subtle!}};
 signal?.throwIfAborted();
 const stored=await storeAssetObject(root,{bytes:Buffer.from(`${canonicalJson(manifest)}\n`),kind:"feedback-kit",mediaType:FEEDBACK_KIT_MEDIA_TYPE,
  metadata:{kit:recipe.kit,recipeSha256,intensities:[...FEEDBACK_KIT_INTENSITIES]}});
 return {schemaVersion:1 as const,recipe,recipeSha256,manifest,kit:stored.asset,evidence:{strong:evidence.strong!,subtle:evidence.subtle!},
  execution:{operations,randomness:"none",motionEvaluations:0,audioScheduling:"none"}};
}

function deepFreeze<T>(value:T):DeepReadonly<T> {
 if(typeof value==="object" && value!==null) {Object.freeze(value);for(const nested of Object.values(value)) deepFreeze(nested);}
 // All nested arrays/records are frozen before exposure.
 return value as DeepReadonly<T>;
}
const clone=(value:DeepReadonly<AuthoredEffectSequenceRecipe>):AuthoredEffectSequenceRecipe=>structuredClone(value) as AuthoredEffectSequenceRecipe;
const envelope={attackMs:4,decayMs:40,sustainLevelQ15:12000,releaseMs:60};
const chime=(amplitude:number):FeedbackTone[]=>[
 {waveform:"sine",frequencyHz:660,amplitude,startMs:0,durationMs:180,...envelope},
 {waveform:"sine",frequencyHz:990,amplitude,startMs:70,durationMs:220,...envelope},
];
const pop=(amplitude:number):FeedbackTone[]=>[
 {waveform:"triangle",frequencyHz:220,amplitude,startMs:0,durationMs:90,attackMs:2,decayMs:30,sustainLevelQ15:8000,releaseMs:50},
 {waveform:"sine",frequencyHz:880,amplitude:Math.round(amplitude/2),startMs:30,durationMs:120,...envelope},
];
/** Two starting kits: a UI reward pulse (ring + rising chime) and a harvest pop (puff + soft pop). */
export const FEEDBACK_KIT_PRESETS=deepFreeze({
 uiReward:{schemaVersion:1,kit:"ui.reward-pulse",concurrency:{maxActive:2,overflow:"replace-oldest"},variants:{
  strong:{visual:clone(AUTHORED_EFFECT_SEQUENCE_PRESETS.ring.strong),visualOnsetMs:0,reducedMotionFrameIndex:2,audioOnsetMs:0,tones:chime(9000)},
  subtle:{visual:clone(AUTHORED_EFFECT_SEQUENCE_PRESETS.ring.subtle),visualOnsetMs:0,reducedMotionFrameIndex:2,audioOnsetMs:0,tones:chime(3500)},
 }} satisfies FeedbackKitRecipe,
 harvest:{schemaVersion:1,kit:"farm.harvest-pop",concurrency:{maxActive:4,overflow:"drop-new"},variants:{
  strong:{visual:clone(AUTHORED_EFFECT_SEQUENCE_PRESETS.puff.strong),visualOnsetMs:0,reducedMotionFrameIndex:2,audioOnsetMs:20,tones:pop(10000)},
  subtle:{visual:clone(AUTHORED_EFFECT_SEQUENCE_PRESETS.puff.subtle),visualOnsetMs:0,reducedMotionFrameIndex:2,audioOnsetMs:20,tones:pop(4000)},
 }} satisfies FeedbackKitRecipe,
});
