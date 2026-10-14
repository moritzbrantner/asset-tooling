import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolveAssetObject,storeAssetObject} from "../src/asset-store.js";
import {parseRgba8Image,encodeRgba8Image,RGBA8_IMAGE_MEDIA_TYPE} from "../src/image-rgba8.js";
import {SURFACE_TEXTURE_PRESETS,executeSurfaceTextureRecipe,executePreservedSurfaceTextureRecipe,type SurfaceTexturePreservation} from "../src/surface-texture-recipes.js";
import {executeNormalFromHeightOperation} from "../src/procedural-texture-operations.js";
import {createAssetRef} from "../src/operations.js";

// Acceptance for docs/surface-textures.md "Bark, grass and sand" (#131).
type Recipe=Record<string,unknown>&{width:number;height:number;low:readonly number[];high:readonly number[]};
const presets=SURFACE_TEXTURE_PRESETS as unknown as Record<string,Recipe|undefined>;
function preset(name:string):Recipe {
 const value=presets[name];
 assert.ok(value,`missing surface preset ${name}`);
 return value;
}

const BARK=["bark-ridged","bark-deep","bark-fine"],GRASS=["grass-short","grass-dense","grass-windswept"],SAND=["sand-fine","sand-rippled","sand-coarse"];
const NEW=[...BARK,...GRASS,...SAND];
const common={schemaVersion:1,seamMode:"repeat",seed:"42",width:256,height:256,heightMin:0,heightMax:255};
const bark={...common,low:[46,34,26],high:[122,98,74],roughnessMin:190,roughnessMax:250,gridX:12,gridY:2,detailGridX:48,detailGridY:8,detailWeight:90};
const grass={...common,low:[52,82,34],high:[118,156,70],roughnessMin:200,roughnessMax:245};
const sand={...common,low:[176,150,108],high:[226,204,160],roughnessMin:200,roughnessMax:240};
const DOCUMENTED:Record<string,Record<string,unknown>>={
 "bark-ridged":{...bark,furrows:{axis:"x",count:12,depth:160,softness:2},normalStrength:4},
 "bark-deep":{...bark,furrows:{axis:"x",count:8,depth:220,softness:1},normalStrength:6},
 "bark-fine":{...bark,furrows:{axis:"x",count:24,depth:120,softness:2},normalStrength:3},
 "grass-short":{...grass,gridX:16,gridY:16,detailGridX:128,detailGridY:128,detailWeight:150,normalStrength:2},
 "grass-dense":{...grass,gridX:24,gridY:24,detailGridX:128,detailGridY:128,detailWeight:200,normalStrength:3},
 "grass-windswept":{...grass,gridX:4,gridY:32,detailGridX:8,detailGridY:128,detailWeight:140,normalStrength:2},
 "sand-fine":{...sand,gridX:16,gridY:16,detailGridX:128,detailGridY:128,detailWeight:60,normalStrength:1},
 "sand-rippled":{...sand,gridX:8,gridY:8,detailGridX:128,detailGridY:128,detailWeight:60,furrows:{axis:"y",count:12,depth:120,softness:3},normalStrength:2},
 "sand-coarse":{...sand,gridX:8,gridY:8,detailGridX:64,detailGridY:64,detailWeight:140,normalStrength:2},
};

