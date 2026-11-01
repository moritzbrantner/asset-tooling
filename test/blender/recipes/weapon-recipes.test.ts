import {test} from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdtemp,readFile,rm,stat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {NodeIO} from "@gltf-transform/core";
import {createWeaponAssetSpec,normalizeWeaponParameters,readWeaponRecipeSource,WEAPON_ALPHA_MATERIALS,WEAPON_LOD_PRESETS,WEAPON_MATERIALS,
 WEAPON_PRESETS,WEAPON_ROLES,WEAPON_EMISSIVE_MATERIALS,WEAPON_STAFFS,WEAPON_THROWABLES,WEAPON_TRIANGLE_BUDGETS,type WeaponPiece} from "../../../src/weapon-recipes.js";
import {storeAssetObject} from "../../../src/asset-store.js";
import {executeGltfImportOperation} from "../../../src/gltf-import-operations.js";
import {createHumanoidItemDescriptor,humanoidAttachmentMatrix,validateHumanoidSocketDescriptor} from "../../../src/humanoid-sockets.js";

type Observations={piece:string;role:string;triangleCount:number;origin:string;unit:string;axes:string;gripNode:string;materials:string[];
 bounds:{min:number[];max:number[]}};
const {generateAsset,verifyAsset}:{generateAsset:(p:string)=>Promise<{cache:{status:string};receipt:{observations:{script:Observations}}}>;
 verifyAsset:(p:string)=>Promise<{status:string}>}=await import(new URL("../../../src/core.js",import.meta.url).href);
const source=await readWeaponRecipeSource();
const spec=(parameters:unknown)=>createWeaponAssetSpec({assetId:"weapon.fixture",parameters,scriptSha256:source.sha256,blenderVersion:source.blenderVersion});
const sword=WEAPON_PRESETS["sword.arming"],shield=WEAPON_PRESETS["shield.heater"],dagger=WEAPON_PRESETS["dagger.blackened"],staff=WEAPON_PRESETS["staff.gnarled"];
const mace=WEAPON_PRESETS["mace.flanged"],book=WEAPON_PRESETS["book.tome"];
const knife=WEAPON_PRESETS["throwing-knife"],flask=WEAPON_PRESETS["venom-flask"],bomb=WEAPON_PRESETS["blasting-bomb"];
// Every preset and every throwable level (#467).
const BUILDS=[...Object.values(WEAPON_PRESETS),...WEAPON_THROWABLES.flatMap(piece=>Object.values(WEAPON_LOD_PRESETS[piece]))];
const rangerSockets=validateHumanoidSocketDescriptor(JSON.parse(await readFile(new URL("../../../assets/descriptors/humanoid.ranger.male.sockets.json",import.meta.url),"utf8")));
const apply=(m:number[],[x,y,z]:number[])=>[0,1,2].map(r=>m[r]!*x!+m[4+r]!*y!+m[8+r]!*z!+m[12+r]!);

const INVALID=[
 {...sword,piece:"sword.claymore"},{...sword,bladeLength:1.2},{...sword,bladeWidth:Infinity},{...sword,bladeThickness:.02},
 {...sword,bladeWidth:.03,bladeThickness:.011},{...sword,guardWidth:.12,bladeWidth:.07},{...sword,radialSegments:12.5},
 {...sword,radialSegments:true},{...sword,maxTriangles:2501},{...sword,maxTriangles:11},{...sword,schemaVersion:2},{...sword,extra:1},
 {...sword,width:.5},{...shield,width:.9},{...shield,height:.5,width:.56},{...shield,bossRadius:.15},{...shield,rimWidth:.075},
 {...shield,curvature:.2},{...shield,outlineSegments:5},{...shield,maxTriangles:3001},{...shield,thickness:NaN},
 Object.fromEntries(Object.entries(shield).filter(([k])=>k!=="rimWidth")),
 {...dagger,bladeLength:.5},{...dagger,guardWidth:.06},{...dagger,maxTriangles:1501},{...dagger,piece:"sword.arming"},
 {...staff,length:2.5},{...staff,footLength:.95,length:1.6},{...staff,orbRadius:.04,shaftRadius:.025},{...staff,radialSegments:17},
 {...staff,maxTriangles:2501},{...staff,piece:"staff.obsidian"},{...staff,bladeLength:.5},
 // #379: the mace and the tome.
 {...mace,gripLength:.3},{...mace,flanges:3},{...mace,flanges:6.5},{...mace,maxTriangles:1501},{...mace,bladeLength:.5},
 {...book,width:.3,height:.25},{...book,thickness:.09,width:.15},{...book,maxTriangles:401},{...book,radialSegments:8},
 // #467: the throwables.
 {...knife,bladeThickness:.006,bladeWidth:.018},{...knife,pinchOffset:.06,bladeLength:.1},{...knife,radialSegments:3},{...knife,maxTriangles:801},
 {...knife,guardWidth:.05},{...flask,neckRadius:.016,bodyRadius:.03},{...flask,fill:.95},{...flask,maxTriangles:1201},{...bomb,radius:.06},
 {...bomb,fuseLength:.01},{...bomb,radialSegments:25},{...bomb,piece:"venom-flask"},
];

