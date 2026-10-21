/**
 * humanoid-sockets-v2: attachment frames on a humanoid rig, shipped with the character bundle, and
 * humanoid-item-v1: the roles and named attach frames of one attachable item, shipped with the item entry.
 *
 * A socket names a rig joint, a local transform and the item frame it holds. Attaching an item puts that item frame
 * at `joint world × T(translation) × R(rotation) × S(scale)`, so the item's scene root goes to
 * `joint world × socket × inverse(frame)` (`humanoidAttachmentMatrix`). Values are in the joint's local glTF frame:
 * metres, right-handed +Y up. See docs/humanoid-sockets.md.
 */
export const HUMANOID_SOCKETS_SCHEMA="humanoid-sockets-v2";
export const HUMANOID_ITEM_SCHEMA="humanoid-item-v1";
type Vec3=[number,number,number];
type Quat=[number,number,number,number];
export type HumanoidSocket={id:string;joint:string;translation:Vec3;rotation:Quat;scale?:Vec3;attachFrame:string;accepts:string[];mirror?:string};
export type HumanoidSocketDescriptor={schema:typeof HUMANOID_SOCKETS_SCHEMA;character:string;unit:"meter";axes:"right-handed-y-up";sockets:HumanoidSocket[]};
export type HumanoidItemFrame={name:string;translation:Vec3;rotation:Quat;scale?:Vec3};
export type HumanoidItemDescriptor={schema:typeof HUMANOID_ITEM_SCHEMA;item:string;unit:"meter";axes:"right-handed-y-up";roles:string[];frames:HumanoidItemFrame[]};

