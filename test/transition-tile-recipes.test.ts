import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readdir,rm,stat} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";
import {executeTransitionTileKit,executeTransitionTileOperation,readTransitionTileConnection,canConnectTransitionTiles,transformTransitionCorners,findTransitionTile,TRANSITION_TILE_PRESET} from "../src/transition-tile-recipes.js";
import {resolveAssetObject} from "../src/asset-store.js";
import {createAssetRef} from "../src/operations.js";
import {parseRgba8Image,type Rgba8Image} from "../src/image-rgba8.js";
import {rotateRgba8QuarterTurns} from "../src/image-geometry.js";
import {executeSpriteAtlasOperation,parseSpriteAtlasManifest} from "../src/sprite-atlas-operations.js";

// Authored independently in NW,NE,SE,SW order; ports N/S run left→right,
// E/W run top→bottom. No producer helper constructs this oracle.
const ports: Record<string,readonly [string,string,string,string]>={
 "0000":["00","00","00","00"],"0001":["00","01","10","00"],
 "0010":["00","00","01","01"],"0011":["00","01","11","01"],
 "0100":["01","00","00","10"],"0101":["01","01","10","10"],
 "0110":["01","00","01","11"],"0111":["01","01","11","11"],
 "1000":["10","10","00","00"],"1001":["10","11","10","00"],
 "1010":["10","10","01","01"],"1011":["10","11","11","01"],
 "1100":["11","10","00","10"],"1101":["11","11","10","10"],
 "1110":["11","10","01","11"],"1111":["11","11","11","11"],
};
const edges=["north","west","south","east"] as const,opposite=[2,3,0,1];
function edge(image:Rgba8Image,direction:typeof edges[number]) {
 const pixels:number[]=[];
 for(let n=0;n<image.width;n++) {
  const x=direction==="west"?0:direction==="east"?image.width-1:n;
  const y=direction==="north"?0:direction==="south"?image.height-1:n;
  pixels.push(...image.pixels.subarray((y*image.width+x)*4,(y*image.width+x)*4+4));
 }
 return pixels;
}
async function inventory(root:string) {
 const files=(await readdir(root,{recursive:true,withFileTypes:true})).filter(e=>e.isFile());
 return Promise.all(files.map(async e=>{const name=path.join(e.parentPath,e.name),s=await stat(name);return [path.relative(root,name),s.size,s.mtimeMs] as const;})).then(a=>a.sort());
}

test("complete transition kit ports and actual boundaries match the independent finite table",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"transition-edges-"));
 try {
  const result=await executeTransitionTileKit(root,{...TRANSITION_TILE_PRESET,size:33});
  assert.deepEqual(result.tiles.map(t=>t.corners),Object.keys(ports).sort());
  const images=new Map<string,Rgba8Image>();
  for(const tile of result.tiles) {
   const c=readTransitionTileConnection(tile.image);
   assert.deepEqual(edges.map(e=>c.ports[e]),ports[tile.corners]);
   assert.deepEqual(c.origin,[0,0]);assert.deepEqual(c.dimensions,{pixels:[33,33],cells:[1,1]});
   assert.deepEqual(c.allowedRotations,[0,1,2,3]);assert.equal(c.mirroring,false);
   images.set(tile.corners,parseRgba8Image(await resolveAssetObject(root,tile.image)));
  }
  let compatible=0;
  for(const a of result.tiles) for(const b of result.tiles) for(let i=0;i<4;i++) {
   const expected=ports[a.corners]![i]===ports[b.corners]![opposite[i]!]!;
   assert.equal(canConnectTransitionTiles(a.image,b.image,edges[i]!),expected);
   const equal=JSON.stringify(edge(images.get(a.corners)!,edges[i]!))===JSON.stringify(edge(images.get(b.corners)!,edges[opposite[i]!]!));
   assert.equal(equal,expected,`${a.corners}/${b.corners}/${edges[i]}`);
   if(expected) compatible++;
  }
  assert.equal(compatible,256);
  assert.deepEqual([...images.get("0000")!.pixels.subarray(0,4)],[...TRANSITION_TILE_PRESET.soil,255]);
  assert.deepEqual([...images.get("1111")!.pixels.subarray(0,4)],[...TRANSITION_TILE_PRESET.grass,255]);
 } finally {await rm(root,{recursive:true,force:true});}
});

