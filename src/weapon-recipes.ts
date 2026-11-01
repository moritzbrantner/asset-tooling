import {readBlenderRecipeSource} from "./blender-recipe-source.js";
import {parseAssetSpec} from "./schema.js";

export type StaffPiece="staff.bone"|"staff.gilded"|"staff.gnarled"|"staff.crystal";
/** #467: the Rogue's throwables. */
export type ThrowablePiece="throwing-knife"|"venom-flask"|"blasting-bomb";
export type WeaponPiece="sword.arming"|"dagger.blackened"|"shield.heater"|StaffPiece|"mace.flanged"|"book.tome"|ThrowablePiece;
export type WeaponRole="one-hand-weapon"|"shield"|"staff"|"book"|"throwing-knife"|"flask";
type BladeControls={schemaVersion:1;bladeLength:number;bladeWidth:number;bladeThickness:number;
 fullerLength:number;guardWidth:number;gripLength:number;pommelRadius:number;radialSegments:number;maxTriangles:number};
export type SwordParameters=BladeControls&{piece:"sword.arming"};
export type DaggerParameters=BladeControls&{piece:"dagger.blackened"};
export type ShieldParameters={schemaVersion:1;piece:"shield.heater";width:number;height:number;curvature:number;thickness:number;
 rimWidth:number;bossRadius:number;outlineSegments:number;maxTriangles:number};
export type StaffParameters={schemaVersion:1;piece:StaffPiece;length:number;footLength:number;shaftRadius:number;orbRadius:number;
 radialSegments:number;maxTriangles:number};
/** #379: the Cleric's flanged mace and the Arcanist's tome. */
export type MaceParameters={schemaVersion:1;piece:"mace.flanged";haftLength:number;gripLength:number;headRadius:number;flanges:number;
 radialSegments:number;maxTriangles:number};
export type BookParameters={schemaVersion:1;piece:"book.tome";width:number;height:number;thickness:number;maxTriangles:number};
export type ThrowingKnifeParameters={schemaVersion:1;piece:"throwing-knife";bladeLength:number;bladeWidth:number;bladeThickness:number;
 gripLength:number;pinchOffset:number;radialSegments:number;maxTriangles:number};
export type VenomFlaskParameters={schemaVersion:1;piece:"venom-flask";bodyRadius:number;neckRadius:number;neckLength:number;fill:number;
 radialSegments:number;maxTriangles:number};
export type BlastingBombParameters={schemaVersion:1;piece:"blasting-bomb";radius:number;fuseLength:number;radialSegments:number;maxTriangles:number};
export type WeaponParameters=SwordParameters|DaggerParameters|ShieldParameters|StaffParameters|MaceParameters|BookParameters|
 ThrowingKnifeParameters|VenomFlaskParameters|BlastingBombParameters;

export const WEAPON_STAFFS=Object.freeze(["staff.bone","staff.gilded","staff.gnarled","staff.crystal"] as const) satisfies readonly StaffPiece[];
const isStaff=(piece:WeaponPiece):piece is StaffPiece=>(WEAPON_STAFFS as readonly string[]).includes(piece);

/** Style-spec triangle ceilings (docs/style-humanlike.md). `maxTriangles` may lower, never raise, them. */
export const WEAPON_TRIANGLE_BUDGETS=Object.freeze({"sword.arming":2500,"dagger.blackened":1500,"shield.heater":3000,
 "staff.bone":2500,"staff.gilded":2500,"staff.gnarled":2500,"staff.crystal":2500,"mace.flanged":1500,"book.tome":400,
 "throwing-knife":800,"venom-flask":1200,"blasting-bomb":1200}) satisfies Record<WeaponPiece,number>;
/** The attachment role each piece declares; humanoid-sockets-v2 sockets list the roles they accept. */
export const WEAPON_ROLES=Object.freeze({"sword.arming":"one-hand-weapon","dagger.blackened":"one-hand-weapon","shield.heater":"shield",
 "staff.bone":"staff","staff.gilded":"staff","staff.gnarled":"staff","staff.crystal":"staff","mace.flanged":"one-hand-weapon","book.tome":"book",
 // #467: `hand_r.weapon` and `belt.throwable` accept both roles; the bomb is held like the flask (Grip_Flask_R).
 "throwing-knife":"throwing-knife","venom-flask":"flask","blasting-bomb":"flask"}) satisfies Record<WeaponPiece,WeaponRole>;
