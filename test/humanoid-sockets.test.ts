import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createHumanoidItemDescriptor,createHumanoidSocketDescriptor,humanoidAttachmentMatrix,humanoidItemFrameMatrix,humanoidSocketMatrix,humanoidSocketMirror,
 humanoidSocketsAccepting,validateHumanoidItemDescriptor,validateHumanoidSocketDescriptor,HUMANOID_ITEM_SCHEMA,HUMANOID_SOCKETS_SCHEMA,type HumanoidSocket} from "../src/humanoid-sockets.js";
import {WEAPON_ROLES} from "../src/weapon-recipes.js";
import {ARMOR_JOINTS} from "../src/armor-recipes.js";
import {deriveHandSockets,deriveRangerSockets,handFrame,quaternionFromAxes,restWorlds} from "../examples/weapons/derive-sockets.ts";

const descriptor=JSON.parse(await readFile(new URL("../assets/descriptors/humanoid.ranger.male.sockets.json",import.meta.url),"utf8"));
const outfit=new URL("../assets/canonical/quaternius.modular-character-outfits-fantasy-standard.male-ranger-gltf/Male_Ranger.gltf",import.meta.url);
const outfitText=await readFile(outfit,"utf8");
const hydrated=!outfitText.startsWith("version https://git-lfs.github.com/spec/v1");
const socket=(change:Partial<Record<keyof HumanoidSocket,unknown>>={})=>({id:"hand_r.weapon",joint:"hand_r",translation:[0,.1,0],rotation:[0,0,0,1],attachFrame:"grip",accepts:["one-hand-weapon"],...change});
const make=(sockets:unknown[])=>({schema:HUMANOID_SOCKETS_SCHEMA,character:"humanoid.ranger.male",unit:"meter",axes:"right-handed-y-up",sockets});

