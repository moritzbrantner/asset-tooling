// Generate and exactly verify the sword and shield presets into .artifacts/weapons/.
// With `--sheets <character.gltf>`, also render humanoid-sockets-v1 inspection sheets through
// examples/weapons/socket-sheets.py with the Ranger socket descriptor (held and stowed).
import assert from "node:assert/strict";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {mkdir} from "node:fs/promises";
import {createWeaponAssetSpec,readWeaponRecipeSource,WEAPON_PRESETS} from "asset-tooling/recipes/weapons";
import {canonicalJson} from "../../src/canonical.js";
import {writeIfChanged} from "../reconcile-file.js";
import {generateAsset,verifyAsset} from "../native-vegetation.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),directory=path.join(root,".artifacts/weapons");
const source=await readWeaponRecipeSource(),outputs:Record<string,string>={};
for(const [id,parameters] of Object.entries(WEAPON_PRESETS)) {
 const workspace=path.join(directory,id);await mkdir(workspace,{recursive:true});
 await writeIfChanged(path.join(workspace,"weapon.py"),source.bytes);
 const spec=createWeaponAssetSpec({assetId:`weapon.${id}`,parameters,scriptSha256:source.sha256,blenderVersion:source.blenderVersion});
 const specPath=path.join(workspace,"asset.json");await writeIfChanged(specPath,Buffer.from(canonicalJson(spec)+"\n"));
 const generated=await generateAsset(specPath);assert.equal((await verifyAsset(specPath)).status,"exact");
 outputs[id]=path.join(workspace,"weapon.glb");
 console.log(JSON.stringify({id,glb:outputs[id],observations:generated.receipt.observations}));
}
const sheets=process.argv.indexOf("--sheets");
if(sheets>=0) {
 const character=path.resolve(process.argv[sheets+1]!),sockets=path.join(root,"assets/descriptors/humanoid.ranger.male.sockets.json");
 const script=path.join(root,"examples/weapons/socket-sheets.py"),blender=process.env.ASSET_TOOLING_BLENDER ?? "blender";
 for(const [name,attach] of [["held",[`hand_r.weapon=${outputs["sword.arming"]}`,`hand_l.shield=${outputs["shield.heater"]}`]],
  ["stowed",[`hip_l.stowed=${outputs["sword.arming"]}`,`back.stowed=${outputs["shield.heater"]}`]]] as const) {
  const run=spawnSync(blender,["--background","--factory-startup","--python-exit-code","1","--python",script,"--",character,sockets,
   path.join(directory,"sheets",name),...attach],{stdio:"inherit"});
  assert.equal(run.status,0,`socket sheets (${name}) failed`);
 }
}
