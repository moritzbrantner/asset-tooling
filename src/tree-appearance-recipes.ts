import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { resolveAssetObject } from "./asset-store.js";
import { compareCodeUnitStrings } from "./canonical.js";
import { createAssetRef, type AssetRef, type AssetOperationBuildIdentity, type AssetOperationResult } from "./operations.js";
import { GLTF_IMPORT_OPERATION } from "./gltf-import-operations.js";
import { checkStaticGltfAccessorBudget, loadCheckedGltf } from "./gltf-processing.js";
import { createGltfBaseColorOperationBuildIdentity, executeGltfBaseColorOperation, type GltfBaseColorParameters } from "./gltf-material-operations.js";

export type TreeAppearanceState = { id:string; baseColor:AssetRef; factor:[number,number,number,number] };
export type TreeAppearanceFamily = {
  schemaVersion:1; id:string; source:AssetRef;
  placement:{axes:"right-handed-y-up";unit:"meter";origin:"native-root-ground-anchor"};
  states:TreeAppearanceState[];
};
export type TreeAppearanceResult = { id:string; build:AssetOperationBuildIdentity; result:AssetOperationResult; output:AssetRef };
function object(value:unknown,keys:readonly string[],label:string):Record<string,unknown> {
  if(!value || typeof value!=="object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be a plain object`);
  const p=value as Record<string,unknown>;
  if(Object.keys(p).some(key=>!keys.includes(key)) || keys.some(key=>!Object.hasOwn(p,key))) throw new Error(`${label} requires exactly ${keys.join(", ")}`);
  return p;
}
function id(value:unknown):string {
  if(typeof value!=="string" || value.length>128 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)) throw new Error("appearance ID must be a portable lowercase token");
  return value;
}
function factor(value:unknown):[number,number,number,number] {
  if(!Array.isArray(value) || value.length!==4 || [value[0],value[1],value[2],value[3]].some(n=>typeof n!=="number" || !Number.isFinite(n) || n<0 || n>1)) throw new Error("appearance factor requires four finite 0..1 coordinates");
  return [value[0],value[1],value[2],value[3]];
}
/** Narrow native-ground tree family; other origin/component contracts need their own demonstrated recipe. */
export function normalizeTreeAppearanceFamily(value:unknown):TreeAppearanceFamily {
  const p=object(value,["schemaVersion","id","source","placement","states"],"tree appearance family");
  if(p.schemaVersion!==1) throw new Error("tree appearance schemaVersion must be 1");
  const placement=object(p.placement,["axes","unit","origin"],"tree placement"),source=createAssetRef(p.source);
  if(placement.axes!=="right-handed-y-up" || placement.unit!=="meter" || placement.origin!=="native-root-ground-anchor") throw new Error("unsupported tree axes/unit/origin");
  if(!["scene","mesh"].includes(source.kind) || source.mediaType!=="model/gltf-binary" || source.byteLength>64*1024*1024) throw new Error("tree source must be a bounded static GLB");
  for(const key of ["axes","unit","origin"]) if(source.metadata[key]!==placement[key]) throw new Error(`tree source ${key} does not match declared placement`);
  if(!Array.isArray(p.states) || p.states.length<1 || p.states.length>16) throw new Error("tree appearance family requires 1..16 states");
  const seen=new Set<string>(),states:TreeAppearanceState[]=p.states.map(value=>{
    const s=object(value,["id","baseColor","factor"],"tree appearance state"),stateId=id(s.id),baseColor=createAssetRef(s.baseColor);
    if(seen.has(stateId)) throw new Error(`duplicate appearance state '${stateId}'`);seen.add(stateId);
    if(baseColor.kind!=="image" || baseColor.mediaType!=="image/png") throw new Error("appearance base color must be PNG");
    return {id:stateId,baseColor,factor:factor(s.factor)};
  });
  states.sort((a,b)=>compareCodeUnitStrings(a.id,b.id));
  return {schemaVersion:1,id:id(p.id),source,placement:{axes:"right-handed-y-up",unit:"meter",origin:"native-root-ground-anchor"},states};
}
async function checkedFamily(root:string,value:unknown) {
  if(typeof root!=="string" || !path.isAbsolute(root)) throw new Error("tree appearance root must be absolute");
  const family=normalizeTreeAppearanceFamily(value);
  // Reuse the owner's header budget before sparse accessors can allocate decoded storage.
  const {json}=await new NodeIO().setAllowNetwork(false).setStrictResources(true).binaryToJSON(await resolveAssetObject(root,family.source));
  checkStaticGltfAccessorBudget(json,"tree appearance master");
  const {document}=await loadCheckedGltf(root,GLTF_IMPORT_OPERATION,{resourceUris:[]},{source:family.source},false);
  const nodes=document.getRoot().listNodes(),identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  if(nodes.length!==3 || document.getRoot().listScenes().length!==1 || document.getRoot().listScenes()[0]!.listChildren().length!==3) throw new Error("tree master requires exactly trunk/branches/foliage root components");
  for(const name of ["trunk","branches","foliage"]) {
    const matches=nodes.filter(n=>n.getName()===name);
    if(matches.length!==1) throw new Error(`tree master requires unique '${name}' component`);
    const node=matches[0]!,mesh=node.getMesh();
    if(node.listChildren().length || node.getMatrix().some((v,i)=>v!==identity[i]) || !mesh) throw new Error("tree components must preserve the native ground origin and identity transforms");
    let minY=Infinity;
    for(const primitive of mesh.listPrimitives()) {
      if(primitive.getMaterial()?.getName()!==(name==="foliage"?"tree-foliage":"tree-bark")) throw new Error("tree component material correspondence is incompatible");
      const positions=primitive.getAttribute("POSITION");if(!positions) throw new Error("tree component requires positions");
      const element:number[]=[];
      for(let i=0;i<positions.getCount();i++) minY=Math.min(minY,positions.getElement(i,element)[1]!);
    }
    if(!Number.isFinite(minY) || minY < -1e-6 || (name==="trunk" && Math.abs(minY)>1e-6)) throw new Error("tree component must preserve the native Y=0 ground anchor");
  }
  return family;
}
function invocation(family:TreeAppearanceFamily,state:TreeAppearanceState) {
  const parameters:GltfBaseColorParameters={materialName:"tree-foliage",baseColorFactor:state.factor,texCoord:0,
    sampler:{magFilter:"linear",minFilter:"linear",wrapS:"clamp-to-edge",wrapT:"clamp-to-edge"},alpha:{mode:"MASK",cutoff:0.5}};
  return {parameters,inputs:{source:family.source,"base-color":state.baseColor}};
}
async function execute(root:string,family:TreeAppearanceFamily,state:TreeAppearanceState,build:AssetOperationBuildIdentity):Promise<TreeAppearanceResult> {
  const result=await executeGltfBaseColorOperation(root,invocation(family,state));
  return {id:state.id,build,result,output:createAssetRef(result.outputs.output)};
}
/** Execute exactly the selected state's material derivation; no sibling operation or geometry generator runs. */
export async function executeTreeAppearanceState(root:string,value:unknown,stateId:string):Promise<TreeAppearanceResult> {
  const family=await checkedFamily(root,value),state=family.states.find(s=>s.id===stateId);
  if(!state) throw new Error(`unknown appearance state '${stateId}'`);
  return execute(root,family,state,await createGltfBaseColorOperationBuildIdentity(root,invocation(family,state)));
}
/** Authoritative full replay; preflight all dependencies before generating any family output. */
export async function executeTreeAppearanceFamily(root:string,value:unknown) {
  const family=await checkedFamily(root,value),builds:AssetOperationBuildIdentity[]=[];
  for(const state of family.states) builds.push(await createGltfBaseColorOperationBuildIdentity(root,invocation(family,state)));
  const states:TreeAppearanceResult[]=[];
  for(const [index,state] of family.states.entries()) states.push(await execute(root,family,state,builds[index]!));
  return {schemaVersion:1,family,states,execution:{materialOperations:states.length,geometryGenerators:0}};
}