test("weapon controls and asset specs are bounded and pinned",()=>{
 for(const p of BUILDS) {
  const s=spec(p);assert.deepEqual(s.parameters.arguments,p);assert.equal(s.reproducibility.expected,"exact");assert.equal(s.randomness.mode,"none");
  assert.deepEqual(s.inputs,{script:{path:"weapon.py",sha256:source.sha256}});
  assert.ok(p.maxTriangles<=WEAPON_TRIANGLE_BUDGETS[p.piece as WeaponPiece]);
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
  fileURLToPath(new URL("../../../adapters/blender/weapon.py",import.meta.url)),controls],{encoding:"utf8",timeout:25000,env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"}});
 assert.equal(run.status,0,run.error?.message ?? run.stderr);
 const line=run.stdout.split("\n").find(l=>l.startsWith("[weapon-controls]"));assert.ok(line,run.stdout);
 assert.deepEqual(JSON.parse(line.slice("[weapon-controls]".length)),expected);
});

test("native weapons are budgeted, grip-anchored, socket-aligned metric GLBs that replay exactly",{skip:!blender,timeout:600000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),"weapon-native-"));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,"weapon.py"),source.bytes);
 const file=path.join(root,"asset.json"),output=path.join(root,"weapon.glb");
 const triangleCounts:Record<string,number[]>={};
 for(const p of BUILDS) {
  const piece:WeaponPiece=p.piece;
  await writeFile(file,JSON.stringify(spec(p)));
  const generated=await generateAsset(file),bytes=await readFile(output),mtime=(await stat(output)).mtimeMs;
  assert.equal((await verifyAsset(file)).status,"exact");assert.equal((await generateAsset(file)).cache.status,"hit");assert.equal((await stat(output)).mtimeMs,mtime);
  const evidence=generated.receipt.observations.script;
  assert.deepEqual([evidence.piece,evidence.role,evidence.origin,evidence.unit,evidence.axes,evidence.gripNode],
   [piece,WEAPON_ROLES[piece],"grip","meter","right-handed-y-up","grip"]);
  const scene=(await new NodeIO().setAllowNetwork(false).readBinary(bytes)).getRoot();
  assert.deepEqual(scene.listMaterials().map(m=>m.getName()),[...WEAPON_MATERIALS[piece]]);
  for(const m of scene.listMaterials()) {
   assert.ok([0,1].includes(m.getMetallicFactor()) && m.getRoughnessFactor()>0 && !m.getBaseColorTexture() && !m.getEmissiveTexture());
   // Only the orbs glow; their emissive factor is their base colour.
   const glows=(WEAPON_EMISSIVE_MATERIALS as readonly string[]).includes(m.getName());
   assert.deepEqual(m.getEmissiveFactor().map(c=>Math.round(c*1e4)),glows?m.getBaseColorFactor().slice(0,3).map(c=>Math.round(c*1e4)):[0,0,0],m.getName());
   // #467: only the flask's glass is see-through (blended, its declared alpha); everything else is opaque.
   const alpha=(WEAPON_ALPHA_MATERIALS as Record<string,number>)[m.getName()];
   assert.equal(m.getAlphaMode(),alpha===undefined?"OPAQUE":"BLEND",m.getName());
   assert.equal(Math.round(m.getBaseColorFactor()[3]!*1e4),Math.round((alpha ?? 1)*1e4),m.getName());
  }
  const nodes=scene.listScenes()[0]!.listChildren();
  assert.deepEqual(nodes.map(n=>n.getName()).sort(),["grip",piece].sort());
  for(const node of nodes) {
   assert.deepEqual(node.getTranslation(),[0,0,0]);assert.deepEqual(node.getRotation(),[0,0,0,1]);assert.deepEqual(node.getScale(),[1,1,1]);
  }
  assert.equal(nodes.find(n=>n.getName()==="grip")!.getMesh(),null);
  let triangles=0;const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity],points:number[][]=[];
  for(const primitive of nodes.find(n=>n.getName()===piece)!.getMesh()!.listPrimitives()) {
   const position=primitive.getAttribute("POSITION")!;triangles+=primitive.getIndices()!.getCount()/3;
   assert.ok(primitive.getAttribute("NORMAL"));
   for(let i=0;i<position.getCount();i++) {
    const point:number[]=[];position.getElement(i,point);points.push(point);
    point.forEach((v,axis)=>{assert.ok(Number.isFinite(v));min[axis]=Math.min(min[axis]!,v);max[axis]=Math.max(max[axis]!,v);});
   }
  }
  assert.equal(triangles,evidence.triangleCount);assert.ok(triangles<=p.maxTriangles && triangles<=WEAPON_TRIANGLE_BUDGETS[piece]);
  (triangleCounts[piece]??=[]).push(triangles);
  for(let axis=0;axis<3;axis++) {
   assert.ok(Math.abs(min[axis]!-evidence.bounds.min[axis]!)<1e-4 && Math.abs(max[axis]!-evidence.bounds.max[axis]!)<1e-4,`bounds axis ${axis}`);
  }
  if(piece==="sword.arming") {
   // Metres: ~0.95 m overall, blade toward +Y from a grip at the origin, crossguard width along X.
   assert.ok(Math.abs(max[1]!-min[1]!-.95)<.02,`sword length ${max[1]!-min[1]!}`);
   assert.ok(max[1]!>.8 && min[1]!<-.09 && min[1]!>-.13);
   assert.ok(Math.abs(max[0]!-sword.guardWidth/2)<1e-4 && Math.abs(min[0]!+sword.guardWidth/2)<1e-4);
  } else if(piece==="dagger.blackened") {
   // A 0.35 m blade over a 0.1 m grip: ~0.5 m overall, guard width along X.
   assert.ok(max[1]!>.4 && max[1]!<.45 && min[1]!<-.06 && min[1]!>-.1,`dagger y ${min[1]}..${max[1]}`);
   assert.ok(Math.abs(max[0]!-dagger.guardWidth/2)<1e-4 && Math.abs(min[0]!+dagger.guardWidth/2)<1e-4);
  } else if((WEAPON_STAFFS as readonly string[]).includes(piece)) {
   // The foot is footLength below the grip; the head and orb top out ~0.25 m above the shaft (1.85 m long).
   assert.ok(Math.abs(min[1]!+staff.footLength)<.01 && max[1]!>staff.length-staff.footLength+.1 && max[1]!<staff.length-staff.footLength+.3,
    `${piece} y ${min[1]}..${max[1]}`);
   assert.ok(max[0]!-min[0]!<.3 && max[2]!-min[2]!<.3);
  } else if(piece==="mace.flanged") {
   // #379: the haft along +Y to a flanged head about half a metre above the grip, the pommel just below the hand.
   assert.ok(max[1]!>mace.haftLength && max[1]!<mace.haftLength+mace.headRadius*1.5 && min[1]!<-.09 && min[1]!>-.13,`mace y ${min[1]}..${max[1]}`);
   assert.ok(max[0]!-min[0]!<=mace.headRadius*2.3 && max[2]!-min[2]!<=mace.headRadius*2.3);
  } else if(piece==="book.tome") {
   // #379: held like the shield: width along X, height along Y, standing off the hand toward +Z.
   assert.ok(Math.abs(max[1]!-min[1]!-book.height)<1e-3 && Math.abs(max[0]!-min[0]!-book.width)<.01,`tome ${min} ${max}`);
   assert.ok(min[2]!>0 && max[2]!<book.thickness+.02);
  } else if(piece==="throwing-knife") {
   // #467: the point pinchOffset below the pinch frame, the knife ~0.26 m along +Y, its axis off the origin toward the
   // thumb (-X) and the palm (-Z); thin across X (the flats), the blade's width across Z.
   assert.ok(Math.abs(min[1]!+knife.pinchOffset)<1e-4 && max[1]!>.22 && max[1]!<.3,`knife y ${min[1]}..${max[1]}`);
   assert.ok(Math.abs((min[0]!+max[0]!)/2+.015)<.003 && max[0]!-min[0]!<.025 && Math.abs((min[2]!+max[2]!)/2+.02)<.003,`knife ${min} ${max}`);
  } else if(piece==="venom-flask" || piece==="blasting-bomb") {
   // #467: a 4 cm ball centred on the grip (the Grip_Flask_R ball), neck or fuse toward +Y.
   const radius=piece==="venom-flask"?flask.bodyRadius:bomb.radius;
   const across=Math.max(...points.filter(([,y])=>Math.abs(y!)<radius*.5).map(([x,,z])=>Math.hypot(x!,z!)));
   assert.ok(across>radius*.97 && across<radius*1.06,`${piece} ball ${across}`);
   assert.ok(Math.abs(min[1]!+radius)<radius*.1 && max[1]!>radius*1.6 && max[1]!<radius*3.5,`${piece} y ${min[1]}..${max[1]}`);
  } else {
   // Face toward +Z in front of the handle, point toward -Y, width along X.
   assert.ok(Math.abs(max[0]!-min[0]!-shield.width)<.02 && max[0]!-min[0]!>=shield.width);
   assert.ok(Math.abs(max[1]!-min[1]!-shield.height)<.04);
   assert.ok(max[2]!>.08 && min[2]!<0 && max[2]!<.15 && min[2]!>-.05);
  }
  if(WEAPON_ROLES[piece]==="one-hand-weapon" || WEAPON_ROLES[piece]==="staff") {
   // Grip alignment: the hand's contact band (|y| < 2 cm) is a ring centred on the grip axis, as thick as the grip.
   const band=points.filter(([,y])=>Math.abs(y!)<.02),centre=[0,2].map(a=>band.reduce((s,p)=>s+p[a]!,0)/band.length);
   const radius=Math.max(...band.map(([x,,z])=>Math.hypot(x!,z!)));
   assert.ok(band.length>=8 && Math.hypot(...centre)<.002 && radius>.008 && radius<.03,`${piece} grip band ${centre} r=${radius}`);
   // Socket alignment: held in its Ranger hand socket (hand_r frame: fingers +Y, thumb side +Z, palm -X), the grip
   // lands on the socket's grip point; a blade leaves the fist on the thumb side, a staff's head rises past the wrist.
   const socket=rangerSockets.sockets.find(s=>s.id===(WEAPON_ROLES[piece]==="staff"?"hand_r.staff":"hand_r.weapon"))!;
   const m=humanoidAttachmentMatrix(socket,createHumanoidItemDescriptor({item:piece,roles:[WEAPON_ROLES[piece]],
    frames:[{name:"grip",translation:[0,0,0],rotation:[0,0,0,1]}]}));
   const grip=apply(m,[0,0,0]),top=apply(m,[0,max[1]!,0]),foot=apply(m,[0,min[1]!,0]);
   assert.deepEqual(grip.map(v=>Math.round(v*1e4)),socket.translation.map(v=>Math.round(v*1e4)));
   if(WEAPON_ROLES[piece]==="staff") assert.ok(top[1]!<grip[1]!-.8 && top[2]!>grip[2]!+.5 && foot[1]!>grip[1]!+.5,`${piece} held ${top} ${foot}`);
   else assert.ok(top[2]!>grip[2]!+.3 && Math.abs(top[0]!-grip[0]!)<.02,`${piece} held ${top}`);
  }
  await executeGltfImportOperation(root,{parameters:{},inputs:{source:(await storeAssetObject(root,{bytes,kind:"mesh",mediaType:"model/gltf-binary"})).asset}});
 }
 // #467: each throwable level has fewer triangles than the one before.
 for(const piece of WEAPON_THROWABLES) {
  const [lod0,lod1,lod2]=triangleCounts[piece]!;
  assert.ok(lod0!>lod1! && lod1!>lod2!,`${piece} levels ${triangleCounts[piece]}`);
 }
 const previous=await readFile(output);
 await writeFile(file,JSON.stringify(spec({...sword,maxTriangles:12})));await assert.rejects(generateAsset(file),/maxTriangles/);
 assert.deepEqual(await readFile(output),previous);
});
