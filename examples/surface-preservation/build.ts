import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { executeSurfaceTextureRecipe, executePreservedSurfaceTextureRecipe, SURFACE_TEXTURE_PRESETS,
  type SurfaceChannel, type SurfaceTexturePreservation } from "../../src/surface-texture-recipes.js";
import { createImageEncodePngOperationBuildIdentity, executeImageEncodePngOperation } from "../../src/image-codec-operations.js";
import { assetObjectPortablePath, resolveAssetObject } from "../../src/asset-store.js";
import { createAssetRef, type AssetRef } from "../../src/operations.js";
import { canonicalJson } from "../../src/canonical.js";
import { writeIfChanged } from "../reconcile-file.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), directory = path.join(root,".artifacts/surface-preservation");
await mkdir(directory,{recursive:true});
const recipe = { ...SURFACE_TEXTURE_PRESETS["rock-grainy"], low: [55,59,62], high: [160,164,166] };
const accepted = await executeSurfaceTextureRecipe(directory,recipe);
function locks(channels: SurfaceChannel[]): SurfaceTexturePreservation {
  return Object.fromEntries(channels.map(channel => {
    const field = channel === "color" ? "base-color" : channel, step = accepted.steps.find(s => s.output.metadata.field === field);
    assert.ok(step); return [channel,step];
  }));
}
async function objects() {
  const dir = path.dirname(path.dirname(path.join(directory,assetObjectPortablePath(accepted.outputs.height!))));
  const files = new Map<string,number>();
  for (const prefix of await readdir(dir)) for (const name of await readdir(path.join(dir,prefix))) files.set(`${prefix}/${name}`,(await stat(path.join(dir,prefix,name))).size);
  return files;
}
const before = await objects();
const recolored = await executePreservedSurfaceTextureRecipe(directory,{...recipe,low:[75,28,12],high:[215,178,119]},
  { preserve: locks(["height","normal","roughness"]) });
const normalEdited = await executePreservedSurfaceTextureRecipe(directory,{...recipe,normalStrength:12},
  { preserve: locks(["height","color","roughness"]) });
const after = await objects(), added = [...after].filter(([name]) => !before.has(name));
const cold = await mkdtemp(path.join(os.tmpdir(),"surface-preservation-proof-"));
try {
  for (const partial of [recolored,normalEdited]) {
    const { execution: _execution, ...canonical } = partial;
    assert.deepEqual(canonical,await executeSurfaceTextureRecipe(cold,partial.recipe));
  }
} finally { await rm(cold,{recursive:true,force:true}); }
const pngs: Record<string,{ asset: AssetRef; build: Awaited<ReturnType<typeof createImageEncodePngOperationBuildIdentity>> }> = {};
const selected = { "accepted-color":accepted.outputs.color!, "recolored-color":recolored.outputs.color!,
  "accepted-height":accepted.outputs.height!, "accepted-normal":accepted.outputs.normal!,
  "normal-edited-normal":normalEdited.outputs.normal!, "accepted-roughness":accepted.outputs.roughness! };
for (const [name,source] of Object.entries(selected)) {
  const invocation = { inputs:{source}, parameters:{compressionLevel:9} }, build = await createImageEncodePngOperationBuildIdentity(directory,invocation);
  const asset = createAssetRef((await executeImageEncodePngOperation(directory,invocation)).outputs.output);
  await writeIfChanged(path.join(directory,`${name}.png`),await resolveAssetObject(directory,asset));
  pngs[name]={asset,build};
}
await writeIfChanged(path.join(directory,"builds.json"),Buffer.from(canonicalJson({accepted,recolored,normalEdited,pngs})+"\n"));
await writeIfChanged(path.join(directory,"execution.json"),Buffer.from(canonicalJson({ schemaVersion:1,
  edits:[recolored.execution,normalEdited.execution], generatedGeometryElements:0,
  newlyStoredCanonicalObjects:added.length, canonicalObjectBytesWritten:added.reduce((sum,[,size]) => sum+size,0),
  comparison:"partial canonical results equal independent cold full rebuilds", pngEncoding:"separate recorded stage; excluded from edit byte count" })+"\n"));
console.log(JSON.stringify({directory,executedOperations:[recolored.execution.executedOperations,normalEdited.execution.executedOperations],
  reusedOperations:[recolored.execution.reusedOperations,normalEdited.execution.reusedOperations],canonicalObjectBytesWritten:added.reduce((sum,[,size]) => sum+size,0)}));