test("rotations preserve directional corner art and compose without permitting mirroring",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"transition-rotation-"));
 try {
  for(const size of [17,32,65,128]) {
   const result=await executeTransitionTileKit(root,{...TRANSITION_TILE_PRESET,size});
   const images=new Map(await Promise.all(result.tiles.map(async t=>[t.corners,parseRgba8Image(await resolveAssetObject(root,t.image))] as const)));
   for(const tile of result.tiles) for(let q=0;q<4;q++) {
    const rotated=transformTransitionCorners(tile.corners,{quarterTurns:q,mirror:false});
    assert.deepEqual(rotateRgba8QuarterTurns(images.get(tile.corners)!,q).pixels,images.get(rotated)!.pixels);
    for(let p=0;p<4;p++) assert.equal(transformTransitionCorners(rotated,{quarterTurns:p,mirror:false}),transformTransitionCorners(tile.corners,{quarterTurns:(p+q)%4,mirror:false}));
   }
  }
  assert.equal(transformTransitionCorners("1000",{quarterTurns:1,mirror:false}),"0100");
  assert.equal(transformTransitionCorners("1100",{quarterTurns:1,mirror:false}),"0110");
  assert.throws(()=>transformTransitionCorners("1000",{quarterTurns:0,mirror:true}),/mirror/i);
 } finally {await rm(root,{recursive:true,force:true});}
});

test("invalid recipe, selection and serialized ports fail closed; missing combinations are diagnosed",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"transition-invalid-"));
 try {
  for(const delta of [{size:16},{size:129},{size:1.5},{soil:[0,0,256]},{grass:[1,2]},{grass:TRANSITION_TILE_PRESET.soil},{schemaVersion:2},{seed:42}]) {
   await assert.rejects(executeTransitionTileKit(root,{...TRANSITION_TILE_PRESET,...delta}));
   assert.deepEqual(await inventory(root),[]);
  }
  for(const corners of [[],["0000","0000"],["0002"],["0000",null]]) {
   await assert.rejects(executeTransitionTileKit(root,TRANSITION_TILE_PRESET,{corners}));
   assert.deepEqual(await inventory(root),[]);
  }
  await assert.rejects(executeTransitionTileKit("relative",TRANSITION_TILE_PRESET),/absolute/);
  const result=await executeTransitionTileKit(root,TRANSITION_TILE_PRESET,{corners:["1000"]});
  const ref=result.tiles[0]!.image,c=readTransitionTileConnection(ref);
  for(const delta of [{ports:{...c.ports,north:"xx"}},{ports:{...c.ports,north:"00"}},{origin:[-1,0]},{unit:"meter"},{axes:"right-up"},{mirroring:true},{allowedRotations:[0,4]},{id:"other"},{dimensions:{pixels:[65,64],cells:[1,1]}}]) {
   assert.throws(()=>readTransitionTileConnection({...ref,metadata:{...ref.metadata,connection:{...c,...delta}}}));
  }
  const larger=await executeTransitionTileKit(root,{...TRANSITION_TILE_PRESET,size:128},{corners:["1000"]});
  assert.equal(canConnectTransitionTiles(ref,larger.tiles[0]!.image,"north"),false);
  const other=await executeTransitionTileKit(root,{...TRANSITION_TILE_PRESET,grass:[1,2,3]},{corners:["1000"]});
  assert.equal(canConnectTransitionTiles(ref,other.tiles[0]!.image,"south"),false);
  assert.throws(()=>findTransitionTile([ref],"0111"),/missing.*0111/);
  assert.throws(()=>findTransitionTile([ref,ref],"1000"),/duplicate/i);
  assert.deepEqual(findTransitionTile([ref],"1000"),ref);
 } finally {await rm(root,{recursive:true,force:true});}
});

test("selection order, unrelated addition, repeated execution and cold full replay preserve tile objects",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"transition-repeat-")),cold=await mkdtemp(path.join(tmpdir(),"transition-cold-"));
 try {
  const first=await executeTransitionTileKit(root,TRANSITION_TILE_PRESET,{corners:["1000","0110"]}),before=await inventory(root);
  const repeat=await executeTransitionTileKit(root,TRANSITION_TILE_PRESET,{corners:["0110","1000"]});
  assert.deepEqual(repeat.tiles,first.tiles);assert.deepEqual(repeat.recipe,first.recipe);
  assert.equal(repeat.execution.objectWrites,0);assert.equal(repeat.execution.objectBytesWritten,0);
  assert.equal(repeat.execution.verifiedExistingObjects,2);assert.equal(repeat.execution.tileOperations,2);
  assert.deepEqual(await inventory(root),before);
  assert.deepEqual(await executeTransitionTileKit(cold,TRANSITION_TILE_PRESET,{corners:["0110","1000"]}),first);
  const added=await executeTransitionTileKit(root,TRANSITION_TILE_PRESET,{corners:["0111","1000","0110"]});
  for(const old of first.tiles) assert.deepEqual(added.tiles.find(t=>t.corners===old.corners),old);
  const direct=await executeTransitionTileOperation(root,{parameters:{...TRANSITION_TILE_PRESET,corners:"1000"}});
  assert.deepEqual(createAssetRef(direct.outputs.image),findTransitionTile(first.tiles.map(t=>t.image),"1000"));
  const aborted=new AbortController();aborted.abort();
  const now=await inventory(root);await assert.rejects(executeTransitionTileKit(root,TRANSITION_TILE_PRESET,{signal:aborted.signal}));
  assert.deepEqual(await inventory(root),now);
 } finally {await rm(root,{recursive:true,force:true});await rm(cold,{recursive:true,force:true});}
});

