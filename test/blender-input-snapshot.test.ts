import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {tmpdir} from "node:os";
import {chmod,mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile} from "node:fs/promises";
import {readWheatRecipeSource} from "../src/wheat-recipes.js";
import {sha256Text} from "../src/hash.js";
const generationModule=new URL("../src/core.js",import.meta.url).href;
const {generateAsset,verifyAsset}:{generateAsset:(p:string)=>Promise<unknown>;verifyAsset:(p:string)=>Promise<{status:string;error?:string}>}=await import(generationModule);

test("Blender snapshots every declared input before executing code across a launch-time mutation",{
 skip:(!process.env.ASSET_TOOLING_BLENDER || process.platform==="win32") && "configured Blender and a POSIX launcher are required",timeout:120000,
},async t=>{
 const blender=process.env.ASSET_TOOLING_BLENDER;assert.ok(blender);
 const root=await mkdtemp(path.join(tmpdir(),"blender-input-race-"));
 t.after(async()=>{process.env.ASSET_TOOLING_BLENDER=blender;await rm(root,{recursive:true,force:true});});
 const helper='from pathlib import Path\ndef build(output):\n Path(output).write_text("declared")\n return {"value":"declared"}\n';
 const poisoned='from pathlib import Path\ndef build(output):\n Path("executed.marker").write_text("poisoned")\n Path(output).write_text("poisoned")\n return {"value":"poisoned"}\n';
 const script='import runpy\ndef generate(output_path, arguments, inputs):\n return runpy.run_path(inputs["authoring"])["build"](output_path)\n';
 const source=await readWheatRecipeSource(),specPath=path.join(root,"asset.json"),output=path.join(root,"output.txt"),helperPath=path.join(root,"helper.py");
 await writeFile(helperPath,helper);await writeFile(path.join(root,"entry.py"),script);
 await writeFile(specPath,JSON.stringify({schemaVersion:1,assetId:"blender.input-race",generator:{id:"external.blender.script",version:"1"},randomness:{mode:"none"},
  inputs:{script:{path:"entry.py",sha256:sha256Text(script)},authoring:{path:"helper.py",sha256:sha256Text(helper)}},models:{},
  parameters:{blenderVersion:source.blenderVersion,arguments:{}},output:{path:"output.txt"},reproducibility:{expected:"exact"}}));
 const launcher=path.join(root,"launch.ts");
 await writeFile(launcher,`#!/usr/bin/env bun
import {writeFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
const args=process.argv.slice(2);
if(args.includes("generate")) {await writeFile(${JSON.stringify(helperPath)},${JSON.stringify(poisoned)});}
const child=spawnSync(${JSON.stringify(blender)},args,{stdio:"inherit"});
if(child.error) {throw child.error;}
process.exit(child.status ?? 1);
`);await chmod(launcher,0o755);
 process.env.ASSET_TOOLING_BLENDER=launcher;
 await assert.rejects(generateAsset(specPath),/input 'authoring' bytes changed/);
 assert.equal(await readFile(helperPath,"utf8"),poisoned,"the launcher must exercise the real mutation window");
 assert.ok(!(await readdir(root)).includes("executed.marker"));assert.ok(!(await readdir(root)).includes("output.txt"));
 process.env.ASSET_TOOLING_BLENDER=blender;await writeFile(helperPath,helper);
 await generateAsset(specPath);
 const bytes=await readFile(output),receipt=await readFile(output+".receipt.json"),mtime=(await stat(output)).mtimeMs;
 process.env.ASSET_TOOLING_BLENDER=launcher;
 const replay=await verifyAsset(specPath);assert.equal(replay.status,"broken");assert.match(replay.error ?? "",/input 'authoring' bytes changed/);
 assert.deepEqual(await readFile(output),bytes);assert.deepEqual(await readFile(output+".receipt.json"),receipt);assert.equal((await stat(output)).mtimeMs,mtime);
 assert.ok(!(await readdir(root)).includes("executed.marker"));
});


test("declared Python dependencies execute their verified bytes after a later source edit",{
 skip:!process.env.ASSET_TOOLING_BLENDER && "configured Blender is required",timeout:60000,
},async t=>{
 const temporary=await mkdtemp(path.join(tmpdir(),"blender-pinned-code-")),root=path.join(temporary,"spec");
 await mkdir(root);t.after(()=>rm(temporary,{recursive:true,force:true}));
 const helper='from pathlib import Path\ndef build(output: str):\n Path(output).write_text("declared")\n return {"value":"declared","source":Path(__file__).name,"nativeAnnotation":build.__annotations__["output"] is str}\n';
 const poisoned='from pathlib import Path\ndef build(output):\n Path(output).write_text("poisoned")\n return {"value":"poisoned"}\n';
 // Reproduce the later window deterministically: an edit occurs after the runner
 // snapshots inputs but before this script asks to execute its dependency.
 const script=`from pathlib import Path

def generate(output_path, arguments, inputs):
 Path(inputs["authoring"]).write_text(${JSON.stringify(poisoned)})
 result=inputs.load_source("authoring")["build"](output_path)
 result["portableInput"]=inputs["authoring"]
 result["workingDirectory"]=Path.cwd().name
 return result
`;
 const source=await readWheatRecipeSource(),specPath=path.join(root,"asset.json");
 await writeFile(path.join(root,"helper.py"),helper);await writeFile(path.join(root,"entry.py"),script);
 await writeFile(specPath,JSON.stringify({schemaVersion:1,assetId:"blender.pinned-dependency",generator:{id:"external.blender.script",version:"1"},randomness:{mode:"none"},
  inputs:{script:{path:"entry.py",sha256:sha256Text(script)},authoring:{path:"helper.py",sha256:sha256Text(helper)}},models:{},
  parameters:{blenderVersion:source.blenderVersion,arguments:{}},output:{path:"output.txt"},reproducibility:{expected:"exact"}}));
 await generateAsset(specPath);
 assert.equal(await readFile(path.join(root,"helper.py"),"utf8"),poisoned);
 assert.equal(await readFile(path.join(root,"output.txt"),"utf8"),"declared");
 const receipt:unknown=JSON.parse(await readFile(path.join(root,"output.txt.receipt.json"),"utf8"));
 assert.ok(receipt && typeof receipt==="object" && "observations" in receipt);
 assert.deepEqual(receipt.observations,{runner:"blender-script-runner-v1",blenderVersion:source.blenderVersion,
  script:{value:"declared",source:"helper.py",nativeAnnotation:true,portableInput:"helper.py",workingDirectory:"spec"}});
 assert.ok(!(await readdir(root)).includes("__pycache__"));
});
