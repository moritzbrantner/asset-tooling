import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {createHumanoidSocketDescriptor,humanoidSocketMatrix,humanoidSocketsAccepting,validateHumanoidSocketDescriptor,
 HUMANOID_SOCKETS_SCHEMA,type HumanoidSocket} from "../src/humanoid-sockets.js";
import {WEAPON_ROLES} from "../src/weapon-recipes.js";
import {deriveHandSockets,deriveRangerSockets,handFrame,quaternionFromAxes,restWorlds} from "../examples/weapons/derive-sockets.ts";

const descriptor=JSON.parse(await readFile(new URL("../assets/descriptors/humanoid.ranger.male.sockets.json",import.meta.url),"utf8"));
const outfit=new URL("../assets/canonical/quaternius.modular-character-outfits-fantasy-standard.male-ranger-gltf/Male_Ranger.gltf",import.meta.url);
const outfitText=await readFile(outfit,"utf8");
const hydrated=!outfitText.startsWith("version https://git-lfs.github.com/spec/v1");
const socket=(change:Partial<Record<keyof HumanoidSocket,unknown>>={})=>({id:"hand_r.weapon",joint:"hand_r",translation:[0,.1,0],rotation:[0,0,0,1],accepts:["one-hand-weapon"],...change});
const make=(sockets:unknown[])=>({schema:HUMANOID_SOCKETS_SCHEMA,character:"humanoid.ranger.male",unit:"meter",axes:"right-handed-y-up",attachFrame:"grip",sockets});

test("the committed Ranger descriptor declares the hand and stowed sockets for the weapon roles",()=>{
 const d=validateHumanoidSocketDescriptor(descriptor,{joints:["hand_r","hand_l","spine_03","pelvis"]});
 assert.deepEqual(d,descriptor,"the committed file is already canonical");
 assert.deepEqual(d.sockets.map(s=>[s.id,s.joint]),[["hand_r.weapon","hand_r"],["hand_l.shield","hand_l"],["back.stowed","spine_03"],["hip_l.stowed","pelvis"]]);
 assert.deepEqual(humanoidSocketsAccepting(d,WEAPON_ROLES["sword.arming"]),["hand_r.weapon","hip_l.stowed"]);
 assert.deepEqual(humanoidSocketsAccepting(d,WEAPON_ROLES["shield.heater"]),["hand_l.shield","back.stowed"]);
 // In the hand_r frame the fingers run along +Y, the thumb side is +Z and the palm faces -X. The blade (+Y) runs
 // along the knuckle line out of the thumb side, about 15° toward the fingers; the flats (±Z) face palm and back of hand.
 const m=humanoidSocketMatrix(d.sockets[0]!),blade=[m[4]!,m[5]!,m[6]!],flat=[m[8]!,m[9]!,m[10]!];
 assert.ok(blade[2]!>.95 && blade[1]!>.15 && blade[1]!<.35 && Math.abs(blade[0]!)<.02,`blade direction ${blade}`);
 assert.ok(flat[0]!>.99,`flat normal ${flat}`);
 // The grip centre sits in the palm (-X), most of the way from the wrist to the knuckles (+Y).
 assert.ok(m[12]!<-.02 && m[13]!>.06 && m[13]!<.1,`grip ${m.slice(12,15)}`);
 // The shield's face (+Z) points out of the back of the left hand (-X; its palm faces +X) and its top (+Y) toward the thumb (+Z).
 const s=humanoidSocketMatrix(d.sockets[1]!),face=[s[8]!,s[9]!,s[10]!],top=[s[4]!,s[5]!,s[6]!];
 assert.ok(face[0]!<-.99 && top[2]!>.95,`shield face ${face}, top ${top}`);
 // The two hand sockets mirror each other across the hand's palm plane.
 assert.deepEqual([s[12]!,s[13]!,s[14]!],[-m[12]!,m[13]!,m[14]!]);
});

test("the bundle-v2 descriptor (shipped by Ranger v2 and v3) is kept byte for byte",async()=>{
 const bytes=await readFile(new URL("../assets/descriptors/humanoid.ranger.male.sockets.bundle-v2.json",import.meta.url));
 assert.equal(createHash("sha256").update(bytes).digest("hex"),"3f71c0346200ddf03b45f191e35325ecedb41e937dab225c97ea31ac7542dfb1");
 const old=validateHumanoidSocketDescriptor(JSON.parse(bytes.toString("utf8")));
 assert.deepEqual(old.sockets.slice(2),descriptor.sockets.slice(2),"the stowed sockets are unchanged");
});

test("hand frames are derived in the joint's own frame, independent of the rig's world placement",()=>{
 const quarter=Math.SQRT1_2;
 const rig=(rootRotation:number[])=>({nodes:[
  {name:"root",rotation:rootRotation,translation:[1,2,3],children:[1]},
  // hand_r rotated a quarter turn about +Z, like the Ranger's T-pose; fingers +Y, thumb side +Z, palm -X.
  {name:"hand_r",translation:[-.6,1.4,0],rotation:[0,0,quarter,quarter],children:[2,3,4,5,6]},
  {name:"index_01_r",translation:[-.01,.11,.03]},{name:"middle_01_r",translation:[-.01,.11,.005]},
  {name:"ring_01_r",translation:[-.01,.105,-.02]},{name:"pinky_01_r",translation:[-.01,.095,-.04]},{name:"thumb_03_r",translation:[-.06,.08,.06]},
 ]});
 const a=handFrame(restWorlds(rig([0,0,0,1])),"r"),b=handFrame(restWorlds(rig([.5,.5,.5,.5])),"r");
 for(const key of ["fingers","knuckles","palm","grip"] as const) a[key].forEach((v,i)=>assert.ok(Math.abs(v-b[key][i]!)<1e-9,`${key} ${a[key]} vs ${b[key]}`));
 assert.ok(a.palm[0]<-.99 && a.fingers[1]>.99 && a.knuckles[2]>.95,`palm ${a.palm}, fingers ${a.fingers}, knuckles ${a.knuckles}`);
 const [x,y,z,w]=quaternionFromAxes([0,1,0],[-1,0,0],[0,0,1]);
 assert.deepEqual([x,y,z,w].map(v=>Math.round(v*1e9)/1e9+0),[0,0,Math.round(quarter*1e9)/1e9,Math.round(quarter*1e9)/1e9]);
});

