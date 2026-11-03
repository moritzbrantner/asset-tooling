/** Opt-in local benchmark for the 512-sprite atlas and 3,600-sprite bundle of #453. */
import { execFileSync } from "node:child_process";
import { cpus, platform, release, totalmem } from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../src/canonical.js";
import { sha256Bytes } from "../src/hash.js";
import { createAssetRef, type AssetRef } from "../src/operations.js";
import { encodeRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "../src/image-rgba8.js";
import { encodeRgbaPng } from "../src/effect-flipbook-raster.js";
import { SPRITE_ATLAS_MEDIA_TYPE } from "../src/sprite-atlas-operations.js";
import { SPRITE_ATLAS_BUNDLE_PROFILE, ASSET_BUNDLE_MEDIA_TYPE, type BundleResource, type SpriteAtlasBundleEntry, type SpriteAtlasBundleManifest } from "../src/asset-bundle-contract.js";
import { assetPath, BundleBudget, bundleResources, checkBudget, parseSpriteAtlasBundleManifest } from "../src/asset-bundle-manifest.js";
import { uniqueResources } from "../src/asset-bundle-payload.js";
import { readPinned } from "../src/asset-bundle-files.js";
import { createAssetBundleReadSnapshot, readAssetBundleAsset, verifyAssetBundle } from "../src/asset-bundle.js";

type Fixture = { directory:string; manifest:SpriteAtlasBundleManifest; bytes:Buffer; pin:AssetRef; additions:BundleResource[]; initial:BundleResource[]; files:BundleResource[] };
type Task = { scenario:string; strategy:string; run:()=>Promise<unknown>|unknown };
type Measurement = { scenario:string; strategy:string; samplesMs:number[]; medianMs:number; minMs:number; maxMs:number };

function argumentsFromCli() {
  const args=process.argv.slice(2);
  let runs=5,full=false;
  for(let i=0;i<args.length;i++) {
    if(args[i]==="--json") continue;
    if(args[i]==="--full") {full=true;continue;}
    if(args[i]==="--runs" && args[i+1]) {runs=Number(args[++i]);continue;}
    throw new Error("usage: bun scripts/benchmark-asset-bundle.ts [--json] [--full] [--runs N]");
  }
  if(!Number.isSafeInteger(runs) || runs<1 || runs>30) throw new Error("--runs must be 1..30");
  return {runs,full};
}
function reference(bytes:Buffer,kind:string,mediaType:string,metadata:Record<string,unknown>={}) {
  return createAssetRef({sha256:sha256Bytes(bytes),byteLength:bytes.byteLength,kind,mediaType,metadata});
}
function resource(ref:AssetRef):BundleResource { return {source:ref,path:assetPath(ref,SPRITE_ATLAS_BUNDLE_PROFILE)}; }
function median(values:number[]):number {
  const ordered=[...values].sort((a,b)=>a-b),center=Math.floor(ordered.length/2);
  return ordered.length%2?ordered[center]!:((ordered[center-1]!+ordered[center]!)/2);
}

async function fixture(directory:string,count:number):Promise<Fixture> {
  await mkdir(path.join(directory,"assets"),{recursive:true});
  const assets:SpriteAtlasBundleEntry[]=[],resources:BundleResource[]=[],additions:BundleResource[]=[];
  const save=async(ref:AssetRef,bytes:Buffer)=>{const r=resource(ref);await writeFile(path.join(directory,r.path),bytes);return r;};
  for(let offset=0,atlasIndex=0;offset<count;atlasIndex++) {
    const width=Math.min(512,count-offset),pixels=Buffer.alloc(width*4),sprites=[];
    for(let x=0;x<width;x++) {
      const id=offset+x,color=Buffer.from([id&255,(id>>8)&255,(id>>16)&255,255]);pixels.set(color,x*4);
      const bytes=encodeRgba8Image({width:1,height:1,pixels:color});
      const source=reference(bytes,"image",RGBA8_IMAGE_MEDIA_TYPE);
      const entry=await save(source,bytes);resources.push(entry);additions.push(entry);
      sprites.push({id:`sprite.${String(id).padStart(4,"0")}`,source,sourceSize:{width:1,height:1},pivot:{x:.5,y:.5},rect:{x,y:0,width:1,height:1},
        trimOffset:{x:0,y:0},empty:false,rotated:false as const});
    }
    const imageBytes=encodeRgba8Image({width,height:1,pixels}),image=reference(imageBytes,"image",RGBA8_IMAGE_MEDIA_TYPE);
    const imageResource=await save(image,imageBytes);resources.push(imageResource);additions.push(imageResource);
    const atlasBytes=Buffer.from(`${canonicalJson({schemaVersion:1,image,width,height:1,coordinates:"top-left-pixels",colorSpace:"srgb",alphaMode:"straight",padding:0,extrusion:0,sprites})}\n`);
    const atlas=reference(atlasBytes,"sprite-atlas",SPRITE_ATLAS_MEDIA_TYPE),atlasResource=await save(atlas,atlasBytes);
    const pngBytes=encodeRgbaPng(width,1,pixels),png=reference(pngBytes,"image","image/png",{
      sourceSha256:image.sha256,width,height:1,codec:"png",sourceColorSpace:"srgb",
    });
    const pngResource=await save(png,pngBytes);
    assets.push({key:`atlas.${String(atlasIndex).padStart(2,"0")}`,variant:"default",source:atlas,path:atlasResource.path,image:pngResource});
    offset+=width;
  }
  const manifest:SpriteAtlasBundleManifest={schemaVersion:2,profile:SPRITE_ATLAS_BUNDLE_PROFILE,assets,resources:uniqueResources(resources)};
  const bytes=Buffer.from(`${canonicalJson(manifest)}\n`),pin=reference(bytes,"asset-bundle",ASSET_BUNDLE_MEDIA_TYPE);
  parseSpriteAtlasBundleManifest(bytes);await writeFile(path.join(directory,"manifest.json"),bytes);
  const initial=[...assets,...assets.map(entry=>entry.image)],files=[...new Map(bundleResources(manifest).map(r=>[r.path,r])).values()];
  return {directory,manifest,bytes,pin,initial,additions,files};
}

async function measure(tasks:Task[],runs:number):Promise<Measurement[]> {
  const records=new Map(tasks.map(task=>[`${task.scenario}/${task.strategy}`,{scenario:task.scenario,strategy:task.strategy,samplesMs:[]} as Measurement]));
  for(const task of tasks) await task.run(); // Warmup; fixture construction is outside timing.
  for(let i=0;i<runs;i++) {
    for(const task of i%2===0?tasks:[...tasks].reverse()) {
      const start=performance.now();await task.run();const delta=performance.now()-start;
      records.get(`${task.scenario}/${task.strategy}`)!.samplesMs.push(Number(delta.toFixed(3)));
    }
  }
  return [...records.values()].map(result=>({...result,medianMs:median(result.samplesMs),minMs:Math.min(...result.samplesMs),maxMs:Math.max(...result.samplesMs)}));
}

async function main() {
  const options=argumentsFromCli(),root=await mkdtemp(path.join(tmpdir(),"asset-bundle-benchmark-"));
  try {
    const results=[];
    for(const count of [512,3600]) {
      const f=await fixture(path.join(root,String(count)),count),last=f.manifest.assets.at(-1)!,snapshot=createAssetBundleReadSnapshot(f.manifest);
      const tasks:Task[]=[
        {scenario:"manifest.parse",strategy:"baseline",run:()=>parseSpriteAtlasBundleManifest(f.bytes)},
        {scenario:"manifest.snapshot-create",strategy:"validated",run:()=>createAssetBundleReadSnapshot(f.manifest)},
        {scenario:"asset.read-one",strategy:"raw-manifest",run:()=>readAssetBundleAsset(f.directory,f.manifest,last.key,last.variant)},
        {scenario:"asset.read-one",strategy:"snapshot",run:()=>readAssetBundleAsset(f.directory,snapshot,last.key,last.variant)},
        {scenario:"assets.read-all",strategy:"raw-manifest",run:async()=>{for(const entry of f.manifest.assets) await readAssetBundleAsset(f.directory,f.manifest,entry.key,entry.variant);}},
        {scenario:"assets.read-all",strategy:"snapshot",run:async()=>{for(const entry of f.manifest.assets) await readAssetBundleAsset(f.directory,snapshot,entry.key,entry.variant);}},
        {scenario:"bundle.read-closure",strategy:"pinned-files",run:async()=>{for(const entry of f.files) await readPinned(f.directory,entry.path,entry.source);}},
        {scenario:"budget.build",strategy:"full-recheck",run:()=>{const entries=[...f.initial];checkBudget(entries);for(const item of f.additions) {entries.push(item);checkBudget(entries);}}},
        {scenario:"budget.build",strategy:"incremental",run:()=>{const budget=new BundleBudget(f.initial);for(const item of f.additions) {budget.add(item);budget.check();}}},
      ];
      if(options.full) tasks.push({scenario:"bundle.verify",strategy:"independent-double-read",run:()=>verifyAssetBundle(f.directory,f.pin,{profile:SPRITE_ATLAS_BUNDLE_PROFILE})});
      results.push({workload:count===512?"atlas-512":"bundle-3600",sprites:count,atlases:f.manifest.assets.length,resources:f.manifest.resources.length,
        manifestBytes:f.bytes.length,files:f.files.length,measurements:await measure(tasks,options.runs)});
    }
    const git=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();
    const trackedChanges=execFileSync("git",["status","--porcelain","--untracked-files=no"],{encoding:"utf8"}).trim().length>0;
    const scriptSha256=sha256Bytes(await readFile(fileURLToPath(import.meta.url)));
    process.stdout.write(`${JSON.stringify({schemaVersion:1,sourceCommit:git,trackedChanges,scriptSha256,
      environment:{bun:Bun.version,platform:platform(),release:release(),arch:process.arch,
        cpus:cpus().length,cpuModel:cpus()[0]?.model??"unknown",memoryBytes:totalmem()},runs:options.runs,fullVerification:options.full,results},null,2)}\n`);
  } finally { await rm(root,{recursive:true,force:true}); }
}
await main();
