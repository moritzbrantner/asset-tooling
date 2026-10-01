import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
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
const child=spawnSync(${JSON.stringify(blender)},args,{stdio:"inherit",timeout:30000});
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

test("runner snapshots retain each declared input identity when source paths alias",{
 skip:!process.env.ASSET_TOOLING_BLENDER && "configured Blender is required",timeout:45000,
},async t=>{
 const blender=process.env.ASSET_TOOLING_BLENDER;assert.ok(blender);
 const root=await mkdtemp(path.join(tmpdir(),"blender-input-alias-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const first='VALUE="first"\n',second='VALUE="second"\n';
 const script='from pathlib import Path\ndef generate(output_path, arguments, inputs):\n first=inputs.load_source("first")["VALUE"]\n second=inputs.load_source("second")["VALUE"]\n Path(output_path).write_text(first+"/"+second)\n return {"first":first,"second":second}\n';
 const source=await readWheatRecipeSource();
 await writeFile(path.join(root,"helper.py"),first);await writeFile(path.join(root,"entry.py"),script);
 await writeFile(path.join(root,"request.json"),JSON.stringify({blenderVersion:source.blenderVersion,scriptPath:"entry.py",scriptSha256:sha256Text(script),arguments:{},
  inputArtifacts:{script:{path:"entry.py",sha256:sha256Text(script)},first:{path:"helper.py",sha256:sha256Text(first)},second:{path:"helper.py",sha256:sha256Text(second)}},
  inputs:{first:"helper.py",second:"helper.py"}}));
 // Isolate the runner seam: simulate a concurrent edit between its two verified
 // reads. Both individual declared pins must retain their own copied bytes.
 const harness=path.join(root,"harness.py");
 await writeFile(harness,`import ast, sys
from pathlib import Path
runner=Path(sys.argv[-1])
tree=ast.parse(runner.read_text())
assert isinstance(tree.body[-1],ast.Try)
tree.body.pop() # Suppress only the command-line entrypoint, not generate().
namespace={"__file__":str(runner),"__name__":"snapshot_fixture"}
exec(compile(tree,str(runner),"exec",dont_inherit=True),namespace)
original_open=Path.open
reads=0
def tracked_open(self,*args,**kwargs):
 global reads
 if self==Path("helper.py") and args==("rb",):
  reads+=1
  if reads==2:
   self.write_text(${JSON.stringify(second)})
 return original_open(self,*args,**kwargs)
Path.open=tracked_open
try:
 namespace["generate"](Path("request.json"),Path("output.txt"),Path("observations.json"))
finally:
 Path.open=original_open
assert reads==2
`);
 const runner=fileURLToPath(new URL("../adapters/blender/script_runner.py",import.meta.url));
 const result=spawnSync(blender,["--background","--factory-startup","--threads","1","--python-exit-code","1","--python",harness,"--",runner],{cwd:root,encoding:"utf8",timeout:30000});
 assert.equal(result.status,0,result.stderr+result.stdout);
 assert.equal(await readFile(path.join(root,"output.txt"),"utf8"),"first/second");
});


test("declared Python loader ignores public path edits and refuses undeclared names",{
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
 portable=inputs["authoring"]
 inputs["authoring"]=str(Path(portable).resolve())
 result=inputs.load_source("authoring")["build"](output_path)
 result["portableInput"]=portable
 result["workingDirectory"]=Path.cwd().name
 return result
`;
 const source=await readWheatRecipeSource(),specPath=path.join(root,"asset.json");
 await writeFile(path.join(root,"helper.py"),helper);await writeFile(path.join(root,"entry.py"),script);
 const spec=(entry:string)=>({schemaVersion:1,assetId:"blender.pinned-dependency",generator:{id:"external.blender.script",version:"1"},randomness:{mode:"none"},
  inputs:{script:{path:"entry.py",sha256:sha256Text(entry)},authoring:{path:"helper.py",sha256:sha256Text(helper)}},models:{},
  parameters:{blenderVersion:source.blenderVersion,arguments:{}},output:{path:"output.txt"},reproducibility:{expected:"exact"}});
 await writeFile(specPath,JSON.stringify(spec(script)));
 await generateAsset(specPath);
 assert.equal(await readFile(path.join(root,"helper.py"),"utf8"),poisoned);
 assert.equal(await readFile(path.join(root,"output.txt"),"utf8"),"declared");
 const receipt:unknown=JSON.parse(await readFile(path.join(root,"output.txt.receipt.json"),"utf8"));
 assert.ok(receipt && typeof receipt==="object" && "observations" in receipt);
 assert.deepEqual(receipt.observations,{runner:"blender-script-runner-v1",blenderVersion:source.blenderVersion,
  script:{value:"declared",source:"helper.py",nativeAnnotation:true,portableInput:"helper.py",workingDirectory:"spec"}});
 assert.ok(!(await readdir(root)).includes("__pycache__"));
 const accepted=await readFile(path.join(root,"output.txt")),acceptedReceipt=await readFile(path.join(root,"output.txt.receipt.json"));
 const forged='def generate(output_path, arguments, inputs):\n inputs["undeclared"]=inputs["authoring"]\n inputs.load_source("undeclared")["build"](output_path)\n return {}\n';
 await writeFile(path.join(root,"helper.py"),helper);await writeFile(path.join(root,"entry.py"),forged);
 await writeFile(specPath,JSON.stringify(spec(forged)));
 await assert.rejects(generateAsset(specPath),/undeclared Python input 'undeclared'/);
 assert.deepEqual(await readFile(path.join(root,"output.txt")),accepted);
 assert.deepEqual(await readFile(path.join(root,"output.txt.receipt.json")),acceptedReceipt);
});
