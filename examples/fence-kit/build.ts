import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdir,readFile} from "node:fs/promises";
import {createFenceAssetSpec,evaluateFenceLayout,FENCE_CONNECTION_CONTRACT,FENCE_PRESETS,fencePortAnchor,fencePortsAfterRotation,readFenceRecipeSource,type FencePlacement} from "asset-tooling/recipes/fence";
import {type AssetRef} from "asset-tooling/operations";
import {storeAssetObject} from "asset-tooling/operations/store";
import {readRenderDerivativeRecipeSource,RENDER_DERIVATIVE_PRESETS} from "asset-tooling/recipes/render-derivatives";
import {canonicalJson} from "../../src/canonical.js";
import {writeIfChanged} from "../reconcile-file.js";
import {generateAsset,verifyAsset,inspectNativeVegetationMesh,renderNativeVegetationPreview,packageNativeVegetation} from "../native-vegetation.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),directory=path.join(root,".artifacts/fence-kit");
const source=await readFenceRecipeSource(),renderer=await readRenderDerivativeRecipeSource();
const meshes:Record<string,AssetRef>={},images:Record<string,AssetRef>={},evidence:Record<string,unknown>={};
await mkdir(directory,{recursive:true});
for(const [id,parameters] of Object.entries(FENCE_PRESETS)) {
 const workspace=path.join(directory,id);await mkdir(workspace,{recursive:true});
 await writeIfChanged(path.join(workspace,"fence.py"),source.bytes);
 const spec=createFenceAssetSpec({assetId:`fence.${id}`,parameters,scriptSha256:source.sha256,blenderVersion:source.blenderVersion});
 const specPath=path.join(workspace,"asset.json");await writeIfChanged(specPath,Buffer.from(canonicalJson(spec)+"\n"));
 const generated=await generateAsset(specPath);assert.equal((await verifyAsset(specPath)).status,"exact");
 const mesh=(await storeAssetObject(root,{bytes:await readFile(path.join(workspace,"fence.glb")),kind:"mesh",mediaType:"model/gltf-binary",
  metadata:{generator:"external.blender.script@1",recipe:"fence-v1",presetId:id,scriptSha256:source.sha256,sourceSpecSha256:generated.receipt.spec.sha256,
   ports:fencePortsAfterRotation(parameters.piece,0).map(direction=>({direction,anchor:fencePortAnchor(direction,parameters.cellSize)}))}})).asset;
 const {imported,bounds}=await inspectNativeVegetationMesh(root,mesh,parameters.maxTriangles);
 assert.ok(Math.abs(bounds.min[1]!)<1e-5 && bounds.max[0]!<=parameters.cellSize/2+1e-5 && bounds.min[0]!>=-parameters.cellSize/2-1e-5);
 meshes[id]=mesh;evidence[id]={receipt:generated.receipt,imported,bounds};
 const rendered=await renderNativeVegetationPreview({root,directory,renderer,prefix:"fence",id,mesh,
  parameters:{...RENDER_DERIVATIVE_PRESETS.icon,width:384,height:384,samples:16,padding:.04,
   framing:{type:"shared-orthographic",center:[0,.55,0],horizontalSpan:3.4,pivot:[0,0,0]}}});
 images[id]=rendered.image;evidence[`${id}-render`]={receipt:rendered.receipt};
}
// A 3x2 pen with a tee branch: the reference evaluator must report no mismatches or open ends.
const pen:FencePlacement[]=[
 {id:"nw",piece:"corner",cell:[0,0],quarterTurns:3},{id:"n",piece:"tee",cell:[1,0],quarterTurns:0},{id:"ne",piece:"corner",cell:[2,0],quarterTurns:2},
 {id:"sw",piece:"corner",cell:[0,1],quarterTurns:0},{id:"s",piece:"straight",cell:[1,1],quarterTurns:0},{id:"se",piece:"corner",cell:[2,1],quarterTurns:1},
 {id:"post",piece:"end",cell:[1,-1],quarterTurns:3},
];
const layout=evaluateFenceLayout(pen);assert.deepEqual([layout.mismatches,layout.openEnds],[[],[]]);
const packaged=await packageNativeVegetation(root,directory,"fence",meshes,images);
await writeIfChanged(path.join(directory,"layout.json"),Buffer.from(canonicalJson({schemaVersion:1,contract:FENCE_CONNECTION_CONTRACT,placements:pen,report:layout})+"\n"));
await writeIfChanged(path.join(directory,"evidence.json"),Buffer.from(canonicalJson({schemaVersion:1,evidence,distributionFiles:packaged.files,consumerPlacementAuthority:false})+"\n"));
console.log(JSON.stringify({pieces:Object.keys(meshes).length,connections:layout.connections.length,packageFiles:packaged.files.length,packageBytesWritten:packaged.bytesWritten}));