test("the committed Ranger descriptor declares the hand, stowed, archery, hair and armour sockets",()=>{
 const d=validateHumanoidSocketDescriptor(descriptor,{joints:["hand_r","hand_l","spine_03","pelvis",...ARMOR_JOINTS]});
 assert.deepEqual(d,descriptor,"the committed file is already canonical");
 assert.deepEqual(d.sockets.map(s=>[s.id,s.joint]),[["hand_r.weapon","hand_r"],["hand_l.shield","hand_l"],["hand_l.weapon","hand_l"],["hand_r.shield","hand_r"],["back.stowed","spine_03"],["hip_l.stowed","pelvis"],["hip_r.stowed","pelvis"],["belt.throwable","pelvis"],
  ["hand_l.bow","hand_l"],["hand_r.arrow","hand_r"],["back.quiver","spine_03"],["back.bow.stowed","spine_03"],["head.hair","Head"],
  ...ARMOR_JOINTS.map(joint=>[`${joint.toLowerCase()}.armor`,joint]),["hand_r.staff","hand_r"],["hand_l.staff","hand_l"],["hand_r.crossbow","hand_r"],["hand_l.crossbow","hand_l"]]);
 assert.deepEqual(humanoidSocketsAccepting(d,"hair"),["head.hair"]);
 assert.deepEqual(humanoidSocketsAccepting(d,WEAPON_ROLES["staff.gnarled"]),["hand_r.staff","hand_l.staff"]);
 assert.deepEqual(humanoidSocketsAccepting(d,WEAPON_ROLES["dagger.blackened"]),humanoidSocketsAccepting(d,WEAPON_ROLES["sword.arming"]));
 // The staff (#372) shares the weapon grip point; its shaft (+Y) rises from the palm toward the wrist (-Y), turned
 // toward the thumb side (+Z) and leaning out of the back of the hand (+X), so it stands upright in the idle.
 const staff=humanoidSocketMatrix(d.sockets.find(s=>s.id==="hand_r.staff")!),shaft=[staff[4]!,staff[5]!,staff[6]!];
 assert.ok(shaft[1]!<-.7 && shaft[2]!>.45 && shaft[0]!>.1 && shaft[0]!<.35,`staff shaft ${shaft}`);
 assert.deepEqual(staff.slice(12,15),humanoidSocketMatrix(d.sockets[0]!).slice(12,15));
 assert.deepEqual(humanoidSocketsAccepting(d,"armor"),ARMOR_JOINTS.map(joint=>`${joint.toLowerCase()}.armor`));
 assert.deepEqual(humanoidSocketsAccepting(d,"bow"),["hand_l.bow","back.bow.stowed"]);
 assert.deepEqual(humanoidSocketsAccepting(d,"arrow"),["hand_r.arrow"]);
 assert.deepEqual(humanoidSocketsAccepting(d,"quiver"),["back.quiver"]);
 // #418: knives, flasks and bombs are drawn from the belt into the weapon hand.
 assert.deepEqual(humanoidSocketsAccepting(d,"throwing-knife"),["hand_r.weapon","hand_l.weapon","belt.throwable"]);
 assert.deepEqual(humanoidSocketsAccepting(d,"flask"),humanoidSocketsAccepting(d,"throwing-knife"));
 // #419: the crossbow reload's crank handle is held at the weapon grip (Grip_Crank_L).
 assert.deepEqual(humanoidSocketsAccepting(d,"crank"),["hand_r.weapon","hand_l.weapon"]);
 // The crossbow (#389) shares the weapon grip point; its stock (+Z) runs along the weapon grip axis (+Y of hand_r.weapon).
 const crossbow=humanoidSocketMatrix(d.sockets.find(s=>s.id==="hand_r.crossbow")!),weapon=humanoidSocketMatrix(d.sockets[0]!);
 assert.deepEqual(humanoidSocketsAccepting(d,"crossbow"),["hand_r.crossbow","hand_l.crossbow"]);
 assert.ok([0,1,2].reduce((s,i)=>s+crossbow[8+i]!*weapon[4+i]!,0)>.999,"crossbow stock along the grip");
 assert.deepEqual(crossbow.slice(12,15),weapon.slice(12,15));
 // #419: the top of the stock (+Y) faces the fingertips (hand_r +Y), so the forearm hangs under the stock.
 assert.ok(crossbow[5]! > .9,`crossbow top ${crossbow.slice(4,7)}`);
 assert.deepEqual(humanoidSocketsAccepting(d,WEAPON_ROLES["sword.arming"]),["hand_r.weapon","hand_l.weapon","hip_l.stowed","hip_r.stowed"]);
 assert.deepEqual(humanoidSocketsAccepting(d,WEAPON_ROLES["shield.heater"]),["hand_l.shield","hand_r.shield","back.stowed"]);
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

test("examples/weapons/derive-sockets.ts reproduces the female Ranger descriptor from the Female_Ranger rig (#115)",async(t)=>{
 const text=await readFile(new URL("../assets/canonical/quaternius.modular-character-outfits-fantasy-standard.female-ranger-gltf/Female_Ranger.gltf",import.meta.url),"utf8");
 if(text.startsWith("version https://git-lfs.github.com/spec/v1")) return t.skip("Git LFS payload not hydrated");
 const gltf=JSON.parse(text),joints:string[]=gltf.skins[0].joints.map((index:number)=>gltf.nodes[index].name);
 const committed=await readFile(new URL("../assets/descriptors/humanoid.ranger.female.sockets.json",import.meta.url),"utf8");
 assert.equal(deriveRangerSockets(gltf,"humanoid.ranger.female"),committed);
 const female=validateHumanoidSocketDescriptor(JSON.parse(committed),{joints});
 assert.deepEqual(female.sockets.map(s=>s.id),descriptor.sockets.map((s:HumanoidSocket)=>s.id),"the same socket ids as the male Ranger");
});

test("socket descriptors reject unknown joints, duplicate ids and non-finite or malformed transforms",()=>{
 const joints=["hand_r","hand_l"];
 assert.equal(createHumanoidSocketDescriptor({character:"humanoid.ranger.male",sockets:[socket() as HumanoidSocket],joints}).sockets.length,1);
 assert.throws(()=>validateHumanoidSocketDescriptor(make([socket({joint:"hand_x"})]),{joints}),/unknown joint 'hand_x'/);
 assert.throws(()=>validateHumanoidSocketDescriptor(make([socket(),socket({joint:"hand_l"})])),/duplicate socket id 'hand_r.weapon'/);
 for(const bad of [{translation:[0,NaN,0]},{translation:[0,Infinity,0]},{translation:[0,0]},{translation:[0,0,11]},{rotation:[0,0,0,NaN]},
  {rotation:[0,0,0,2]},{rotation:[0,0,1]},{scale:[1,0,1]},{scale:[1,-1,1]},{scale:[1,1,Infinity]},{accepts:[]},{accepts:["shield","shield"]},
  {accepts:["Shield"]},{attachFrame:"Grip"},{attachFrame:""},{mirror:"hand_r.weapon"},{mirror:"x"},{id:"weapon"},{id:"Hand_r.weapon"},{joint:""},{extra:1}]) {
  assert.throws(()=>validateHumanoidSocketDescriptor(make([socket(bad as never)])),Error,JSON.stringify(bad));
 }
 for(const change of [{schema:"humanoid-sockets-v1"},{unit:"centimeter"},{axes:"z-up"},{attachFrame:"grip"},{sockets:[]},{character:"Ranger"},{extra:1}]) {
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

test("the humanoid-sockets-v2 and humanoid-item-v1 schemas mirror the validators' fields",async()=>{
 const schema=JSON.parse(await readFile(new URL("../schemas/humanoid-sockets-v2.schema.json",import.meta.url),"utf8"));
 assert.deepEqual(schema.required,["schema","character","unit","axes","sockets"]);
 assert.equal(schema.properties.schema.const,HUMANOID_SOCKETS_SCHEMA);
 assert.deepEqual(schema.$defs.socket.required,["id","joint","translation","rotation","attachFrame","accepts"]);
 assert.deepEqual(Object.keys(schema.$defs.socket.properties),["id","joint","translation","rotation","scale","attachFrame","accepts","mirror"]);
 const id=new RegExp(schema.$defs.socketId.pattern);
 for(const s of descriptor.sockets) assert.ok(id.test(s.id),s.id);
 assert.equal(id.test("weapon"),false);
 const item=JSON.parse(await readFile(new URL("../schemas/humanoid-item-v1.schema.json",import.meta.url),"utf8"));
 assert.deepEqual(item.required,["schema","item","unit","axes","roles","frames"]);
 assert.equal(item.properties.schema.const,HUMANOID_ITEM_SCHEMA);
 assert.deepEqual(item.$defs.frame.required,["name","translation","rotation"]);
 const frame=new RegExp(item.$defs.frame.properties.name.pattern);
 assert.ok(frame.test("grip") && frame.test("grip.offhand") && !frame.test("Grip"));
});

test("mirror pairs are symmetric and hold the same frame and roles (#264)",()=>{
 const d=validateHumanoidSocketDescriptor(descriptor);
 assert.equal(humanoidSocketMirror(d,"hand_r.weapon")!.id,"hand_l.weapon");
 assert.equal(humanoidSocketMirror(d,"hand_l.shield")!.id,"hand_r.shield");
 assert.equal(humanoidSocketMirror(d,"back.stowed"),undefined);
 // The left-handed weapon socket mirrors the right-handed one across the palm plane.
 const r=humanoidSocketMatrix(d.sockets[0]!),l=humanoidSocketMatrix(humanoidSocketMirror(d,"hand_r.weapon")!);
 assert.deepEqual([l[12]!,l[13]!,l[14]!],[-r[12]!,r[13]!,r[14]!]);
 const pair=(a:Record<string,unknown>,b:Record<string,unknown>)=>make([socket({mirror:"hand_l.weapon",...a}),socket({id:"hand_l.weapon",joint:"hand_l",mirror:"hand_r.weapon",...b})]);
 assert.equal(validateHumanoidSocketDescriptor(pair({},{})).sockets[1]!.mirror,"hand_r.weapon");
 assert.throws(()=>validateHumanoidSocketDescriptor(pair({},{mirror:undefined})),/must mirror 'hand_r.weapon' back/);
 assert.throws(()=>validateHumanoidSocketDescriptor(pair({},{accepts:["shield"]})),/same frame and accept the same roles/);
 assert.throws(()=>validateHumanoidSocketDescriptor(pair({},{attachFrame:"grip.offhand"})),/same frame/);
 assert.throws(()=>validateHumanoidSocketDescriptor(make([socket({mirror:"hand_l.weapon"})])),/mirrors unknown socket 'hand_l.weapon'/);
});

test("item descriptors declare roles and named frames; attachment puts the held frame on the socket (#264)",()=>{
 const sword=createHumanoidItemDescriptor({item:"equipment.sword.long",roles:["two-hand-weapon"],frames:[
  {name:"grip",translation:[0,0,0],rotation:[0,0,0,1]},{name:"grip.offhand",translation:[0,.2,0],rotation:[0,0,0,1]}]});
 assert.deepEqual(validateHumanoidItemDescriptor(JSON.parse(JSON.stringify(sword))),sword);
 const base={schema:HUMANOID_ITEM_SCHEMA,item:"equipment.sword.long",unit:"meter",axes:"right-handed-y-up",roles:["two-hand-weapon"],frames:sword.frames};
 for(const change of [{schema:"humanoid-item-v2"},{item:"Sword"},{roles:[]},{roles:["a","a"]},{frames:[]},{frames:[sword.frames[0],sword.frames[0]]},
  {frames:[{name:"Grip",translation:[0,0,0],rotation:[0,0,0,1]}]},{frames:[{name:"grip",translation:[0,0,0],rotation:[0,0,0,2]}]},
  {frames:[{name:"grip",translation:[0,0,0],rotation:[0,0,0,1],scale:[0,1,1]}]},{frames:[{name:"grip",translation:[0,0,0],rotation:[0,0,0,1],extra:1}]},{extra:1}]) {
  assert.throws(()=>validateHumanoidItemDescriptor({...base,...change}),Error,JSON.stringify(change));
 }
 const right=socket({id:"hand_r.weapon",accepts:["two-hand-weapon"]}) as HumanoidSocket;
 const left=socket({id:"hand_l.weapon",joint:"hand_l",attachFrame:"grip.offhand",accepts:["two-hand-weapon"]}) as HumanoidSocket;
 // Held by `grip` (identity), the item root sits on the socket; held by `grip.offhand`, it sits 0.2 m below the socket along +Y.
 assert.deepEqual(humanoidAttachmentMatrix(right,sword),humanoidSocketMatrix(right));
 assert.deepEqual(humanoidAttachmentMatrix(left,sword).slice(12,15).map(v=>Math.round(v*1e9)/1e9+0),[0,-.1,0]);
 assert.throws(()=>humanoidAttachmentMatrix(socket() as HumanoidSocket,sword),/accepts none of the roles/);
 assert.throws(()=>humanoidAttachmentMatrix(socket({attachFrame:"strap",accepts:["two-hand-weapon"]}) as HumanoidSocket,sword),/no 'strap' frame/);
 // socket × inverse(frame) × frame = socket, for a rotated and scaled frame as well.
 const quarter=Math.SQRT1_2,frame={name:"strap",translation:[.1,.2,.3] as [number,number,number],rotation:[0,quarter,0,quarter] as [number,number,number,number],scale:[2,1,.5] as [number,number,number]};
 const shield=createHumanoidItemDescriptor({item:"equipment.shield.round",roles:["shield"],frames:[frame]});
 const held=socket({attachFrame:"strap",accepts:["shield"],rotation:[quarter,0,0,quarter]}) as HumanoidSocket;
 const a=humanoidAttachmentMatrix(held,shield),f=humanoidItemFrameMatrix(frame),product=new Array<number>(16).fill(0);
 for(let c=0;c<4;c++) for(let r=0;r<4;r++) for(let k=0;k<4;k++) product[c*4+r]!+=a[k*4+r]!*f[c*4+k]!;
 humanoidSocketMatrix(held).forEach((v,i)=>assert.ok(Math.abs(v-product[i]!)<1e-12,`element ${i}: ${product[i]} vs ${v}`));
});
