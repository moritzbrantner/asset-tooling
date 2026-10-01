import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdir,mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {NodeIO} from "@gltf-transform/core";
import {createAssetRef,type AssetRef,type AssetOperationResult} from "asset-tooling/operations";
import {resolveAssetObject,storeAssetObject} from "asset-tooling/operations/store";
import {executeInstanceExclusionMaskOperation} from "asset-tooling/operations/instances/masks";
import {parseInstanceSet,INSTANCE_SET_MICRO_SCALE} from "asset-tooling/instance-set";
import {encodeRgba8Image,RGBA8_IMAGE_MEDIA_TYPE} from "asset-tooling/image/rgba8";
import {executeImageEncodePngOperation} from "asset-tooling/operations/image/codecs";
import {executeScalarColorRampOperation} from "asset-tooling/recipes/surface-textures";
import {createGltfImportOperationBuildIdentity} from "asset-tooling/operations/processing/gltf";
import {prepareRenderDerivativeRecipe,readRenderDerivativeRecipeSource,RENDER_DERIVATIVE_PRESETS} from "asset-tooling/recipes/render-derivatives";
import {exportAssetBundle,verifyAssetBundle,STATIC_ASSET_BUNDLE_PROFILE} from "asset-tooling/operations/bundle";
import {parseAssetSpec} from "../../src/schema.js";
import {canonicalJson} from "../../src/canonical.js";
import {sha256Bytes} from "../../src/hash.js";
import {writeIfChanged} from "../reconcile-file.js";

