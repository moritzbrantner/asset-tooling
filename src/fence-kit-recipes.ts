import {readBlenderRecipeSource} from "./blender-recipe-source.js";
import {parseAssetSpec} from "./schema.js";

export type FenceDirection="east"|"north"|"west"|"south";
export type FencePiece="end"|"straight"|"corner"|"tee";
export type FenceParameters={schemaVersion:1;piece:FencePiece;cellSize:number;postWidth:number;postHeight:number;
 railCount:number;railHeight:number;railDepth:number;maxTriangles:number};

/** Counter-clockwise order seen from +Y; one quarter turn maps each direction to the next. */
export const FENCE_DIRECTIONS=Object.freeze(["east","north","west","south"] as const);
/** Ports at rotation 0. Pieces are rotationally symmetric art, so mirroring is never needed or supported. */
export const FENCE_PIECE_PORTS=Object.freeze({
 end:Object.freeze(["east"] as const),straight:Object.freeze(["east","west"] as const),
 corner:Object.freeze(["east","north"] as const),tee:Object.freeze(["east","north","west"] as const),
}) satisfies Record<FencePiece,readonly FenceDirection[]>;
/** glTF right-handed Y-up: east=+X, north=-Z, west=-X, south=+Z. Grid cell offsets use the same (x,z). */
export const FENCE_DIRECTION_VECTORS=Object.freeze({east:Object.freeze([1,0] as const),north:Object.freeze([0,-1] as const),
 west:Object.freeze([-1,0] as const),south:Object.freeze([0,1] as const)}) satisfies Record<FenceDirection,readonly [number,number]>;
export const FENCE_CONNECTION_CONTRACT=Object.freeze({schemaVersion:1,unit:"meter",axes:"right-handed-y-up",origin:"cell-center-ground",
 grid:"square-cells",rotation:"quarter-turns-counter-clockwise-about-+Y",mirroring:"unsupported",
 overlap:"rails end flush on the shared cell edge; no geometry crosses a cell boundary",
 port:"edge midpoint at ground height; rails at identical heights for identical parameters"});

