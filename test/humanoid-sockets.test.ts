import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createHumanoidSocketDescriptor,humanoidSocketMatrix,humanoidSocketsAccepting,validateHumanoidSocketDescriptor,
 HUMANOID_SOCKETS_SCHEMA,type HumanoidSocket} from "../src/humanoid-sockets.js";
import {WEAPON_ROLES} from "../src/weapon-recipes.js";

const descriptor=JSON.parse(await readFile(new URL("../assets/descriptors/humanoid.ranger.male.sockets.json",import.meta.url),"utf8"));
const outfit=new URL("../assets/canonical/quaternius.modular-character-outfits-fantasy-standard.male-ranger-gltf/Male_Ranger.gltf",import.meta.url);
const outfitText=await readFile(outfit,"utf8");
const hydrated=!outfitText.startsWith("version https://git-lfs.github.com/spec/v1");
const socket=(change:Partial<Record<keyof HumanoidSocket,unknown>>={})=>({id:"hand_r.weapon",joint:"hand_r",translation:[0,.1,0],rotation:[0,0,0,1],accepts:["one-hand-weapon"],...change});
const make=(sockets:unknown[])=>({schema:HUMANOID_SOCKETS_SCHEMA,character:"humanoid.ranger.male",unit:"meter",axes:"right-handed-y-up",attachFrame:"grip",sockets});

test("the committed Ranger descriptor declares the slice-1 sockets for the weapon roles",()=>{
 const d=validateHumanoidSocketDescriptor(descriptor,{joints:["hand_r","hand_l","spine_03","pelvis"]});
 assert.deepEqual(d,descriptor,"the committed file is already canonical");
 assert.deepEqual(d.sockets.map(s=>[s.id,s.joint]),[["hand_r.weapon","hand_r"],["hand_l.shield","hand_l"],["back.stowed","spine_03"],["hip_l.stowed","pelvis"]]);
 assert.deepEqual(humanoidSocketsAccepting(d,WEAPON_ROLES["sword.arming"]),["hand_r.weapon","hip_l.stowed"]);
 assert.deepEqual(humanoidSocketsAccepting(d,WEAPON_ROLES["shield.heater"]),["hand_l.shield","back.stowed"]);
 // In the hand_r frame the fingers run along +Y and the thumb side is +Z: the blade (+Y) leaves the fist past the thumb, leaning toward the fingers.
 const m=humanoidSocketMatrix(d.sockets[0]!),blade=[m[4]!,m[5]!,m[6]!];
 assert.ok(blade[2]!>.7 && blade[1]!>.5 && Math.abs(blade[0]!)<1e-6,`blade direction ${blade}`);
 // The shield's face (+Z) points away from the back of the left hand (-X) and its forearm axis (+Y) runs back toward the elbow (-Y).
 const s=humanoidSocketMatrix(d.sockets[1]!);
 assert.deepEqual([s[8],s[9],s[10],s[4],s[5],s[6]].map(v=>Math.round(v!*1e5)/1e5+0),[-1,0,0,0,-1,0]);
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