// Values of the fifteen earlier presets at 26b1b7a; the slice must leave them untouched.
const earlierBase={...common,gridX:8,gridY:8,detailGridX:64,detailGridY:64,detailWeight:80,low:[38,23,12],high:[145,102,58],normalStrength:2,roughnessMin:180,roughnessMax:240};
const wood={low:[52,27,12],high:[179,115,55],detailWeight:40,normalStrength:1,roughnessMin:130,roughnessMax:210};
const paper={low:[231,226,215],high:[247,244,237],detailWeight:180,normalStrength:1,roughnessMin:220,roughnessMax:245};
const EARLIER:Record<string,Record<string,unknown>>={
 "soil-fine":{...earlierBase,gridX:16,gridY:16,detailWeight:100},
 "soil-coarse":{...earlierBase,gridX:6,gridY:6,detailWeight:130,normalStrength:4},
 "soil-directional":{...earlierBase,gridX:3,gridY:24,detailWeight:60,normalStrength:3},
 "soil-tilled-shallow":{...earlierBase,furrows:{axis:"x",count:4,depth:140,softness:3},normalStrength:2},
 "soil-tilled-deep":{...earlierBase,furrows:{axis:"x",count:4,depth:200,softness:3},normalStrength:4},
 "soil-tilled-crosswise":{...earlierBase,furrows:{axis:"y",count:8,depth:180,softness:3},normalStrength:3},
 "rock-smooth":{...earlierBase,low:[55,59,62],high:[160,164,166],detailWeight:30,normalStrength:1,roughnessMin:110,roughnessMax:180},
 "rock-grainy":{...earlierBase,low:[55,59,62],high:[160,164,166],detailWeight:160,normalStrength:4},
 "rock-layered":{...earlierBase,low:[62,54,44],high:[171,152,126],gridX:24,gridY:2,detailWeight:50,normalStrength:3},
 "wood-long-grain":{...earlierBase,...wood,gridX:24,gridY:1,detailGridX:96,detailGridY:2},
 "wood-short-grain":{...earlierBase,...wood,gridX:24,gridY:6,detailGridX:96,detailGridY:12},
 "wood-cross-grain":{...earlierBase,...wood,gridX:1,gridY:24,detailGridX:2,detailGridY:96},
 "paper-fine":{...earlierBase,...paper,gridX:16,gridY:16,detailGridX:128,detailGridY:128},
 "paper-coarse":{...earlierBase,...paper,gridX:8,gridY:8,detailGridX:32,detailGridY:32},
 "paper-fibers":{...earlierBase,...paper,gridX:2,gridY:32,detailGridX:4,detailGridY:128},
};

function assertDeeplyFrozen(value:unknown,where:string) {
 if(typeof value!=="object"||value===null) return;
 assert.ok(Object.isFrozen(value),`${where} is frozen`);
 for(const [key,nested] of Object.entries(value)) assertDeeplyFrozen(nested,`${where}.${key}`);
}

async function workspace(run:(root:string)=>Promise<void>) {
 const root=await mkdtemp(path.join(tmpdir(),"natural-ground-"));
 try {await run(root);} finally {await rm(root,{recursive:true,force:true});}
}

type Image=ReturnType<typeof parseRgba8Image>;
// Wrapped neighbour differences, as in the wood test: x sums changes across columns, y across rows.
function variation(image:Image) {
 let x=0,y=0;
 for(let row=0;row<image.height;row++) for(let column=0;column<image.width;column++) {
  const v=image.pixels[(row*image.width+column)*4]!;
  x+=Math.abs(v-image.pixels[(row*image.width+(column+1)%image.width)*4]!);
  y+=Math.abs(v-image.pixels[(((row+1)%image.height)*image.width+column)*4]!);
 }
 return {x,y};
}
// Mean height per column (axis x) or per row (axis y): the furrow cross-section survives, noise averages down.
function profile(image:Image,axis:"x"|"y") {
 const length=axis==="x"?image.width:image.height,across=axis==="x"?image.height:image.width,values=new Array<number>(length).fill(0);
 for(let row=0;row<image.height;row++) for(let column=0;column<image.width;column++) values[axis==="x"?column:row]!+=image.pixels[(row*image.width+column)*4]!/across;
 return values;
}
// Single-sided DFT amplitude for whole cycles per tile, 1..floor(n/2).
function spectrum(values:number[]) {
 const n=values.length,mean=values.reduce((a,b)=>a+b,0)/n,amplitudes=[0];
 for(let k=1;k<=Math.floor(n/2);k++) {
  let re=0,im=0;
  for(let i=0;i<n;i++) {re+=(values[i]!-mean)*Math.cos(2*Math.PI*k*i/n);im-=(values[i]!-mean)*Math.sin(2*Math.PI*k*i/n);}
  amplitudes.push(Math.hypot(re,im)*2/n);
 }
 return amplitudes;
}
const dominant=(amplitudes:number[])=>amplitudes.reduce((best,a,k)=>a>amplitudes[best]!?k:best,1);

test("nine bark/grass/sand presets are deeply frozen with exactly the documented parameters",()=>{
 for(const name of NEW) {
  const p=preset(name);
  assert.deepEqual(p,DOCUMENTED[name],`${name} parameters`);
  assertDeeplyFrozen(p,name);
  assert.equal(Reflect.set(p.low,"0",0),false);
  if(!("furrows" in DOCUMENTED[name]!)) assert.equal(Object.hasOwn(p,"furrows"),false,`${name} has no furrows`);
 }
 assert.deepEqual(new Set(Object.keys(SURFACE_TEXTURE_PRESETS)),new Set([...Object.keys(EARLIER),...NEW]),"twenty-four exported presets");
});