const KEYS=["schemaVersion","piece","cellSize","postWidth","postHeight","railCount","railHeight","railDepth","maxTriangles"];
function number(value:unknown,label:string,min:number,max:number,integer=false):number {
 if(typeof value!=="number" || !Number.isFinite(value) || value<min || value>max || (integer && !Number.isSafeInteger(value))) throw new Error(`fence ${label} must be ${integer?"an integer":"finite"} in ${min}..${max}`);
 return value;
}
export function normalizeFenceParameters(value:unknown):FenceParameters {
 if(!value || typeof value!=="object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error("fence parameters must be a plain object");
 // Admit the external JSON record before reading its declared controls.
 const p=value as Record<string,unknown>;
 if(Object.keys(p).length!==KEYS.length || KEYS.some(k=>!Object.hasOwn(p,k))) throw new Error("fence requires exactly the declared controls");
 if(p.schemaVersion!==1) throw new Error("fence schemaVersion must be 1");
 if(typeof p.piece!=="string" || !Object.hasOwn(FENCE_PIECE_PORTS,p.piece)) throw new Error("fence piece must be end, straight, corner or tee");
 const result:FenceParameters={schemaVersion:1,piece:p.piece as FencePiece,cellSize:number(p.cellSize,"cellSize",.5,8),
  postWidth:number(p.postWidth,"postWidth",.02,.5),postHeight:number(p.postHeight,"postHeight",.2,3),railCount:number(p.railCount,"railCount",1,3,true),
  railHeight:number(p.railHeight,"railHeight",.01,.4),railDepth:number(p.railDepth,"railDepth",.01,.4),maxTriangles:number(p.maxTriangles,"maxTriangles",12,1000,true)};
 if(result.postWidth>result.cellSize/2 || result.railDepth>result.postWidth) throw new Error("fence post must fit half a cell and rails must not be deeper than the post");
 if(result.railCount*result.railHeight>result.postHeight/2) throw new Error("fence rails must occupy at most half the post height");
 return result;
}
export async function readFenceRecipeSource() {
 return readBlenderRecipeSource("fence.py");
}
export function createFenceAssetSpec({assetId,parameters,scriptSha256,blenderVersion,scriptPath="fence.py",outputPath="fence.glb"}:{
 assetId:string;parameters:unknown;scriptSha256:string;blenderVersion:string;scriptPath?:string;outputPath?:string;
}) {
 if(!/^\d+\.\d+\.\d+$/.test(blenderVersion)) throw new Error("fence Blender version must be exact");
 if(!scriptPath.endsWith(".py") || !outputPath.endsWith(".glb")) throw new Error("fence spec requires a Python script and GLB output");
 return parseAssetSpec({schemaVersion:1,assetId,generator:{id:"external.blender.script",version:"1"},randomness:{mode:"none"},
  inputs:{script:{path:scriptPath,sha256:scriptSha256}},models:{},parameters:{blenderVersion,arguments:normalizeFenceParameters(parameters)},
  output:{path:outputPath},reproducibility:{expected:"exact"}});
}

function quarterTurns(value:unknown):number {
 if(typeof value!=="number" || !Number.isSafeInteger(value) || value<0 || value>3) throw new Error("fence rotation must be 0..3 quarter turns");
 return value;
}
/** Port directions of a piece after a counter-clockwise rotation, in canonical direction order. */
export function fencePortsAfterRotation(piece:FencePiece,turns:number):FenceDirection[] {
 if(!Object.hasOwn(FENCE_PIECE_PORTS,piece)) throw new Error(`unknown fence piece '${String(piece)}'`);
 const t=quarterTurns(turns),rotated=new Set(FENCE_PIECE_PORTS[piece].map(d=>FENCE_DIRECTIONS[(FENCE_DIRECTIONS.indexOf(d)+t)%4]!));
 return FENCE_DIRECTIONS.filter(d=>rotated.has(d));
}
/** Port anchor in piece-local glTF meters for the rotated piece. */
export function fencePortAnchor(direction:FenceDirection,cellSize:number):[number,number,number] {
 const [x,z]=FENCE_DIRECTION_VECTORS[direction];
 return [x*cellSize/2,0,z*cellSize/2];
}

export type FencePlacement={id:string;piece:FencePiece;cell:[number,number];quarterTurns:number};
export type FenceLayoutReport={connections:{from:string;to:string;direction:FenceDirection}[];
 mismatches:{id:string;direction:FenceDirection;neighbor:string}[];openEnds:{id:string;direction:FenceDirection}[]};
/** Reference evaluator for previews/tests only. Runtime placement and traversal authority stay with consumers. */
export function evaluateFenceLayout(placements:readonly FencePlacement[]):FenceLayoutReport {
 if(!Array.isArray(placements) || placements.length>4096) throw new Error("fence layout must contain at most 4096 placements");
 const byCell=new Map<string,FencePlacement>(),ids=new Set<string>();
 for(const p of placements) {
  if(typeof p.id!=="string" || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(p.id) || ids.has(p.id)) throw new Error(`invalid or duplicate fence placement id '${String(p.id)}'`);
  ids.add(p.id);
  if(!Array.isArray(p.cell) || p.cell.length!==2 || !p.cell.every(Number.isSafeInteger)) throw new Error("fence cell must be two integers");
  fencePortsAfterRotation(p.piece,p.quarterTurns);
  const key=p.cell.join(",");
  if(byCell.has(key)) throw new Error(`fence cell ${key} is occupied twice`);
  byCell.set(key,p);
 }
 const report:FenceLayoutReport={connections:[],mismatches:[],openEnds:[]};
 for(const p of [...placements].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)) {
  const ports=fencePortsAfterRotation(p.piece,p.quarterTurns);
  for(const direction of FENCE_DIRECTIONS) {
   const [dx,dz]=FENCE_DIRECTION_VECTORS[direction],neighbor=byCell.get(`${p.cell[0]+dx},${p.cell[1]+dz}`);
   const own=ports.includes(direction);
   if(!neighbor) {if(own) report.openEnds.push({id:p.id,direction});continue;}
   const opposite=FENCE_DIRECTIONS[(FENCE_DIRECTIONS.indexOf(direction)+2)%4]!;
   const theirs=fencePortsAfterRotation(neighbor.piece,neighbor.quarterTurns).includes(opposite);
   if(own && theirs) {if(p.id<neighbor.id) report.connections.push({from:p.id,to:neighbor.id,direction});}
   else if(own) report.mismatches.push({id:p.id,direction,neighbor:neighbor.id});
  }
 }
 return report;
}

const common={schemaVersion:1,cellSize:2,postWidth:.14,postHeight:1.1,railCount:2,railHeight:.1,railDepth:.06,maxTriangles:120} as const;
export const FENCE_PRESETS=Object.freeze({
 end:Object.freeze({...common,piece:"end"}),straight:Object.freeze({...common,piece:"straight"}),
 corner:Object.freeze({...common,piece:"corner"}),tee:Object.freeze({...common,piece:"tee"}),
}) satisfies Record<FencePiece,FenceParameters>;
