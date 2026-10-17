import {test} from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdtemp,readFile,rm,stat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {NodeIO} from "@gltf-transform/core";
import {createWeaponAssetSpec,normalizeWeaponParameters,readWeaponRecipeSource,WEAPON_MATERIALS,WEAPON_PRESETS,WEAPON_ROLES,
 WEAPON_TRIANGLE_BUDGETS,type WeaponPiece} from "../src/weapon-recipes.js";
import {storeAssetObject} from "../src/asset-store.js";
import {executeGltfImportOperation} from "../src/gltf-import-operations.js";

type Observations={piece:string;role:string;triangleCount:number;origin:string;unit:string;axes:string;gripNode:string;materials:string[];
 bounds:{min:number[];max:number[]}};
const {generateAsset,verifyAsset}:{generateAsset:(p:string)=>Promise<{cache:{status:string};receipt:{observations:{script:Observations}}}>;
 verifyAsset:(p:string)=>Promise<{status:string}>}=await import(new URL("../src/core.js",import.meta.url).href);
const source=await readWeaponRecipeSource();
const spec=(parameters:unknown)=>createWeaponAssetSpec({assetId:"weapon.fixture",parameters,scriptSha256:source.sha256,blenderVersion:source.blenderVersion});
const sword=WEAPON_PRESETS["sword.arming"],shield=WEAPON_PRESETS["shield.heater"];

const INVALID=[
 {...sword,piece:"sword.claymore"},{...sword,bladeLength:1.2},{...sword,bladeWidth:Infinity},{...sword,bladeThickness:.02},
 {...sword,bladeWidth:.03,bladeThickness:.011},{...sword,guardWidth:.12,bladeWidth:.07},{...sword,radialSegments:12.5},
 {...sword,radialSegments:true},{...sword,maxTriangles:2501},{...sword,maxTriangles:11},{...sword,schemaVersion:2},{...sword,extra:1},
 {...sword,width:.5},{...shield,width:.9},{...shield,height:.5,width:.56},{...shield,bossRadius:.15},{...shield,rimWidth:.075},
 {...shield,curvature:.2},{...shield,outlineSegments:5},{...shield,maxTriangles:3001},{...shield,thickness:NaN},
 Object.fromEntries(Object.entries(shield).filter(([k])=>k!=="rimWidth")),
];

test("weapon controls and asset specs are bounded and pinned",()=>{
 for(const p of Object.values(WEAPON_PRESETS)) {
  const s=spec(p);assert.deepEqual(s.parameters.arguments,p);assert.equal(s.reproducibility.expected,"exact");assert.equal(s.randomness.mode,"none");
  assert.deepEqual(s.inputs,{script:{path:"weapon.py",sha256:source.sha256}});
  assert.ok(p.maxTriangles<=WEAPON_TRIANGLE_BUDGETS[p.piece]);
 }
 assert.equal(Reflect.set(WEAPON_PRESETS["sword.arming"],"bladeLength",1),false);
 for(const bad of INVALID) assert.throws(()=>normalizeWeaponParameters(bad),Error,JSON.stringify(bad));
 assert.throws(()=>normalizeWeaponParameters([]));assert.throws(()=>normalizeWeaponParameters(null));
 assert.throws(()=>createWeaponAssetSpec({assetId:"weapon.fixture",parameters:sword,scriptSha256:source.sha256,blenderVersion:"5.2"}));
});