test("earlier fifteen presets keep their parameters",()=>{
 // Their pixels are pinned by the wood, tilled-soil, paper and surface-texture fixtures.
 for(const [name,expected] of Object.entries(EARLIER)) assert.deepEqual(presets[name],expected,name);
});

test("each family shares seed, palette, ranges and size and differs only in its named controls",()=>{
 for(const [family,names,controls] of [
  ["bark",BARK,["furrows","normalStrength"]],
  ["grass",GRASS,["detailGridX","detailWeight","gridX","gridY","normalStrength"]],
  ["sand",SAND,["detailGridX","detailGridY","detailWeight","furrows","gridX","gridY","normalStrength"]],
 ] as const) {
  const recipes=names.map(preset),changed=new Set<string>();
  for(const recipe of recipes) for(const key of new Set([...Object.keys(recipes[0]!),...Object.keys(recipe)])) {
   if(JSON.stringify(recipe[key])!==JSON.stringify(recipes[0]![key])) changed.add(key);
  }
  assert.deepEqual([...changed].sort(),[...controls],`${family} varies only its pattern controls`);
  for(const recipe of recipes) assert.equal(recipe.seed,"42");
  assert.equal(new Set(recipes.map(r=>JSON.stringify(r))).size,3,`${family} variants are distinct`);
 }
});

test("bark ridges run vertically; deep has fewer stronger ridges and fine more shallower ones",()=>workspace(async root=>{
 // 97 columns hold 48 detail cycles and 24 furrow cycles, so no grid reduction is needed.
 const ridges:Record<string,{count:number;amplitude:number}>={};
 for(const [name,count] of [["bark-ridged",12],["bark-deep",8],["bark-fine",24]] as const) {
  const result=await executeSurfaceTextureRecipe(root,{...preset(name),width:97,height:37},{channels:["height"]});
  const image=parseRgba8Image(await resolveAssetObject(root,result.outputs.height!));
  const v=variation(image);
  assert.ok(v.x>8*v.y,`${name} varies across x much more than along the trunk (x=${v.x}, y=${v.y})`);
  const columns=spectrum(profile(image,"x"));
  assert.equal(dominant(columns),count,`${name} shows ${count} ridges per tile`);
  ridges[name]={count:dominant(columns),amplitude:columns[count]!};
 }
 assert.ok(ridges["bark-deep"]!.count<ridges["bark-ridged"]!.count&&ridges["bark-ridged"]!.count<ridges["bark-fine"]!.count);
 assert.ok(ridges["bark-deep"]!.amplitude>1.3*ridges["bark-ridged"]!.amplitude,"deep ridges are deeper than the default");
 assert.ok(ridges["bark-ridged"]!.amplitude>ridges["bark-fine"]!.amplitude,"fine ridges are shallower than the default");
}));

test("grass turf is isotropic while windswept grass is combed along one direction",()=>workspace(async root=>{
 const ratio:Record<string,number>={};
 for(const name of GRASS) {
  const result=await executeSurfaceTextureRecipe(root,{...preset(name),width:129,height:131},{channels:["height"]});
  const v=variation(parseRgba8Image(await resolveAssetObject(root,result.outputs.height!)));
  ratio[name]=v.y/v.x;
 }
 for(const name of ["grass-short","grass-dense"]) assert.ok(ratio[name]!>0.8&&ratio[name]!<1.25,`${name} is isotropic (y/x=${ratio[name]})`);
 assert.ok(ratio["grass-windswept"]!>4,`windswept concentrates variation on y (y/x=${ratio["grass-windswept"]})`);
 assert.ok(ratio["grass-windswept"]!>4*ratio["grass-short"]!,"windswept is directional relative to short turf");
}));

