import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdir,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {SURFACE_APPEARANCE_PRESETS,executeSurfaceAppearanceFamily,executeSurfaceAppearanceState} from "asset-tooling/recipes/surface-appearances";
import {executeImageEncodePngOperation} from "asset-tooling/operations/image/codecs";
import {createAssetRef,type AssetRef} from "asset-tooling/operations";
import {resolveAssetObject} from "asset-tooling/operations/store";
import {canonicalJson} from "../../src/canonical.js";
import {writeIfChanged} from "../reconcile-file.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),directory=path.join(root,".artifacts/surface-appearances");
const family=SURFACE_APPEARANCE_PRESETS.soilMoisture,output=path.join(directory,family.id);
await mkdir(output,{recursive:true});
const cold=await mkdtemp(path.join(tmpdir(),"surface-appearances-example-"));
async function png(name:string,source:AssetRef) {
 const encoded=await executeImageEncodePngOperation(root,{inputs:{source},parameters:{compressionLevel:9}});
 await writeIfChanged(path.join(output,`${name}.png`),await resolveAssetObject(root,createAssetRef(encoded.outputs.output)));
}
try {
 const result=await executeSurfaceAppearanceFamily(root,family);
 assert.deepEqual(await executeSurfaceAppearanceFamily(cold,family),result);
 await png("shared.height",result.shared.height.output);await png("shared.normal",result.shared.normal.output);
 for(const s of result.states) {
  // Single-state rebuild against the accepted shared steps must match the full family result.
  const single=await executeSurfaceAppearanceState(root,family,s.id,{shared:result.shared});
  assert.deepEqual(single.state,s);
  await png(`${s.id}.color`,s.outputs.color);await png(`${s.id}.roughness`,s.outputs.roughness);
  console.log(JSON.stringify({family:family.id,state:s.id,color:s.outputs.color.sha256,roughness:s.outputs.roughness.sha256,singleStateExecuted:single.state.execution.executedOperations}));
 }
 await writeIfChanged(path.join(output,"family.json"),Buffer.from(canonicalJson({schemaVersion:1,familySha256:result.familySha256,family:result.family,
  invariants:result.invariants,shared:{height:result.shared.height.output,normal:result.shared.normal.output},
  states:result.states.map(s=>({id:s.id,outputs:s.outputs}))})+"\n"));
} finally {await rm(cold,{recursive:true,force:true});}
