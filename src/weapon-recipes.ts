import {readBlenderRecipeSource} from "./blender-recipe-source.js";
import {parseAssetSpec} from "./schema.js";

export type WeaponPiece="sword.arming"|"shield.heater";
export type WeaponRole="one-hand-weapon"|"shield";
export type SwordParameters={schemaVersion:1;piece:"sword.arming";bladeLength:number;bladeWidth:number;bladeThickness:number;
 fullerLength:number;guardWidth:number;gripLength:number;pommelRadius:number;radialSegments:number;maxTriangles:number};
export type ShieldParameters={schemaVersion:1;piece:"shield.heater";width:number;height:number;curvature:number;thickness:number;
 rimWidth:number;bossRadius:number;outlineSegments:number;maxTriangles:number};
export type WeaponParameters=SwordParameters|ShieldParameters;

/** Style-spec triangle ceilings (docs/style-humanlike.md). `maxTriangles` may lower, never raise, them. */
export const WEAPON_TRIANGLE_BUDGETS=Object.freeze({"sword.arming":2500,"shield.heater":3000}) satisfies Record<WeaponPiece,number>;
/** The attachment role each piece declares; humanoid-sockets-v2 sockets list the roles they accept. */
export const WEAPON_ROLES=Object.freeze({"sword.arming":"one-hand-weapon","shield.heater":"shield"}) satisfies Record<WeaponPiece,WeaponRole>;
export const WEAPON_MATERIALS=Object.freeze({"sword.arming":Object.freeze(["steel","iron","leather"] as const),
 "shield.heater":Object.freeze(["paint","wood","iron","leather"] as const)}) satisfies Record<WeaponPiece,readonly string[]>;
/** Every GLB's origin is its grip frame; the empty node `grip` sits there with an identity transform. */
export const WEAPON_GRIP_CONTRACT=Object.freeze({schemaVersion:1,unit:"meter",axes:"right-handed-y-up",origin:"grip",gripNode:"grip",
 "sword.arming":"origin at the centre of the hand's contact on the grip; blade along +Y, cutting edges along +X/-X, flats facing +Z/-Z",
 "shield.heater":"origin at the centre of the hand handle, which runs along X; face toward +Z, point toward -Y, forearm from the handle along +Y; the back of the hand and the forearm rest against the board"});

const RANGES={
 "sword.arming":{bladeLength:[.5,1],bladeWidth:[.03,.07],bladeThickness:[.004,.012],fullerLength:[0,.8],guardWidth:[.12,.3],
  gripLength:[.08,.22],pommelRadius:[.015,.04],radialSegments:[6,24,true]},
 "shield.heater":{width:[.36,.8],height:[.45,1],curvature:[0,.12],thickness:[.008,.04],rimWidth:[.008,.05],bossRadius:[.03,.12],outlineSegments:[6,32,true]},
} as const satisfies Record<WeaponPiece,Record<string,readonly [number,number]|readonly [number,number,true]>>;

function number(value:unknown,label:string,min:number,max:number,integer=false):number {
 if(typeof value!=="number" || !Number.isFinite(value) || value<min || value>max || (integer && !Number.isSafeInteger(value))) throw new Error(`weapon ${label} must be ${integer?"an integer":"finite"} in ${min}..${max}`);
 return value;
}
export function normalizeWeaponParameters(value:unknown):WeaponParameters {
 if(!value || typeof value!=="object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error("weapon parameters must be a plain object");
 // Admit the external JSON record before reading its declared controls.
 const p=value as Record<string,unknown>;
 if(typeof p.piece!=="string" || !Object.hasOwn(RANGES,p.piece)) throw new Error("weapon piece must be sword.arming or shield.heater");
 const piece=p.piece as WeaponPiece,ranges:Record<string,readonly number[]|readonly [number,number,true]>=RANGES[piece];
 const keys=["schemaVersion","piece","maxTriangles",...Object.keys(ranges)];
 if(Object.keys(p).length!==keys.length || keys.some(k=>!Object.hasOwn(p,k))) throw new Error("weapon requires exactly the declared controls");
 if(p.schemaVersion!==1) throw new Error("weapon schemaVersion must be 1");
 const result:Record<string,unknown>={schemaVersion:1,piece};
 for(const [key,[min,max,integer]] of Object.entries(ranges)) result[key]=number(p[key],key,min!,max!,integer===true);
 result.maxTriangles=number(p.maxTriangles,"maxTriangles",12,WEAPON_TRIANGLE_BUDGETS[piece],true);
 if(piece==="sword.arming") {
  const s=result as SwordParameters;
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

export const WEAPON_PRESETS=Object.freeze({
 "sword.arming":Object.freeze({schemaVersion:1,piece:"sword.arming",bladeLength:.755,bladeWidth:.05,bladeThickness:.008,fullerLength:.6,
  guardWidth:.2,gripLength:.13,pommelRadius:.026,radialSegments:16,maxTriangles:2500}),
 "shield.heater":Object.freeze({schemaVersion:1,piece:"shield.heater",width:.56,height:.72,curvature:.06,thickness:.016,rimWidth:.022,
  bossRadius:.07,outlineSegments:16,maxTriangles:3000}),
}) satisfies {"sword.arming":SwordParameters;"shield.heater":ShieldParameters};