test("rippled sand shows horizontal ripple rows relative to fine sand",()=>workspace(async root=>{
 const images:Record<string,Image>={};
 for(const name of SAND) {
  const result=await executeSurfaceTextureRecipe(root,{...preset(name),width:129,height:131},{channels:["height"]});
  images[name]=parseRgba8Image(await resolveAssetObject(root,result.outputs.height!));
 }
 const ratio=(name:string)=>{const v=variation(images[name]!);return v.y/v.x;};
 assert.ok(ratio("sand-fine")>0.8&&ratio("sand-fine")<1.25,"fine sand is isotropic");
 assert.ok(ratio("sand-rippled")>2*ratio("sand-fine"),"ripples make variation along y dominate");
 const rows=spectrum(profile(images["sand-rippled"]!,"y")),fineRows=spectrum(profile(images["sand-fine"]!,"y"));
 assert.equal(dominant(rows),12,"twelve ripple rows per tile");
 assert.ok(rows[12]!>3*fineRows[12]!,"ripple rows are absent from fine sand");
 assert.notEqual(dominant(spectrum(profile(images["sand-rippled"]!,"x"))),12,"ripples do not run across x");
}));

test("every new preset cold-replays and recolors with one executed and five reused operations",()=>workspace(async root=>{
 const sizes:Record<string,[number,number]>={bark:[97,37],grass:[129,131],sand:[129,131]};
 for(const name of NEW) {
  const [width,height]=sizes[name.split("-")[0]!]!;
  const recipe={...preset(name),width,height},accepted=await executeSurfaceTextureRecipe(root,recipe);
  await workspace(async cold=>{assert.deepEqual(await executeSurfaceTextureRecipe(cold,recipe),accepted,`${name} cold replay`);});
  const preserve:SurfaceTexturePreservation={};
  for(const channel of ["height","normal","roughness"] as const) {
   const step=accepted.steps.find(s=>s.output.metadata.field===channel);assert.ok(step);preserve[channel]=step;
  }
  const recolored={...recipe,low:[20,20,60],high:[200,210,250]},partial=await executePreservedSurfaceTextureRecipe(root,recolored,{preserve});
  assert.equal(partial.execution.executedOperations,1,`${name} executes only the color stage`);
  assert.equal(partial.execution.reusedOperations,5,`${name} reuses height, normal and roughness`);
  for(const channel of ["height","normal","roughness"] as const) assert.deepEqual(partial.outputs[channel],accepted.outputs[channel]);
  assert.notEqual(partial.outputs.color!.sha256,accepted.outputs.color!.sha256);
  const {execution:_execution,...canonical}=partial;
  await workspace(async cold=>{assert.deepEqual(await executeSurfaceTextureRecipe(cold,recolored),canonical,`${name} recolor cold replay`);});
 }
}));

test("odd-size bark and sand furrow normals wrap like an independently repeated height tile",()=>workspace(async root=>{
 // Small-size rule: grids and furrow counts are reduced explicitly; every other control stays documented.
 for(const [name,width,height,reduced] of [
  ["bark-deep",17,13,{gridX:4,gridY:2,detailGridX:8,detailGridY:4,furrows:{axis:"x",count:4,depth:220,softness:1}}],
  ["sand-rippled",13,17,{gridX:4,gridY:4,detailGridX:8,detailGridY:8,furrows:{axis:"y",count:4,depth:120,softness:3}}],
 ] as const) {
  const recipe={...preset(name),width,height,...reduced};
  const result=await executeSurfaceTextureRecipe(root,recipe,{channels:["height","normal"]});
  const tile=parseRgba8Image(await resolveAssetObject(root,result.outputs.height!)),normal=parseRgba8Image(await resolveAssetObject(root,result.outputs.normal!));
  const w=tile.width*3,h=tile.height*3,pixels=Buffer.alloc(w*h*4);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
   const from=((y%tile.height)*tile.width+x%tile.width)*4;tile.pixels.copy(pixels,(y*w+x)*4,from,from+4);
  }
  const source=(await storeAssetObject(root,{kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,bytes:encodeRgba8Image({width:w,height:h,pixels})})).asset;
  const independent=parseRgba8Image(await resolveAssetObject(root,createAssetRef((await executeNormalFromHeightOperation(root,{inputs:{source},parameters:{strength:preset(name).normalStrength as number,wrap:false}})).outputs.output)));
  for(let y=0;y<tile.height;y++) for(let x=0;x<tile.width;x++) {
   const at=((y+tile.height)*w+x+tile.width)*4;
   assert.deepEqual(normal.pixels.subarray((y*tile.width+x)*4,(y*tile.width+x)*4+4),independent.pixels.subarray(at,at+4),`${name} normal at ${x},${y}`);
  }
  assert.equal(result.outputs.normal!.metadata.normalYAxis,"negative");
 }
}));
