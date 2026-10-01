import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdir,readFile} from "node:fs/promises";
import {createAssetRef} from "asset-tooling/operations";
import {prepareRenderDerivativeRecipe,readRenderDerivativeRecipeSource,RENDER_DERIVATIVE_PRESETS} from "asset-tooling/recipes/render-derivatives";
import {canonicalJson} from "../../src/canonical.js";
import {writeIfChanged} from "../reconcile-file.js";

// Keep unchanged legacy orchestration outside this strict recipe/inspection slice.
const {generateAsset,verifyAsset}:{generateAsset:(p:string)=>Promise<unknown>;verifyAsset:(p:string)=>Promise<{status:string}>}=await import(new URL("../../src/core.js",import.meta.url).href);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),directory=path.join(root,".artifacts/wood-surfaces");
function object(value:unknown):Record<string,unknown> {
 if(!value || typeof value!=="object" || Array.isArray(value)) throw new Error("invalid wood review evidence");
 return value as Record<string,unknown>;
}
const evidence=object(JSON.parse(await readFile(path.join(directory,"evidence.json"),"utf8")));
assert.equal(evidence.schemaVersion,1);assert.ok(Array.isArray(evidence.variants) && evidence.variants.length===3);
const renderer=await readRenderDerivativeRecipeSource();
for(const value of evidence.variants) {
 const variant=object(value);assert.ok(["wood-long-grain","wood-short-grain","wood-cross-grain"].includes(String(variant.id)));
 const id=String(variant.id),source=createAssetRef(variant.mesh),output=path.join(directory,"renders",id);
 const render=await prepareRenderDerivativeRecipe(root,{assetId:`wood-review.${id}`,source,scriptSha256:renderer.sha256,blenderVersion:renderer.blenderVersion,
  parameters:{...RENDER_DERIVATIVE_PRESETS.thumbnail,width:512,height:512,samples:16}});
 await mkdir(output,{recursive:true});
 await writeIfChanged(path.join(output,"render_static_glb.py"),renderer.bytes);
 await writeIfChanged(path.join(output,"source.glb"),render.sourceBytes);
 await writeIfChanged(path.join(output,"asset.json"),Buffer.from(canonicalJson(render.spec)+"\n"));
 await generateAsset(path.join(output,"asset.json"));assert.equal((await verifyAsset(path.join(output,"asset.json"))).status,"exact");
 console.log(JSON.stringify({id,status:"exact",sourceGeometryGenerated:0}));
}