// Type only the already authoritative legacy calls used by this example.
const {executeMinimumDistanceScatterOperation}:{executeMinimumDistanceScatterOperation:(root:string,invocation:{parameters:unknown})=>Promise<AssetOperationResult>}=await import(new URL("../../src/scatter-operations.js",import.meta.url).href);
const {generateAsset,verifyAsset}:{generateAsset:(p:string)=>Promise<{receipt:{spec:{sha256:string};observations:unknown}}>;verifyAsset:(p:string)=>Promise<{status:string}>}=await import(new URL("../../src/core.js",import.meta.url).href);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),directory=path.join(root,".artifacts/instance-exclusion");
const recipeBytes=await readFile(new URL("./recipe.json",import.meta.url)),recipe:unknown=JSON.parse(recipeBytes.toString("utf8"));
function object(value:unknown):Record<string,unknown> {if(!value || typeof value!=="object" || Array.isArray(value)) throw new Error("invalid saved example record");return value as Record<string,unknown>;}
const p=object(recipe),scatter=object(p.scatter),rows=object(p.masks);
assert.equal(p.schemaVersion,1);assert.equal(p.sourceRockId,"angular");
const generated=await executeMinimumDistanceScatterOperation(root,{parameters:scatter}),source=createAssetRef(generated.outputs.output),set=parseInstanceSet(await resolveAssetObject(root,source));
const evidence:Record<string,unknown>={},meshes:AssetRef[]=[];
const renderer=await readRenderDerivativeRecipeSource(),script=await readFile(new URL("./assemble-review.py",import.meta.url)),scriptSha256=sha256Bytes(script);
const inventory=object(JSON.parse(await readFile(path.join(root,".artifacts/rocks/variants.json"),"utf8")));
if(!Array.isArray(inventory.variants)) throw new Error("run the existing rock example to supply its original master inventory");
const masterEntry=inventory.variants.map(object).find(v=>v.id===p.sourceRockId),master=createAssetRef(masterEntry?.mesh);
await createGltfImportOperationBuildIdentity(root,{inputs:{source:master},parameters:{resourceUris:[]}});
await mkdir(directory,{recursive:true});
let acceptedFraming:unknown;
const cold=await mkdtemp(path.join(tmpdir(),"instance-exclusion-example-"));
try {
 await writeIfChanged(path.join(directory,"candidates.json"),await resolveAssetObject(root,source));
 for(const name of ["path","edited"]) {
  const matrix=rows[name];assert.ok(Array.isArray(matrix) && matrix.length===7);
  assert.ok(matrix.every(row=>Array.isArray(row) && row.length===9 && row.every(v=>v===0 || v===255)));
  const values:number[]=matrix.flat(),mask=(await storeAssetObject(root,{kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,bytes:encodeRgba8Image({width:9,height:7,pixels:Buffer.from(values.flatMap(v=>[v,v,v,255]))}),
    metadata:{field:"exclusion",sampling:"data",channelColorSpace:"linear",sourceRecipeSha256:sha256Bytes(recipeBytes),sourceRegion:name}})).asset;
  const invocation={inputs:{source,mask},parameters:{maxCoverage:p.maxCoverage,maskBounds:set.bounds}},result=await executeInstanceExclusionMaskOperation(root,invocation),ref=createAssetRef(result.outputs.output);
  for(const input of [source,mask]) await storeAssetObject(cold,{kind:input.kind,mediaType:input.mediaType,metadata:input.metadata,bytes:await resolveAssetObject(root,input)});
  assert.deepEqual(await executeInstanceExclusionMaskOperation(cold,invocation),result);
  const selected=parseInstanceSet(await resolveAssetObject(root,ref));
  // Independent mapping over this fixed saved 12x8m/9x7 fixture; no candidate oracle.
  const expected=set.instances.filter(i=>{
   const x=Number((BigInt(i.positionMicro[0]+6_000_000)*8n+5_999_999n)/11_999_999n);
   const z=Number((BigInt(i.positionMicro[2]+4_000_000)*6n+3_999_999n)/7_999_999n);
   return values[z*9+x]!<=127;
  });
  assert.deepEqual(selected.instances,expected);
  await writeIfChanged(path.join(directory,`${name}.instances.json`),await resolveAssetObject(root,ref));
  const maskPng=createAssetRef((await executeImageEncodePngOperation(root,{inputs:{source:mask},parameters:{compressionLevel:9}})).outputs.output);
  await writeIfChanged(path.join(directory,`${name}.mask.png`),await resolveAssetObject(root,maskPng));
  const colored=createAssetRef((await executeScalarColorRampOperation(root,{inputs:{source:mask},parameters:{low:[67,108,52],high:[185,132,74]}})).outputs.output);
  const guide=createAssetRef((await executeImageEncodePngOperation(root,{inputs:{source:colored},parameters:{compressionLevel:9}})).outputs.output);
  const native=path.join(directory,name);await mkdir(native,{recursive:true});
  for(const [filename,bytes] of [["assemble-review.py",script],["master.glb",await resolveAssetObject(root,master)],["instances.json",await resolveAssetObject(root,ref)],["guide.png",await resolveAssetObject(root,guide)]] as const) await writeIfChanged(path.join(native,filename),bytes);
  const spec=parseAssetSpec({schemaVersion:1,assetId:`exclusion-review.${name}`,generator:{id:"external.blender.script",version:"1"},randomness:{mode:"none"},models:{},
   inputs:{script:{path:"assemble-review.py",sha256:scriptSha256},master:{path:"master.glb",sha256:master.sha256},instances:{path:"instances.json",sha256:ref.sha256},guide:{path:"guide.png",sha256:guide.sha256}},
   parameters:{blenderVersion:renderer.blenderVersion,arguments:{schemaVersion:1,width:scatter.width,depth:scatter.depth,scale:p.sourceRockScale,maxTriangles:p.maxTriangles}},
   output:{path:"scenery.glb"},reproducibility:{expected:"approximate"}});
  await writeIfChanged(path.join(native,"asset.json"),Buffer.from(canonicalJson(spec)+"\n"));
  const assembled=await generateAsset(path.join(native,"asset.json"));assert.equal((await verifyAsset(path.join(native,"asset.json"))).status,"exact");
  const bytes=await readFile(path.join(native,"scenery.glb")),document=await new NodeIO().setAllowNetwork(false).readBinary(bytes);
  assert.equal(document.getRoot().listMeshes().length,2,"one shared source mesh plus native review ground");
  for(const instance of selected.instances) {
   const node=document.getRoot().listNodes().find(n=>n.getName()===instance.id);assert.ok(node);
   const translation=node.getWorldTranslation();
   for(let axis=0;axis<3;axis++) assert.ok(Math.abs(translation[axis]!-instance.positionMicro[axis]!/INSTANCE_SET_MICRO_SCALE)<0.000001,"native saved placement within 1 micro-meter");
  }
  const mesh=(await storeAssetObject(root,{kind:"scene",mediaType:"model/gltf-binary",bytes,metadata:{purpose:"flat-cosmetic-exclusion-review",sourceSpecSha256:assembled.receipt.spec.sha256,
    originalMaster:{...master},sourceCandidates:{...source},selectedInstances:{...ref},mask:{...mask},guide:{...guide},sourceRecipeSha256:sha256Bytes(recipeBytes),sourceRockGeneratorsExecuted:0}})).asset;meshes.push(mesh);
  const render=await prepareRenderDerivativeRecipe(root,{assetId:`exclusion-render.${name}`,source:mesh,scriptSha256:renderer.sha256,blenderVersion:renderer.blenderVersion,
   parameters:{...RENDER_DERIVATIVE_PRESETS.thumbnail,width:768,height:512,samples:16,viewDirection:[0.8,1,1.1]}});
  await writeIfChanged(path.join(native,"render_static_glb.py"),renderer.bytes);await writeIfChanged(path.join(native,"source.glb"),render.sourceBytes);
  await writeIfChanged(path.join(native,"render.json"),Buffer.from(canonicalJson(render.spec)+"\n"));
  const rendered=await generateAsset(path.join(native,"render.json"));assert.equal((await verifyAsset(path.join(native,"render.json"))).status,"exact");
  const renderedScript=object(object(rendered.receipt.observations).script);
  assert.ok(renderedScript.sourceBoundsBlenderZUp && renderedScript.projectedBounds && renderedScript.projection);
  const framing={bounds:renderedScript.sourceBoundsBlenderZUp,projectedBounds:renderedScript.projectedBounds,projection:renderedScript.projection};
  if(name==="path") acceptedFraming=framing;else assert.deepEqual(framing,acceptedFraming,"same actual native camera framing");
  evidence[name]={mask,maskPng,colored,guide,result,mesh,framing,coldReplayMatches:true,nativePositionsMatch:true};console.log(JSON.stringify({name,sourceCount:set.instances.length,keptCount:selected.instances.length,sourceRockGeneratorsExecuted:0}));
 }
 const packaged=await exportAssetBundle(root,path.join(directory,"package"),{inputs:{assets:meshes},parameters:{profile:STATIC_ASSET_BUNDLE_PROFILE,assets:[{key:"cosmetic.path",variant:"review"},{key:"cosmetic.edited",variant:"review"}]}});
 await verifyAssetBundle(path.join(directory,"package"),packaged.manifest);
 await writeIfChanged(path.join(directory,"package.ref.json"),Buffer.from(canonicalJson(packaged.manifest)+"\n"));
 await writeIfChanged(path.join(directory,"evidence.json"),Buffer.from(canonicalJson({schemaVersion:1,recipe,source,master,evidence,sourceScatterOperationsExecuted:1,filteringCandidatesGenerated:0,sourceRockGeneratorsExecuted:0})+"\n"));
 console.log(JSON.stringify({packageBytesWritten:packaged.bytesWritten,renderReplays:2,assemblyReplays:2}));
} finally {await rm(cold,{recursive:true,force:true});}