export const WEAPON_MATERIALS=Object.freeze({"sword.arming":Object.freeze(["steel","iron","leather"] as const),
 "dagger.blackened":Object.freeze(["steel","charcoal","leather.dark"] as const),
 "shield.heater":Object.freeze(["paint","wood","iron","leather"] as const),
 "staff.bone":Object.freeze(["bone","orb.green"] as const),
 "staff.gilded":Object.freeze(["ivory","gold","orb.gold"] as const),
 "staff.gnarled":Object.freeze(["wood.dark","orb.moss"] as const),
 "staff.crystal":Object.freeze(["silver","crystal.blue"] as const),
 "mace.flanged":Object.freeze(["gold","wood.dark","leather"] as const),
 "book.tome":Object.freeze(["cover","parchment","gold"] as const),
 "throwing-knife":Object.freeze(["steel","charcoal","leather"] as const),
 "venom-flask":Object.freeze(["glass","venom","cork"] as const),
 "blasting-bomb":Object.freeze(["iron.slate","paint.red","brass","fuse","ember"] as const)}) satisfies Record<WeaponPiece,readonly string[]>;
/** The glowing materials (the orbs, the venom and the fuse's ember); their base colour is also their glTF emissive factor. */
export const WEAPON_EMISSIVE_MATERIALS=Object.freeze(["orb.green","orb.gold","orb.moss","crystal.blue","venom","ember"] as const);
/** The see-through materials (glTF alphaMode BLEND) and their base colour alpha: the flask's glass. */
export const WEAPON_ALPHA_MATERIALS=Object.freeze({glass:.32});
/** Every GLB's origin is its grip frame; the empty node `grip` sits there with an identity transform. */
export const WEAPON_GRIP_CONTRACT=Object.freeze({schemaVersion:1,unit:"meter",axes:"right-handed-y-up",origin:"grip",gripNode:"grip",
 "sword.arming":"origin at the centre of the hand's contact on the grip; blade along +Y, cutting edges along +X/-X, flats facing +Z/-Z",
 "dagger.blackened":"as the sword",
 "shield.heater":"origin at the centre of the hand handle, which runs along Y (across the palm); face toward +Z, point toward -Y, left forearm across the board from the handle along +X to the strap; the back of the hand and the forearm rest against the board",
 staff:"origin at the centre of the hand's contact on the shaft; shaft along +Y from the foot (footLength below) to the head and orb at the top",
 "mace.flanged":"as the sword: haft along +Y to the flanged head",
 "book.tome":"held like the shield: origin at the middle of the back cover, spine along +Y (the forearm), covers facing +Z/-Z, the book standing off the hand toward +Z",
 "throwing-knife":"origin at the hand_r.weapon pinch frame (Grip_Knife_Pinch_R): the knife's axis runs along +Y through (x -0.015, z -0.02), the point pinchOffset below the origin inside the fist, the handle out of the thumb side toward +Y; flats facing +X/-X (thumb and index), edges +Z/-Z",
 "venom-flask":"origin at the centre of the round body (the Grip_Flask_R ball); neck and cork toward +Y, out of the thumb side",
 "blasting-bomb":"origin at the centre of the ball (the Grip_Flask_R ball); fuse collar and fuse toward +Y, out of the thumb side"});

const STAFF={length:[1.5,2.2],footLength:[.5,1],shaftRadius:[.014,.03],orbRadius:[.04,.1],radialSegments:[6,16,true]} as const;
const RANGES={
 "sword.arming":{bladeLength:[.5,1],bladeWidth:[.03,.07],bladeThickness:[.004,.012],fullerLength:[0,.8],guardWidth:[.12,.3],
  gripLength:[.08,.22],pommelRadius:[.015,.04],radialSegments:[6,24,true]},
 "dagger.blackened":{bladeLength:[.2,.45],bladeWidth:[.02,.045],bladeThickness:[.003,.01],fullerLength:[0,.8],guardWidth:[.05,.14],
  gripLength:[.07,.13],pommelRadius:[.01,.025],radialSegments:[6,24,true]},
 "shield.heater":{width:[.36,.8],height:[.45,1],curvature:[0,.12],thickness:[.008,.04],rimWidth:[.008,.05],bossRadius:[.03,.12],outlineSegments:[6,32,true]},
 "staff.bone":STAFF,"staff.gilded":STAFF,"staff.gnarled":STAFF,"staff.crystal":STAFF,
 "mace.flanged":{haftLength:[.35,.7],gripLength:[.08,.2],headRadius:[.03,.07],flanges:[4,8,true],radialSegments:[6,16,true]},
 "book.tome":{width:[.12,.26],height:[.16,.34],thickness:[.03,.09]},
 "throwing-knife":{bladeLength:[.1,.2],bladeWidth:[.018,.035],bladeThickness:[.002,.006],gripLength:[.06,.12],pinchOffset:[.02,.06],
  radialSegments:[4,16,true]},
 "venom-flask":{bodyRadius:[.03,.05],neckRadius:[.007,.016],neckLength:[.015,.06],fill:[.3,.9],radialSegments:[6,24,true]},
 "blasting-bomb":{radius:[.03,.05],fuseLength:[.02,.08],radialSegments:[6,24,true]},
} as const satisfies Record<WeaponPiece,Record<string,readonly [number,number]|readonly [number,number,true]>>;