test("examples/weapons/derive-sockets.ts reproduces the committed descriptor from the Male_Ranger rig",{skip:hydrated?false:"Git LFS payload not hydrated"},async()=>{
 const gltf=JSON.parse(outfitText);
 assert.equal(deriveRangerSockets(gltf),await readFile(new URL("../assets/descriptors/humanoid.ranger.male.sockets.json",import.meta.url),"utf8"));
 // A left-handed derivation mirrors the right-handed one.
 const [weapon,shield]=deriveHandSockets(gltf,{weaponHand:"l"});
 assert.deepEqual([weapon!.id,shield!.id],["hand_l.weapon","hand_r.shield"]);
 assert.deepEqual(weapon!.translation,[-descriptor.sockets[0].translation[0],...descriptor.sockets[0].translation.slice(1)]);
});

test("the Ranger descriptor names only joints of the Male_Ranger rig",{skip:hydrated?false:"Git LFS payload not hydrated"},()=>{
 const gltf=JSON.parse(outfitText),joints:string[]=gltf.skins[0].joints.map((index:number)=>gltf.nodes[index].name);
 assert.equal(joints.length,65);
 validateHumanoidSocketDescriptor(descriptor,{joints});
});

test("socket descriptors reject unknown joints, duplicate ids and non-finite or malformed transforms",()=>{
 const joints=["hand_r","hand_l"];
 assert.equal(createHumanoidSocketDescriptor({character:"humanoid.ranger.male",sockets:[socket() as HumanoidSocket],joints}).sockets.length,1);
 assert.throws(()=>validateHumanoidSocketDescriptor(make([socket({joint:"hand_x"})]),{joints}),/unknown joint 'hand_x'/);
 assert.throws(()=>validateHumanoidSocketDescriptor(make([socket(),socket({joint:"hand_l"})])),/duplicate socket id 'hand_r.weapon'/);
 for(const bad of [{translation:[0,NaN,0]},{translation:[0,Infinity,0]},{translation:[0,0]},{translation:[0,0,11]},{rotation:[0,0,0,NaN]},
  {rotation:[0,0,0,2]},{rotation:[0,0,1]},{scale:[1,0,1]},{scale:[1,-1,1]},{scale:[1,1,Infinity]},{accepts:[]},{accepts:["shield","shield"]},
  {accepts:["Shield"]},{id:"weapon"},{id:"Hand_r.weapon"},{joint:""},{extra:1}]) {
  assert.throws(()=>validateHumanoidSocketDescriptor(make([socket(bad as never)])),Error,JSON.stringify(bad));
 }
 for(const change of [{schema:"humanoid-sockets-v2"},{unit:"centimeter"},{axes:"z-up"},{attachFrame:"origin"},{sockets:[]},{character:"Ranger"},{extra:1}]) {
  assert.throws(()=>validateHumanoidSocketDescriptor({...make([socket()]),...change}),Error,JSON.stringify(change));
 }
 assert.deepEqual(validateHumanoidSocketDescriptor(make([socket({scale:[1,2,1]})])).sockets[0]!.scale,[1,2,1]);
});

test("socket matrices compose translation, rotation and scale column-major",()=>{
 assert.deepEqual(humanoidSocketMatrix(socket() as HumanoidSocket),[1,0,0,0,0,1,0,0,0,0,1,0,0,.1,0,1]);
 const quarter=Math.SQRT1_2,m=humanoidSocketMatrix(socket({rotation:[0,0,quarter,quarter],scale:[2,1,1]}) as HumanoidSocket);
 // A quarter turn about +Z maps +X (scaled by 2) to +Y.
 assert.deepEqual(m.slice(0,3).map(v=>Math.round(v*1e9)/1e9+0),[0,2,0]);
 assert.deepEqual(m.slice(4,7).map(v=>Math.round(v*1e9)/1e9+0),[-1,0,0]);
});

test("the humanoid-sockets-v1 schema mirrors the validator's fields",async()=>{
 const schema=JSON.parse(await readFile(new URL("../schemas/humanoid-sockets-v1.schema.json",import.meta.url),"utf8"));
 assert.deepEqual(schema.required,["schema","character","unit","axes","attachFrame","sockets"]);
 assert.equal(schema.properties.schema.const,HUMANOID_SOCKETS_SCHEMA);
 assert.deepEqual(schema.$defs.socket.required,["id","joint","translation","rotation","accepts"]);
 const id=new RegExp(schema.$defs.socket.properties.id.pattern);
 for(const s of descriptor.sockets) assert.ok(id.test(s.id),s.id);
 assert.equal(id.test("weapon"),false);
});
