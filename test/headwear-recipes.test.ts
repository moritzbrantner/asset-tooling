// Headwear recipes (#336): control bounds, the appearance list, and with Blender exact, grip-anchored GLBs in the
// male Ranger's rest model space around its head.
import {test} from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {NodeIO} from "@gltf-transform/core";
import {createHeadwearAssetSpec,HEADWEAR_MATERIALS,HEADWEAR_PRESETS,HEADWEAR_TRIANGLE_BUDGETS,normalizeHeadwearParameters,
 readHeadwearRecipeSource} from "../src/headwear-recipes.js";
import {rangerHeadwearAppearance} from "../scripts/build-ranger-character.js";

type Observations={piece:string;role:string;socket:string;triangleCount:number;origin:string;space:string;bounds:{min:number[];max:number[]}};
const {generateAsset,verifyAsset}:{generateAsset:(p:string)=>Promise<{receipt:{observations:{script:Observations}}}>;
 verifyAsset:(p:string)=>Promise<{status:string}>}=await import(new URL("../src/core.js",import.meta.url).href);
const source=await readHeadwearRecipeSource();
const spec=(parameters:unknown)=>createHeadwearAssetSpec({assetId:"headwear.fixture",parameters,scriptSha256:source.sha256,blenderVersion:source.blenderVersion});
const cap=HEADWEAR_PRESETS["cap.ranger"],helm=HEADWEAR_PRESETS["helm.ironcrest"];

test("headwear controls are bounded and the appearance list names what each piece hides",()=>{
 for(const p of Object.values(HEADWEAR_PRESETS)) assert.deepEqual(spec(p).parameters.arguments,p);
 for(const bad of [{...cap,piece:"hat.wide"},{...cap,segments:11},{...cap,segments:12.5},{...helm,maxTriangles:2501},{...cap,extra:1},{...cap,schemaVersion:2}])
  assert.throws(()=>normalizeHeadwearParameters(bad),Error,JSON.stringify(bad));
 assert.deepEqual(rangerHeadwearAppearance(),[
  {id:"equipment.cap.ranger",entry:"equipment.cap.ranger",label:"Ranger's Cap",socket:"head.armor",hides:["outfit.hood","hair"]},
  {id:"equipment.helm.ironcrest",entry:"equipment.helm.ironcrest",label:"Ironcrest Helm",socket:"head.armor",hides:["outfit.hood","hair"]},
 ]);
});

const blender=process.env.ASSET_TOOLING_BLENDER;
test("headwear GLBs are grip-anchored, budgeted and fitted around the Ranger's head",{skip:!blender,timeout:240000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),"headwear-"));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,"headwear.py"),source.bytes);
 const file=path.join(root,"asset.json");
 for(const p of Object.values(HEADWEAR_PRESETS)) {
  await writeFile(file,JSON.stringify(spec(p)));
  const evidence=(await generateAsset(file)).receipt.observations.script;
  assert.equal((await verifyAsset(file)).status,"exact");
  assert.deepEqual([evidence.piece,evidence.role,evidence.socket,evidence.origin,evidence.space],[p.piece,"armor","head.armor","grip","rest-model"]);
  assert.ok(evidence.triangleCount<=HEADWEAR_TRIANGLE_BUDGETS[p.piece]);
  const scene=(await new NodeIO().setAllowNetwork(false).readBinary(await readFile(path.join(root,"headwear.glb")))).getRoot();
  assert.deepEqual(scene.listMaterials().map(m=>m.getName()),[...HEADWEAR_MATERIALS[p.piece]]);
  const nodes=scene.listScenes()[0]!.listChildren();
  assert.deepEqual(nodes.map(n=>n.getName()).sort(),["grip",p.piece].sort());
  for(const node of nodes) assert.deepEqual([node.getTranslation(),node.getRotation()],[[0,0,0],[0,0,0,1]]);
  // Around the skull (centre ~(0, 1.70, 0) m), from about the brow up over the crown, a little wider than the head.
  const {min,max}=evidence.bounds;
  assert.ok(min[1]!>1.6 && min[1]!<1.73 && max[1]!>1.83 && max[1]!<1.9,`height ${min[1]}..${max[1]}`);
  assert.ok(max[0]!>.1 && max[0]!<.15 && max[2]!>.12 && min[2]!<-.12,`footprint ${min} ${max}`);
 }
});