function number(value:unknown,label:string,min:number,max:number,integer=false):number {
 if(typeof value!=="number" || !Number.isFinite(value) || value<min || value>max || (integer && !Number.isSafeInteger(value))) throw new Error(`weapon ${label} must be ${integer?"an integer":"finite"} in ${min}..${max}`);
 return value;
}
export function normalizeWeaponParameters(value:unknown):WeaponParameters {
 if(!value || typeof value!=="object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error("weapon parameters must be a plain object");
 // Admit the external JSON record before reading its declared controls.
 const p=value as Record<string,unknown>;
 if(typeof p.piece!=="string" || !Object.hasOwn(RANGES,p.piece)) throw new Error(`weapon piece must be one of ${Object.keys(RANGES).join(", ")}`);
 const piece=p.piece as WeaponPiece,ranges:Record<string,readonly number[]|readonly [number,number,true]>=RANGES[piece];
 const keys=["schemaVersion","piece","maxTriangles",...Object.keys(ranges)];
 if(Object.keys(p).length!==keys.length || keys.some(k=>!Object.hasOwn(p,k))) throw new Error("weapon requires exactly the declared controls");
 if(p.schemaVersion!==1) throw new Error("weapon schemaVersion must be 1");
 const result:Record<string,unknown>={schemaVersion:1,piece};
 for(const [key,[min,max,integer]] of Object.entries(ranges)) result[key]=number(p[key],key,min!,max!,integer===true);
 result.maxTriangles=number(p.maxTriangles,"maxTriangles",12,WEAPON_TRIANGLE_BUDGETS[piece],true);
 if(isStaff(piece)) {
  const s=result as StaffParameters;
  if(s.footLength>s.length/2 || s.orbRadius<s.shaftRadius*2) throw new Error("staff foot must be at most half its length and the orb twice as wide as the shaft");
  return s;
 }
 if(piece==="mace.flanged") {
  const m=result as MaceParameters;
  if(m.gripLength>m.haftLength/2) throw new Error("mace grip must be at most half the haft");
  return m;
 }
 if(piece==="book.tome") {
  const b=result as BookParameters;
  if(b.height<b.width || b.thickness*2>b.width) throw new Error("tome must be taller than wide and at most half as thick as wide");
  return b;
 }
 if(piece==="throwing-knife") {
  const k=result as ThrowingKnifeParameters;
  if(k.bladeThickness*3>k.bladeWidth || k.pinchOffset*2>k.bladeLength) throw new Error("throwing knife blade must be three times as wide as thick and pinched in its point half");
  return k;
 }
 if(piece==="venom-flask") {
  const f=result as VenomFlaskParameters;
  if(f.neckRadius*2>f.bodyRadius) throw new Error("flask neck must be at most half as wide as the body");
  return f;
 }
 if(piece==="blasting-bomb") return result as BlastingBombParameters;
 if(piece==="sword.arming" || piece==="dagger.blackened") {
  const s=result as SwordParameters|DaggerParameters;
  if(s.bladeThickness*3>s.bladeWidth || s.guardWidth<s.bladeWidth*2) throw new Error("sword blade must be three times as wide as thick and the guard twice as wide as the blade");
  return s;
 }
 const h=result as ShieldParameters;
 if(h.height<h.width || Math.max(h.bossRadius*4,h.rimWidth*8,h.curvature*4)>h.width) throw new Error("heater shield must be taller than wide with boss, rim and curvature in proportion");
 return h;
}
export async function readWeaponRecipeSource() {
 return readBlenderRecipeSource("weapon.py");
}
export function createWeaponAssetSpec({assetId,parameters,scriptSha256,blenderVersion,scriptPath="weapon.py",outputPath="weapon.glb"}:{
 assetId:string;parameters:unknown;scriptSha256:string;blenderVersion:string;scriptPath?:string;outputPath?:string;
}) {
 if(!/^\d+\.\d+\.\d+$/.test(blenderVersion)) throw new Error("weapon Blender version must be exact");
 if(!scriptPath.endsWith(".py") || !outputPath.endsWith(".glb")) throw new Error("weapon spec requires a Python script and GLB output");
 return parseAssetSpec({schemaVersion:1,assetId,generator:{id:"external.blender.script",version:"1"},randomness:{mode:"none"},
  inputs:{script:{path:scriptPath,sha256:scriptSha256}},models:{},parameters:{blenderVersion,arguments:normalizeWeaponParameters(parameters)},
  output:{path:outputPath},reproducibility:{expected:"exact"}});
}

/** The class staffs share mmorpg's procedural staff proportions: 1.85 m, the grip 0.8 m above the foot, a 7.5 cm orb. */
const staff=<P extends StaffPiece>(piece:P)=>Object.freeze({schemaVersion:1,piece,length:1.85,footLength:.8,shaftRadius:.022,orbRadius:.075,
 radialSegments:10,maxTriangles:2500} as const);
export const WEAPON_PRESETS=Object.freeze({
 "sword.arming":Object.freeze({schemaVersion:1,piece:"sword.arming",bladeLength:.755,bladeWidth:.05,bladeThickness:.008,fullerLength:.6,
  guardWidth:.2,gripLength:.13,pommelRadius:.026,radialSegments:16,maxTriangles:2500}),
 "dagger.blackened":Object.freeze({schemaVersion:1,piece:"dagger.blackened",bladeLength:.35,bladeWidth:.034,bladeThickness:.007,fullerLength:.5,
  guardWidth:.095,gripLength:.1,pommelRadius:.017,radialSegments:12,maxTriangles:1500}),
 "shield.heater":Object.freeze({schemaVersion:1,piece:"shield.heater",width:.56,height:.72,curvature:.06,thickness:.016,rimWidth:.022,
  bossRadius:.07,outlineSegments:16,maxTriangles:3000}),
 "staff.bone":staff("staff.bone"),"staff.gilded":staff("staff.gilded"),"staff.gnarled":staff("staff.gnarled"),
 // #379: the Arcanist's slim crystal staff: the class staff length and grip, a thinner shaft and a 4 cm crystal.
 "staff.crystal":Object.freeze({schemaVersion:1,piece:"staff.crystal",length:1.85,footLength:.8,shaftRadius:.016,orbRadius:.04,
  radialSegments:10,maxTriangles:2500}),
 "mace.flanged":Object.freeze({schemaVersion:1,piece:"mace.flanged",haftLength:.5,gripLength:.13,headRadius:.05,flanges:6,radialSegments:12,
  maxTriangles:1500}),
 "book.tome":Object.freeze({schemaVersion:1,piece:"book.tome",width:.17,height:.23,thickness:.055,maxTriangles:400}),
 // #467: a 0.26 m knife whose balance sits at the bolster, and a flask and bomb sized to the 4 cm Grip_Flask_R ball.
 "throwing-knife":Object.freeze({schemaVersion:1,piece:"throwing-knife",bladeLength:.14,bladeWidth:.028,bladeThickness:.004,gripLength:.095,
  pinchOffset:.035,radialSegments:8,maxTriangles:800}),
 "venom-flask":Object.freeze({schemaVersion:1,piece:"venom-flask",bodyRadius:.04,neckRadius:.011,neckLength:.03,fill:.7,radialSegments:16,
  maxTriangles:1200}),
 "blasting-bomb":Object.freeze({schemaVersion:1,piece:"blasting-bomb",radius:.04,fuseLength:.05,radialSegments:16,maxTriangles:1200}),
}) satisfies {[P in WeaponPiece]:WeaponParameters&{piece:P}};

export const WEAPON_THROWABLES=Object.freeze(["throwing-knife","venom-flask","blasting-bomb"] as const) satisfies readonly ThrowablePiece[];
/**
 * #467: the throwables' levels of detail: the same recipe with fewer segments round each lathe (`lod1`, `lod2`), in the
 * same grip frame. Their screen-size switch points are `WEAPON_LOD_SCREEN_SIZES`.
 */
export const WEAPON_LOD_PRESETS=Object.freeze({
 "throwing-knife":Object.freeze({lod1:Object.freeze({...WEAPON_PRESETS["throwing-knife"],radialSegments:6}),
  lod2:Object.freeze({...WEAPON_PRESETS["throwing-knife"],radialSegments:4})}),
 "venom-flask":Object.freeze({lod1:Object.freeze({...WEAPON_PRESETS["venom-flask"],radialSegments:10}),
  lod2:Object.freeze({...WEAPON_PRESETS["venom-flask"],radialSegments:6})}),
 "blasting-bomb":Object.freeze({lod1:Object.freeze({...WEAPON_PRESETS["blasting-bomb"],radialSegments:10}),
  lod2:Object.freeze({...WEAPON_PRESETS["blasting-bomb"],radialSegments:6})}),
}) satisfies {[P in ThrowablePiece]:{lod1:WeaponParameters&{piece:P};lod2:WeaponParameters&{piece:P}}};
/**
 * The throwables' `minScreenSize` per level after the first (projected bounding-sphere diameter over the viewport height,
 * the #457 `projected-bounding-sphere-height-fraction` metric): `lod1` below 3 % of the screen height, `lod2` below 1.2 %.
 */
export const WEAPON_LOD_SCREEN_SIZES=Object.freeze([.03,.012] as const);
