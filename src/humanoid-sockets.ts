/**
 * humanoid-sockets-v1: attachment frames on a humanoid rig, shipped with the character bundle.
 *
 * A socket names a rig joint and a local transform. Attaching an item puts the item's grip frame
 * (the asset origin of a weapon recipe GLB) at `joint world × T(translation) × R(rotation) × S(scale)`.
 * Values are in the joint's local glTF frame: metres, right-handed +Y up. See docs/humanoid-sockets.md.
 */
export const HUMANOID_SOCKETS_SCHEMA="humanoid-sockets-v1";
export type HumanoidSocket={id:string;joint:string;translation:[number,number,number];rotation:[number,number,number,number];
 scale?:[number,number,number];accepts:string[]};
export type HumanoidSocketDescriptor={schema:typeof HUMANOID_SOCKETS_SCHEMA;character:string;unit:"meter";axes:"right-handed-y-up";
 attachFrame:"grip";sockets:HumanoidSocket[]};

const SOCKET_ID=/^[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+(?:[_-][a-z0-9]+)*)+$/;
const ROLE=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CHARACTER=/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

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

/** Validate a descriptor; with `joints`, every socket joint must name one of them (for example a skin's joint names). */
export function validateHumanoidSocketDescriptor(value:unknown,{joints}:{joints?:readonly string[]|undefined}={}):HumanoidSocketDescriptor {
 const d=plain(value,"humanoid socket descriptor",["schema","character","unit","axes","attachFrame","sockets"]);
 if(d.schema!==HUMANOID_SOCKETS_SCHEMA) throw new Error(`humanoid socket descriptor schema must be ${HUMANOID_SOCKETS_SCHEMA}`);
 if(typeof d.character!=="string" || !CHARACTER.test(d.character)) throw new Error("humanoid socket descriptor character must be a bundle key");
 if(d.unit!=="meter" || d.axes!=="right-handed-y-up" || d.attachFrame!=="grip") throw new Error("humanoid sockets are in metres, right-handed +Y up, attaching the item's grip frame");
 if(!Array.isArray(d.sockets) || d.sockets.length===0 || d.sockets.length>256) throw new Error("humanoid socket descriptor needs 1..256 sockets");
 const known=joints?new Set(joints):undefined,ids=new Set<string>();
 const sockets=d.sockets.map((entry:unknown,index)=>{
  const s=plain(entry,`socket ${index}`,["id","joint","translation","rotation","accepts"],["scale"]);
  if(typeof s.id!=="string" || !SOCKET_ID.test(s.id)) throw new Error(`socket ${index} id must look like 'joint.purpose'`);
  if(ids.has(s.id)) throw new Error(`duplicate socket id '${s.id}'`);
  ids.add(s.id);
  if(typeof s.joint!=="string" || s.joint.length===0 || s.joint.length>256) throw new Error(`socket '${s.id}' joint must be a joint name`);
  if(known && !known.has(s.joint)) throw new Error(`socket '${s.id}' names unknown joint '${s.joint}'`);
  const translation=vector(s.translation,3,`socket '${s.id}' translation`);
  if(translation.some(v=>Math.abs(v)>10)) throw new Error(`socket '${s.id}' translation must stay within 10 m of its joint`);
  const rotation=vector(s.rotation,4,`socket '${s.id}' rotation`);
  if(Math.abs(Math.hypot(...rotation)-1)>1e-6) throw new Error(`socket '${s.id}' rotation must be a unit quaternion (x, y, z, w)`);
  if(!Array.isArray(s.accepts) || s.accepts.length===0 || !s.accepts.every(r=>typeof r==="string" && ROLE.test(r)) || new Set(s.accepts).size!==s.accepts.length) throw new Error(`socket '${s.id}' accepts must list unique roles`);
  const socket:HumanoidSocket={id:s.id,joint:s.joint,translation:translation as HumanoidSocket["translation"],rotation:rotation as HumanoidSocket["rotation"],accepts:[...s.accepts as string[]]};
  if(s.scale!==undefined) {
   const scale=vector(s.scale,3,`socket '${s.id}' scale`);
   if(scale.some(v=>v<=0 || v>100)) throw new Error(`socket '${s.id}' scale must be positive`);
   socket.scale=scale as [number,number,number];
  }
  return socket;
 });
 return {schema:HUMANOID_SOCKETS_SCHEMA,character:d.character,unit:"meter",axes:"right-handed-y-up",attachFrame:"grip",sockets};
}

/** Build a validated descriptor in canonical field order. */
export function createHumanoidSocketDescriptor({character,sockets,joints}:{character:string;sockets:readonly HumanoidSocket[];joints?:readonly string[]}):HumanoidSocketDescriptor {
 return validateHumanoidSocketDescriptor({schema:HUMANOID_SOCKETS_SCHEMA,character,unit:"meter",axes:"right-handed-y-up",attachFrame:"grip",sockets},{joints});
}

/** Ids of the sockets that accept `role`, in descriptor order. */
export function humanoidSocketsAccepting(descriptor:HumanoidSocketDescriptor,role:string):string[] {
 return descriptor.sockets.filter(s=>s.accepts.includes(role)).map(s=>s.id);
}

/** Column-major 4×4 local matrix T × R × S of a socket, as glTF node matrices are laid out. */
export function humanoidSocketMatrix(socket:HumanoidSocket):number[] {
 const [x,y,z,w]=socket.rotation,[sx,sy,sz]=socket.scale ?? [1,1,1],[tx,ty,tz]=socket.translation;
 return [
  (1-2*(y*y+z*z))*sx,2*(x*y+z*w)*sx,2*(x*z-y*w)*sx,0,
  2*(x*y-z*w)*sy,(1-2*(x*x+z*z))*sy,2*(y*z+x*w)*sy,0,
  2*(x*z+y*w)*sz,2*(y*z-x*w)*sz,(1-2*(x*x+y*y))*sz,0,
  tx,ty,tz,1,
 ];
}
