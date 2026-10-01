import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdir,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {AUTHORED_EFFECT_SEQUENCE_PRESETS,executeAuthoredEffectSequenceRecipe} from "asset-tooling/recipes/authored-effect-sequences";
import {executeImageEncodePngOperation,createImageEncodePngOperationBuildIdentity} from "asset-tooling/operations/image/codecs";
import {createAssetRef,type AssetRef,type AssetOperationBuildIdentity} from "asset-tooling/operations";
import {resolveAssetObject} from "asset-tooling/operations/store";
import {exportAssetBundle,verifyAssetBundle,readAssetBundleSpriteAtlas,SPRITE_ATLAS_BUNDLE_PROFILE} from "asset-tooling/operations/bundle";
import {canonicalJson} from "../../src/canonical.js";
import {writeIfChanged} from "../reconcile-file.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),directory=path.join(root,".artifacts/atlas-bundle");
await mkdir(directory,{recursive:true});
const temporary=await mkdtemp(path.join(tmpdir(),"atlas-bundle-example-"));
const selections:{key:string;variant:string}[]=[],assets:AssetRef[]=[],images:AssetRef[]=[];
const evidence:{sequence:string;result:Awaited<ReturnType<typeof executeAuthoredEffectSequenceRecipe>>;png:AssetRef;pngBuild:AssetOperationBuildIdentity}[]=[];
try {
 for(const family of ["ring","puff"] as const) for(const intensity of ["strong","subtle","off"] as const) {
  const recipe=AUTHORED_EFFECT_SEQUENCE_PRESETS[family][intensity],result=await executeAuthoredEffectSequenceRecipe(root,recipe);
  assert.deepEqual(await executeAuthoredEffectSequenceRecipe(temporary,recipe),result);
  const atlas=createAssetRef(result.atlas.result.outputs.manifest),source=createAssetRef(result.atlas.result.outputs.image);
  const invocation={inputs:{source},parameters:{compressionLevel:9}},pngBuild=await createImageEncodePngOperationBuildIdentity(root,invocation),encoded=await executeImageEncodePngOperation(root,invocation);
  assert.deepEqual(await executeImageEncodePngOperation(temporary,invocation),encoded);
  const png=createAssetRef(encoded.outputs.output);
  selections.push({key:family,variant:intensity});assets.push(atlas);images.push(png);evidence.push({sequence:recipe.sequence,result,png,pngBuild});
 }
 const invocation={parameters:{profile:SPRITE_ATLAS_BUNDLE_PROFILE,assets:selections},inputs:{assets,images}};
 const packaged=await exportAssetBundle(root,path.join(directory,"package"),invocation);
 const fresh=await exportAssetBundle(temporary,path.join(temporary,"package"),invocation);
 assert.deepEqual(fresh.manifest,packaged.manifest);
 const checked=await verifyAssetBundle(path.join(directory,"package"),packaged.manifest,{profile:SPRITE_ATLAS_BUNDLE_PROFILE});
 assert.equal(checked.manifest.schemaVersion,2);if(checked.manifest.schemaVersion!==2) throw new Error("expected atlas profile");
 // Independent package verification/loading remains possible after its source store is deleted.
 await rm(path.join(temporary,".asset-tooling"),{recursive:true,force:true});
 assert.deepEqual(await verifyAssetBundle(path.join(temporary,"package"),fresh.manifest,{profile:SPRITE_ATLAS_BUNDLE_PROFILE}),checked);
 for(const selected of selections) {
  const original=await readAssetBundleSpriteAtlas(path.join(directory,"package"),checked.manifest,selected.key,selected.variant);
  const cold=await readAssetBundleSpriteAtlas(path.join(temporary,"package"),checked.manifest,selected.key,selected.variant);
  assert.deepEqual(cold,original);
  const accepted=evidence.find(e=>e.sequence===`${selected.key}.${selected.variant}`);assert.ok(accepted);
  assert.deepEqual(original.png,await resolveAssetObject(root,accepted.png));
  assert.deepEqual(Buffer.from(canonicalJson(original.atlas)+"\n"),await resolveAssetObject(root,createAssetRef(accepted.result.atlas.result.outputs.manifest)));
 }
 await writeIfChanged(path.join(directory,"package.ref.json"),Buffer.from(canonicalJson(packaged.manifest)+"\n"));
 await writeIfChanged(path.join(directory,"evidence.json"),Buffer.from(canonicalJson({schemaVersion:1,sequences:evidence,package:packaged.manifest,distributionFiles:packaged.files,
  coldPackageMatches:true,loadsWithoutSourceStore:true,motionEvaluations:0})+"\n"));
 console.log(JSON.stringify({sequences:selections.length,frames:evidence.reduce((sum,e)=>sum+e.result.frames.length,0),packageBytesWritten:packaged.bytesWritten,
  uniquePayloads:checked.uniquePayloads,distributionFiles:packaged.files.length,coldPackageMatches:true,loadsWithoutSourceStore:true,motionEvaluations:0}));
} finally {await rm(temporary,{recursive:true,force:true});}
