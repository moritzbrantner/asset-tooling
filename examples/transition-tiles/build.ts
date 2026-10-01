import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdir,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {TRANSITION_TILE_PRESET,executeTransitionTileKit,readTransitionTileConnection,canConnectTransitionTiles,findTransitionTile} from "asset-tooling/recipes/transition-tiles";
import {executeSpriteAtlasOperation,parseSpriteAtlasManifest} from "asset-tooling/operations/image/atlas";
import {executeImageEncodePngOperation,createImageEncodePngOperationBuildIdentity} from "asset-tooling/operations/image/codecs";
import {createAssetRef,type AssetRef} from "asset-tooling/operations";
import {resolveAssetObject} from "asset-tooling/operations/store";
import {exportAssetBundle,verifyAssetBundle,readAssetBundleSpriteAtlas,SPRITE_ATLAS_BUNDLE_PROFILE} from "asset-tooling/operations/bundle";
import {canonicalJson} from "../../src/canonical.js";
import {writeIfChanged} from "../reconcile-file.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),directory=path.join(root,".artifacts/transition-tiles");
await mkdir(directory,{recursive:true});
const cold=await mkdtemp(path.join(tmpdir(),"transition-kit-example-"));
// Authored finite composition, not a map-generation or gameplay decision API.
const vertices=["00000","01110","01010","01110","00000"];
const grid=[["0010","0011","0011","0001"],["0110","1101","1110","1001"],
 ["0110","1011","0111","1001"],["0100","1100","1100","1000"]];