test("soft transition pixels and both ascending/descending palette channels match a scalar oracle",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"transition-oracle-"));
 try {
  const recipe={schemaVersion:1,size:65,soil:[253,1,87],grass:[4,250,87]} as const;
  const result=await executeTransitionTileKit(root,recipe);
  let softened=0;
  for(const tile of result.tiles) {
   const image=parseRgba8Image(await resolveAssetObject(root,tile.image));
   for(let y=0;y<65;y++) for(let x=0;x<65;x++) {
    // Platform hypot instead of the integer-SDF implementation; explicit scalar
    // mask arithmetic and colors instead of any production image kernels.
    let outside=255;
    const centers=[[0,0],[64,0],[64,64],[0,64]];
    for(let i=0;i<4;i++) if(tile.corners[i]==="1") {
     const distance=Math.floor(Math.hypot(x-centers[i]![0]!,y-centers[i]![1]!))-48;
     const encoded=Math.max(0,Math.min(127,Math.round(distance*127/2)));
     const inverse=Math.round(encoded*255/127);
     outside=Math.round(outside*inverse/255);
    }
    const coverage=255-outside;
    if(coverage>0 && coverage<255) softened++;
    const expected=[4+Math.round(outside*249/255),1+Math.round(coverage*249/255),87,255],offset=(y*65+x)*4;
    assert.deepEqual([...image.pixels.subarray(offset,offset+4)],expected,`${tile.corners} (${x},${y})`);
   }
  }
  assert.ok(softened>100);
 } finally {await rm(root,{recursive:true,force:true});}
});

test("repacking changes layout while preserving complete original refs, logical pivots and extruded edges",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"transition-repack-"));
 try {
  const result=await executeTransitionTileKit(root,{...TRANSITION_TILE_PRESET,size:17});
  const pack=async(width:number,tiles:typeof result.tiles)=>{
   const output=await executeSpriteAtlasOperation(root,{inputs:{sprites:tiles.map(t=>t.image)},parameters:{width,maxHeight:1000,padding:2,extrusion:1,trim:true,
    sprites:tiles.map(t=>({id:readTransitionTileConnection(t.image).id,pivot:{x:0,y:0}}))}});
   return parseSpriteAtlasManifest(await resolveAssetObject(root,createAssetRef(output.outputs.manifest)));
  };
  const a=await pack(92,result.tiles),b=await pack(46,[...result.tiles].reverse());
  assert.notEqual(a.width,b.width);assert.notEqual(a.image.sha256,b.image.sha256);
  const ai=parseRgba8Image(await resolveAssetObject(root,a.image));
  for(let n=0;n<16;n++) {
   const first=a.sprites[n]!,second=b.sprites[n]!,source=result.tiles[n]!.image;
   assert.deepEqual(first.source,source);assert.deepEqual(second.source,source);
   assert.deepEqual(first.pivot,{x:0,y:0});assert.deepEqual(second.pivot,first.pivot);
   assert.deepEqual(first.sourceSize,{width:17,height:17});assert.deepEqual(first.trimOffset,{x:0,y:0});
   const original=parseRgba8Image(await resolveAssetObject(root,source));
   for(let y=-1;y<=17;y++) for(let x=-1;x<=17;x++) {
    const actual=((first.rect.y+y)*ai.width+first.rect.x+x)*4;
    const expected=(Math.max(0,Math.min(16,y))*17+Math.max(0,Math.min(16,x)))*4;
    assert.deepEqual(ai.pixels.subarray(actual,actual+4),original.pixels.subarray(expected,expected+4));
   }
  }
 } finally {await rm(root,{recursive:true,force:true});}
});