const blender=process.env.ASSET_TOOLING_BLENDER;
test("weapon Python and TypeScript reject the same controls before scene mutation",{skip:!blender,timeout:30000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),"weapon-controls-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const cases=[...Object.values(WEAPON_PRESETS),{...sword,fullerLength:0},{...shield,curvature:0},...INVALID];
 const expected=cases.map(p=>{try{normalizeWeaponParameters(p);return "accepted";}catch{return "rejected";}});
 const controls=path.join(root,"controls.json");await writeFile(controls,JSON.stringify(cases));
 const program=`import bpy,json,runpy,sys
recipe=runpy.run_path(sys.argv[-2]);before=set(bpy.data.objects);results=[]
for p in json.load(open(sys.argv[-1])):
 try: recipe['validate'](p,{});results.append('accepted')
 except (ValueError,TypeError):
  try: recipe['generate']('must-not-write.glb',p,{})
  except (ValueError,TypeError): pass
  else: raise AssertionError('invalid controls reached authoring')
  assert set(bpy.data.objects)==before
  results.append('rejected')
print('[weapon-controls]'+json.dumps(results))`;
 const run=spawnSync(blender!,["--background","--factory-startup","--threads","1","--python-exit-code","1","--python-expr",program,"--",
  fileURLToPath(new URL("../adapters/blender/weapon.py",import.meta.url)),controls],{encoding:"utf8",timeout:25000,env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"}});
 assert.equal(run.status,0,run.error?.message ?? run.stderr);
 const line=run.stdout.split("\n").find(l=>l.startsWith("[weapon-controls]"));assert.ok(line,run.stdout);
 assert.deepEqual(JSON.parse(line.slice("[weapon-controls]".length)),expected);
});

test("native weapons are budgeted, grip-anchored, metric GLBs that replay exactly",{skip:!blender,timeout:240000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),"weapon-native-"));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,"weapon.py"),source.bytes);
 const file=path.join(root,"asset.json"),output=path.join(root,"weapon.glb");
 for(const p of Object.values(WEAPON_PRESETS)) {
  const piece:WeaponPiece=p.piece;
  await writeFile(file,JSON.stringify(spec(p)));
  const generated=await generateAsset(file),bytes=await readFile(output),mtime=(await stat(output)).mtimeMs;
  assert.equal((await verifyAsset(file)).status,"exact");assert.equal((await generateAsset(file)).cache.status,"hit");assert.equal((await stat(output)).mtimeMs,mtime);
  const evidence=generated.receipt.observations.script;
  assert.deepEqual([evidence.piece,evidence.role,evidence.origin,evidence.unit,evidence.axes,evidence.gripNode],
   [piece,WEAPON_ROLES[piece],"grip","meter","right-handed-y-up","grip"]);
  const scene=(await new NodeIO().setAllowNetwork(false).readBinary(bytes)).getRoot();
  assert.deepEqual(scene.listMaterials().map(m=>m.getName()),[...WEAPON_MATERIALS[piece]]);
  for(const m of scene.listMaterials()) assert.ok([0,1].includes(m.getMetallicFactor()) && m.getRoughnessFactor()>0 && !m.getBaseColorTexture());
  const nodes=scene.listScenes()[0]!.listChildren();
  assert.deepEqual(nodes.map(n=>n.getName()).sort(),["grip",piece].sort());
  for(const node of nodes) {
   assert.deepEqual(node.getTranslation(),[0,0,0]);assert.deepEqual(node.getRotation(),[0,0,0,1]);assert.deepEqual(node.getScale(),[1,1,1]);
  }
  assert.equal(nodes.find(n=>n.getName()==="grip")!.getMesh(),null);
  let triangles=0;const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(const primitive of nodes.find(n=>n.getName()===piece)!.getMesh()!.listPrimitives()) {
   const position=primitive.getAttribute("POSITION")!;triangles+=primitive.getIndices()!.getCount()/3;
   assert.ok(primitive.getAttribute("NORMAL"));
   for(let i=0;i<position.getCount();i++) {
    const point:number[]=[];position.getElement(i,point);
    point.forEach((v,axis)=>{assert.ok(Number.isFinite(v));min[axis]=Math.min(min[axis]!,v);max[axis]=Math.max(max[axis]!,v);});
   }
  }
  assert.equal(triangles,evidence.triangleCount);assert.ok(triangles<=p.maxTriangles && triangles<=WEAPON_TRIANGLE_BUDGETS[piece]);
  for(let axis=0;axis<3;axis++) {
   assert.ok(Math.abs(min[axis]!-evidence.bounds.min[axis]!)<1e-4 && Math.abs(max[axis]!-evidence.bounds.max[axis]!)<1e-4,`bounds axis ${axis}`);
  }
  if(piece==="sword.arming") {
   // Metres: ~0.95 m overall, blade toward +Y from a grip at the origin, crossguard width along X.
   assert.ok(Math.abs(max[1]!-min[1]!-.95)<.02,`sword length ${max[1]!-min[1]!}`);
   assert.ok(max[1]!>.8 && min[1]!<-.09 && min[1]!>-.13);
   assert.ok(Math.abs(max[0]!-sword.guardWidth/2)<1e-4 && Math.abs(min[0]!+sword.guardWidth/2)<1e-4);
  } else {
   // Face toward +Z in front of the handle, point toward -Y, width along X.
   assert.ok(Math.abs(max[0]!-min[0]!-shield.width)<.02 && max[0]!-min[0]!>=shield.width);
   assert.ok(Math.abs(max[1]!-min[1]!-shield.height)<.04);
   assert.ok(max[2]!>.08 && min[2]!<0 && max[2]!<.15 && min[2]!>-.05);
  }
  await executeGltfImportOperation(root,{parameters:{},inputs:{source:(await storeAssetObject(root,{bytes,kind:"mesh",mediaType:"model/gltf-binary"})).asset}});
 }
 const previous=await readFile(output);
 await writeFile(file,JSON.stringify(spec({...sword,maxTriangles:12})));await assert.rejects(generateAsset(file),/maxTriangles/);
 assert.deepEqual(await readFile(output),previous);
});
