import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdir,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {AUTHORED_EFFECT_SEQUENCE_PRESETS,executeAuthoredEffectSequenceRecipe} from "asset-tooling/recipes/authored-effect-sequences";
import {executeImageEncodePngOperation,createImageEncodePngOperationBuildIdentity} from "asset-tooling/operations/image/codecs";
import {createAssetRef,type AssetRef,type AssetOperationBuildIdentity} from "asset-tooling/operations";
import {resolveAssetObject} from "asset-tooling/operations/store";
import {canonicalJson} from "../../src/canonical.js";
import {writeIfChanged} from "../reconcile-file.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),directory=path.join(root,".artifacts/authored-effect-sequences");
type PngStep={build:AssetOperationBuildIdentity;output:AssetRef};
type SequenceEvidence={result:Awaited<ReturnType<typeof executeAuthoredEffectSequenceRecipe>>;pngs:Record<string,AssetRef>;pngSteps:PngStep[]};
await mkdir(directory,{recursive:true});
const cold=await mkdtemp(path.join(tmpdir(),"authored-effects-example-")),evidence:SequenceEvidence[]=[];
try {
 for(const family of ["ring","puff"] as const) for(const intensity of ["strong","subtle","off"] as const) {
  const recipe=AUTHORED_EFFECT_SEQUENCE_PRESETS[family][intensity],result=await executeAuthoredEffectSequenceRecipe(root,recipe);
  assert.deepEqual(await executeAuthoredEffectSequenceRecipe(cold,recipe),result);
  const output=path.join(directory,recipe.sequence);await mkdir(output,{recursive:true});
  const pngs:Record<string,AssetRef>={},pngSteps:PngStep[]=[];
  for(const [id,source] of [...result.frames.map(f=>[f.id,f.image] as const),["atlas",createAssetRef(result.atlas.result.outputs.image)] as const]) {
   const invocation={inputs:{source},parameters:{compressionLevel:9}},build=await createImageEncodePngOperationBuildIdentity(root,invocation);
   const encoded=await executeImageEncodePngOperation(root,invocation);assert.deepEqual(await executeImageEncodePngOperation(cold,invocation),encoded);
   const png=createAssetRef(encoded.outputs.output);pngs[id]=png;pngSteps.push({build,output:png});
   await writeIfChanged(path.join(output,`${id}.png`),await resolveAssetObject(root,png));
   await writeIfChanged(path.join(output,`${id}.rgba.json`),await resolveAssetObject(root,source));
  }
  await writeIfChanged(path.join(output,"atlas.json"),await resolveAssetObject(root,createAssetRef(result.atlas.result.outputs.manifest)));
  await writeIfChanged(path.join(output,"recipe.json"),Buffer.from(canonicalJson(result.recipe)+"\n"));
  evidence.push({result,pngs,pngSteps});
  console.log(JSON.stringify({sequence:recipe.sequence,frames:result.frames.length,durationMs:result.durationMs,loop:false,motionEvaluations:0}));
 }
 await writeIfChanged(path.join(directory,"evidence.json"),Buffer.from(canonicalJson({schemaVersion:1,sequences:evidence,coldSequenceReplays:6,coldPngReplays:42})+"\n"));
} finally {await rm(cold,{recursive:true,force:true});}