const selected=[...new Set(grid.flat())].sort();
async function atlas(store:string,tiles:{corners:string;image:AssetRef}[],columns:number) {
 const cell=TRANSITION_TILE_PRESET.size+6;
 const invocation={inputs:{sprites:tiles.map(t=>t.image)},parameters:{width:columns*cell,maxHeight:Math.ceil(tiles.length/columns)*cell,padding:2,extrusion:1,trim:true,
  sprites:tiles.map(t=>({id:readTransitionTileConnection(t.image).id,pivot:{x:0,y:0}}))}};
 const result=await executeSpriteAtlasOperation(store,invocation),manifest=createAssetRef(result.outputs.manifest),image=createAssetRef(result.outputs.image);
 const pngInvocation={inputs:{source:image},parameters:{compressionLevel:9}},encoded=await executeImageEncodePngOperation(store,pngInvocation);
 return {result,manifest,png:createAssetRef(encoded.outputs.output),pngBuild:await createImageEncodePngOperationBuildIdentity(store,pngInvocation)};
}
try {
 const full=await executeTransitionTileKit(root,TRANSITION_TILE_PRESET),freshFull=await executeTransitionTileKit(cold,TRANSITION_TILE_PRESET);
 assert.deepEqual(full.tiles,freshFull.tiles);
 const subset=await executeTransitionTileKit(root,TRANSITION_TILE_PRESET,{corners:[...selected].reverse()});
 assert.equal(subset.execution.objectWrites,0);assert.equal(subset.execution.verifiedExistingObjects,12);
 for(const tile of subset.tiles) {assert.deepEqual(tile,full.tiles.find(t=>t.corners===tile.corners));}
 const complete=await atlas(root,full.tiles,4),packed=await atlas(root,subset.tiles,4),fresh=await atlas(cold,subset.tiles,4);
 assert.deepEqual(packed,fresh);
 const repacked=await atlas(root,[...subset.tiles].reverse(),3);
 for(const a of [packed,repacked]) {
  const document=parseSpriteAtlasManifest(await resolveAssetObject(root,a.manifest));
  assert.deepEqual(document.sprites.map(s=>s.source),subset.tiles.map(t=>t.image));
 }
 const refs=subset.tiles.map(t=>t.image);
 for(let y=0;y<4;y++) {
 for(let x=0;x<4;x++) {
  assert.equal(grid[y]![x],vertices[y]![x]!+vertices[y]![x+1]!+vertices[y+1]![x+1]!+vertices[y+1]![x]!);
  const tile=findTransitionTile(refs,grid[y]![x]);
  if(x<3) {assert.equal(canConnectTransitionTiles(tile,findTransitionTile(refs,grid[y]![x+1]),"east"),true);}
  if(y<3) {assert.equal(canConnectTransitionTiles(tile,findTransitionTile(refs,grid[y+1]![x]),"south"),true);}
 }
 }
 assert.throws(()=>findTransitionTile(refs,"1010"),/missing.*1010/);
 const invocation={parameters:{profile:SPRITE_ATLAS_BUNDLE_PROFILE,assets:[{key:"ground-transition",variant:"island"}]},inputs:{assets:[packed.manifest],images:[packed.png]}};
 const packaged=await exportAssetBundle(root,path.join(directory,"package"),invocation);
 const freshPackage=await exportAssetBundle(cold,path.join(cold,"package"),invocation);
 assert.deepEqual(freshPackage.manifest,packaged.manifest);
 const verified=await verifyAssetBundle(path.join(directory,"package"),packaged.manifest,{profile:SPRITE_ATLAS_BUNDLE_PROFILE});
 assert.equal(verified.manifest.resources.length,13); // Selected twelve sprites plus the original atlas image.
 await rm(path.join(cold,".asset-tooling"),{recursive:true,force:true});
 const coldVerified=await verifyAssetBundle(path.join(cold,"package"),freshPackage.manifest,{profile:SPRITE_ATLAS_BUNDLE_PROFILE});
 const loaded=await readAssetBundleSpriteAtlas(path.join(cold,"package"),coldVerified.manifest,"ground-transition","island");
 assert.deepEqual(loaded.atlas,parseSpriteAtlasManifest(await resolveAssetObject(root,packed.manifest)));
 assert.deepEqual(loaded.png,await resolveAssetObject(root,packed.png));
 assert.deepEqual(loaded.atlas.sprites.map(s=>readTransitionTileConnection(s.source)),subset.tiles.map(t=>readTransitionTileConnection(t.image)));
 for(const [name,png] of [["complete.png",complete.png],["selected.png",packed.png],["repacked.png",repacked.png]] as const) {
  await writeIfChanged(path.join(directory,name),await resolveAssetObject(root,png));
 }
 // Pin review inputs through the public resolver; the inspector never infers store paths.
 const reviewInputs:Record<string,string>={};
 await mkdir(path.join(directory,"review-inputs"),{recursive:true});
 for(const ref of [...full.tiles.map(t=>t.image),...[complete,packed,repacked].flatMap(a=>[a.manifest,createAssetRef(a.result.outputs.image)])]) {
  const portable=`review-inputs/${ref.sha256}.json`;
  reviewInputs[ref.sha256]=portable;
  await writeIfChanged(path.join(directory,...portable.split("/")),await resolveAssetObject(root,ref));
 }
 await writeIfChanged(path.join(directory,"package.ref.json"),Buffer.from(canonicalJson(packaged.manifest)+"\n"));
 const {execution:_fullExecution,...fullEvidence}=full,{execution:_subsetExecution,...subsetEvidence}=subset;
 await writeIfChanged(path.join(directory,"evidence.json"),Buffer.from(canonicalJson({schemaVersion:1,vertices,grid,full:fullEvidence,selected:subsetEvidence,
  complete,packed,repacked,reviewInputs,package:packaged.manifest,distributionFiles:packaged.files,coldPackageMatches:true,loadsWithoutSourceStore:true})+"\n"));
 console.log(JSON.stringify({completeTiles:full.tiles.length,selectedTiles:subset.tiles.length,fullExecution:full.execution,selectionExecution:subset.execution,
  packageBytesWritten:packaged.bytesWritten,distributionFiles:packaged.files.length,coldPackageMatches:true,loadsWithoutSourceStore:true,placementEvaluations:0}));
} finally {await rm(cold,{recursive:true,force:true});}