const SOCKET_ID=/^[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+(?:[_-][a-z0-9]+)*)+$/;
const ROLE=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY=/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const FRAME=/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function plain(value:unknown,label:string,keys:readonly string[],optional:readonly string[]=[]):Record<string,unknown> {
 if(!value || typeof value!=="object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be a plain object`);
 const record=value as Record<string,unknown>;
 for(const key of Object.keys(record)) if(!keys.includes(key) && !optional.includes(key)) throw new Error(`${label} has unknown field '${key}'`);
 for(const key of keys) if(!Object.hasOwn(record,key)) throw new Error(`${label} requires '${key}'`);
 return record;
}
function vector<N extends 3|4>(value:unknown,length:N,label:string):number[] {
 if(!Array.isArray(value) || value.length!==length || !value.every(v=>typeof v==="number" && Number.isFinite(v))) throw new Error(`${label} must be ${length} finite numbers`);
 return [...value as number[]];
}
function roles(value:unknown,label:string):string[] {
 if(!Array.isArray(value) || value.length===0 || !value.every(r=>typeof r==="string" && ROLE.test(r)) || new Set(value).size!==value.length) throw new Error(`${label} must list unique roles`);
 return [...value as string[]];
}
/** Translation, unit-quaternion rotation and optional positive scale of a socket or frame. */
function transform(s:Record<string,unknown>,label:string):{translation:Vec3;rotation:Quat;scale?:Vec3} {
 const translation=vector(s.translation,3,`${label} translation`);
 if(translation.some(v=>Math.abs(v)>10)) throw new Error(`${label} translation must stay within 10 m`);
 const rotation=vector(s.rotation,4,`${label} rotation`);
 if(Math.abs(Math.hypot(...rotation)-1)>1e-6) throw new Error(`${label} rotation must be a unit quaternion (x, y, z, w)`);
 if(s.scale===undefined) return {translation:translation as Vec3,rotation:rotation as Quat};
 const scale=vector(s.scale,3,`${label} scale`);
 if(scale.some(v=>v<=0 || v>100)) throw new Error(`${label} scale must be positive`);
 return {translation:translation as Vec3,rotation:rotation as Quat,scale:scale as Vec3};
}
function frameName(value:unknown,label:string):string {
 if(typeof value!=="string" || !FRAME.test(value)) throw new Error(`${label} must be a frame name such as 'grip' or 'grip.offhand'`);
 return value;
}

/**
 * Validate a descriptor; with `joints`, every socket joint must name one of them (for example a skin's joint names).
 * A `mirror` names the socket's counterpart on the other side, which must mirror it back and accept the same roles.
 */
export function validateHumanoidSocketDescriptor(value:unknown,{joints}:{joints?:readonly string[]|undefined}={}):HumanoidSocketDescriptor {
 const d=plain(value,"humanoid socket descriptor",["schema","character","unit","axes","sockets"]);
 if(d.schema!==HUMANOID_SOCKETS_SCHEMA) throw new Error(`humanoid socket descriptor schema must be ${HUMANOID_SOCKETS_SCHEMA}`);
 if(typeof d.character!=="string" || !KEY.test(d.character)) throw new Error("humanoid socket descriptor character must be a bundle key");
 if(d.unit!=="meter" || d.axes!=="right-handed-y-up") throw new Error("humanoid sockets are in metres, right-handed +Y up");
 if(!Array.isArray(d.sockets) || d.sockets.length===0 || d.sockets.length>256) throw new Error("humanoid socket descriptor needs 1..256 sockets");
 const known=joints?new Set(joints):undefined,ids=new Set<string>();
 const sockets=d.sockets.map((entry:unknown,index)=>{
  const s=plain(entry,`socket ${index}`,["id","joint","translation","rotation","attachFrame","accepts"],["scale","mirror"]);
  if(typeof s.id!=="string" || !SOCKET_ID.test(s.id)) throw new Error(`socket ${index} id must look like 'joint.purpose'`);
  if(ids.has(s.id)) throw new Error(`duplicate socket id '${s.id}'`);
  ids.add(s.id);
  if(typeof s.joint!=="string" || s.joint.length===0 || s.joint.length>256) throw new Error(`socket '${s.id}' joint must be a joint name`);
  if(known && !known.has(s.joint)) throw new Error(`socket '${s.id}' names unknown joint '${s.joint}'`);
  const {translation,rotation,scale}=transform(s,`socket '${s.id}'`);
  const socket:HumanoidSocket={id:s.id,joint:s.joint,translation,rotation,...(scale?{scale}:{}),
   attachFrame:frameName(s.attachFrame,`socket '${s.id}' attachFrame`),accepts:roles(s.accepts,`socket '${s.id}' accepts`)};
  if(s.mirror!==undefined) {
   if(typeof s.mirror!=="string" || !SOCKET_ID.test(s.mirror) || s.mirror===s.id) throw new Error(`socket '${s.id}' mirror must name another socket`);
   socket.mirror=s.mirror;
  }
  return socket;
 });
 const byId=new Map(sockets.map(s=>[s.id,s]));
 for(const s of sockets) {
  if(s.mirror===undefined) continue;
  const other=byId.get(s.mirror);
  if(!other) throw new Error(`socket '${s.id}' mirrors unknown socket '${s.mirror}'`);
  if(other.mirror!==s.id) throw new Error(`socket '${s.mirror}' must mirror '${s.id}' back`);
  if(other.attachFrame!==s.attachFrame || [...other.accepts].sort().join()!==[...s.accepts].sort().join()) throw new Error(`mirrored sockets '${s.id}' and '${s.mirror}' must hold the same frame and accept the same roles`);
 }
 return {schema:HUMANOID_SOCKETS_SCHEMA,character:d.character,unit:"meter",axes:"right-handed-y-up",sockets};
}

/** Build a validated descriptor in canonical field order. */
export function createHumanoidSocketDescriptor({character,sockets,joints}:{character:string;sockets:readonly HumanoidSocket[];joints?:readonly string[]}):HumanoidSocketDescriptor {
 return validateHumanoidSocketDescriptor({schema:HUMANOID_SOCKETS_SCHEMA,character,unit:"meter",axes:"right-handed-y-up",sockets},{joints});
}

/** Ids of the sockets that accept `role`, in descriptor order. */
export function humanoidSocketsAccepting(descriptor:HumanoidSocketDescriptor,role:string):string[] {
 return descriptor.sockets.filter(s=>s.accepts.includes(role)).map(s=>s.id);
}

/** The mirrored counterpart of socket `id` (for a left-handed loadout), or undefined when it declares none. */
export function humanoidSocketMirror(descriptor:HumanoidSocketDescriptor,id:string):HumanoidSocket|undefined {
 const socket=descriptor.sockets.find(s=>s.id===id);
 if(!socket) throw new Error(`no socket '${id}'`);
 return socket.mirror===undefined ? undefined : descriptor.sockets.find(s=>s.id===socket.mirror);
}

/** Validate an item descriptor: its roles and its named attach frames in the item's glTF scene frame. */
export function validateHumanoidItemDescriptor(value:unknown):HumanoidItemDescriptor {
 const d=plain(value,"humanoid item descriptor",["schema","item","unit","axes","roles","frames"]);
 if(d.schema!==HUMANOID_ITEM_SCHEMA) throw new Error(`humanoid item descriptor schema must be ${HUMANOID_ITEM_SCHEMA}`);
 if(typeof d.item!=="string" || !KEY.test(d.item)) throw new Error("humanoid item descriptor item must be a bundle key");
 if(d.unit!=="meter" || d.axes!=="right-handed-y-up") throw new Error("humanoid item frames are in metres, right-handed +Y up");
 if(!Array.isArray(d.frames) || d.frames.length===0 || d.frames.length>32) throw new Error("humanoid item descriptor needs 1..32 frames");
 const names=new Set<string>();
 const frames=d.frames.map((entry:unknown,index)=>{
  const f=plain(entry,`frame ${index}`,["name","translation","rotation"],["scale"]);
  const name=frameName(f.name,`frame ${index} name`);
  if(names.has(name)) throw new Error(`duplicate frame '${name}'`);
  names.add(name);
  return {name,...transform(f,`frame '${name}'`)};
 });
 return {schema:HUMANOID_ITEM_SCHEMA,item:d.item,unit:"meter",axes:"right-handed-y-up",roles:roles(d.roles,"humanoid item roles"),frames};
}

/** Build a validated item descriptor in canonical field order. */
export function createHumanoidItemDescriptor({item,roles:itemRoles,frames}:{item:string;roles:readonly string[];frames:readonly HumanoidItemFrame[]}):HumanoidItemDescriptor {
 return validateHumanoidItemDescriptor({schema:HUMANOID_ITEM_SCHEMA,item,unit:"meter",axes:"right-handed-y-up",roles:[...itemRoles],frames:[...frames]});
}

function trs({translation:[tx,ty,tz],rotation:[x,y,z,w],scale:[sx,sy,sz]=[1,1,1]}:{translation:Vec3;rotation:Quat;scale?:Vec3}):number[] {
 return [
  (1-2*(y*y+z*z))*sx,2*(x*y+z*w)*sx,2*(x*z-y*w)*sx,0,
  2*(x*y-z*w)*sy,(1-2*(x*x+z*z))*sy,2*(y*z+x*w)*sy,0,
  2*(x*z+y*w)*sz,2*(y*z-x*w)*sz,(1-2*(x*x+y*y))*sz,0,
  tx,ty,tz,1,
 ];
}
/** Inverse of T × R × S, which is S⁻¹ × Rᵀ × T⁻¹. */
function inverseTrs(t:{translation:Vec3;rotation:Quat;scale?:Vec3}):number[] {
 const r=trs({translation:[0,0,0],rotation:t.rotation}),[sx,sy,sz]=t.scale ?? [1,1,1],inv=[1/sx,1/sy,1/sz];
 const m=new Array<number>(16).fill(0);
 // Row i of Rᵀ is column i of R; scale row i by 1/s_i.
 for(let c=0;c<3;c++) for(let i=0;i<3;i++) m[c*4+i]=r[i*4+c]!*inv[i]!;
 const [tx,ty,tz]=t.translation;
 for(let i=0;i<3;i++) m[12+i]=-(m[i]!*tx+m[4+i]!*ty+m[8+i]!*tz);
 m[15]=1;
 return m;
}
function multiply(a:number[],b:number[]):number[] {
 const out=new Array<number>(16).fill(0);
 for(let c=0;c<4;c++) for(let r=0;r<4;r++) for(let k=0;k<4;k++) out[c*4+r]!+=a[k*4+r]!*b[c*4+k]!;
 return out;
}

/** Column-major 4×4 local matrix T × R × S of a socket, as glTF node matrices are laid out. */
export function humanoidSocketMatrix(socket:HumanoidSocket):number[] {
 return trs(socket);
}

/** Column-major 4×4 matrix of an item frame in the item's scene frame. */
export function humanoidItemFrameMatrix(frame:HumanoidItemFrame):number[] {
 return trs(frame);
}

/**
 * Where the item's scene root goes in the socket joint's frame: `socket × inverse(frame)`, where `frame` is the item
 * frame the socket holds. Throws when the item declares no such frame or none of the roles the socket accepts.
 */
export function humanoidAttachmentMatrix(socket:HumanoidSocket,item:HumanoidItemDescriptor):number[] {
 if(!item.roles.some(role=>socket.accepts.includes(role))) throw new Error(`socket '${socket.id}' accepts none of the roles of '${item.item}'`);
 const frame=item.frames.find(f=>f.name===socket.attachFrame);
 if(!frame) throw new Error(`'${item.item}' has no '${socket.attachFrame}' frame for socket '${socket.id}'`);
 return multiply(trs(socket),inverseTrs(frame));
}
