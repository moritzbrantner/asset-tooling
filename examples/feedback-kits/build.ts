import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdir,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {FEEDBACK_KIT_PRESETS,executeFeedbackKitRecipe} from "asset-tooling/recipes/feedback-kits";
import {executeImageEncodePngOperation} from "asset-tooling/operations/image/codecs";
import {createAssetRef,type AssetRef} from "asset-tooling/operations";
import {resolveAssetObject} from "asset-tooling/operations/store";
import {canonicalJson} from "../../src/canonical.js";
import {writeIfChanged} from "../reconcile-file.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),directory=path.join(root,".artifacts/feedback-kits");
type Variant={visual:{image:AssetRef;reducedMotion:{image:AssetRef}};audio:{cue:AssetRef;onsetMs:number;durationMs:number};endMs:number};
const cold=await mkdtemp(path.join(tmpdir(),"feedback-kits-example-"));
try {
 for(const preset of [FEEDBACK_KIT_PRESETS.uiReward,FEEDBACK_KIT_PRESETS.harvest]) {
  const result=await executeFeedbackKitRecipe(root,preset);
  assert.deepEqual(await executeFeedbackKitRecipe(cold,preset),result);
  const output=path.join(directory,preset.kit);await mkdir(output,{recursive:true});
  await writeIfChanged(path.join(output,"kit.json"),await resolveAssetObject(root,result.kit));
  await writeIfChanged(path.join(output,"recipe.json"),Buffer.from(canonicalJson(result.recipe)+"\n"));
  for(const intensity of ["strong","subtle"] as const) {
   const v=result.manifest.variants[intensity] as Variant;
   await writeIfChanged(path.join(output,`${intensity}.wav`),await resolveAssetObject(root,v.audio.cue));
   for(const [name,source] of [["atlas",v.visual.image],["reduced-motion",v.visual.reducedMotion.image]] as const) {
    const encoded=await executeImageEncodePngOperation(root,{inputs:{source},parameters:{compressionLevel:9}});
    await writeIfChanged(path.join(output,`${intensity}.${name}.png`),await resolveAssetObject(root,createAssetRef(encoded.outputs.output)));
   }
   console.log(JSON.stringify({kit:preset.kit,intensity,audioOnsetMs:v.audio.onsetMs,audioDurationMs:v.audio.durationMs,endMs:v.endMs,kitSha256:result.kit.sha256}));
  }
 }
} finally {await rm(cold,{recursive:true,force:true});}
