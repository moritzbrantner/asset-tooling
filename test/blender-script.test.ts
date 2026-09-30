import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { getBackend } from "../src/backends.js";
import { generateAsset, validateSpec, verifyAsset } from "../src/core.js";
import { sha256File, sha256Text } from "../src/hash.js";

// Blender round trips run only where a Blender executable is configured, e.g. the Validate
// workflow's pinned install. Contract validation below needs no Blender.
const blenderConfigured = Boolean(process.env.ASSET_TOOLING_BLENDER);
const BLENDER_VERSION: string = JSON.parse(
  await readFile(new URL("../adapters/blender/release.json", import.meta.url), "utf8"),
).version;

const CUBE_SCRIPT = `import bpy

def generate(output_path, arguments, inputs):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    bpy.ops.mesh.primitive_cube_add(size=arguments["size"])
    bpy.ops.export_scene.gltf(filepath=output_path, export_format="GLB", use_selection=True, export_texcoords=False)
    return {"objects": len(bpy.context.scene.objects)}
`;

function blenderSpec(overrides: Record<string, unknown> = {}, script = CUBE_SCRIPT) {
  return {
    schemaVersion: 1,
    assetId: "test.blender-script",
    generator: { id: "external.blender.script", version: "1" },
    randomness: { mode: "none" },
    inputs: { script: { path: "cube.py", sha256: sha256Text(script) } },
    models: {},
    parameters: { blenderVersion: BLENDER_VERSION, arguments: { size: 2 } },
    output: { path: ".asset-tooling/cube.glb" },
    reproducibility: { expected: "exact" },
    ...overrides,
  };
}

async function writeWorkspace(spec = blenderSpec(), script = CUBE_SCRIPT) {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-blender-"));
  await writeFile(path.join(root, "cube.py"), script, "utf8");
  const specPath = path.join(root, "asset.json");
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  return { root, specPath };
}

test("Blender script runner is a procedural backend that claims exact capability", () => {
  const backend = getBackend({ id: "external.blender.script", version: "1" });
  assert.equal(backend.kind, "procedural");
  assert.equal(backend.exactCapable, true);
});

test("Blender script specs validate with a pinned version, script input, and arguments", async () => {
  const { specPath } = await writeWorkspace();
  assert.equal((await validateSpec(specPath)).status, "valid");
});

for (const [name, overrides, pattern] of [
  ["a floating Blender version", { parameters: { blenderVersion: "latest", arguments: {} } }, /exact MAJOR\.MINOR\.PATCH/],
  ["a partial Blender version", { parameters: { blenderVersion: "5.2", arguments: {} } }, /exact MAJOR\.MINOR\.PATCH/],
  ["missing arguments", { parameters: { blenderVersion: "5.2.2" } }, /parameters\.arguments is required/],
  ["unknown parameters", { parameters: { blenderVersion: "5.2.2", arguments: {}, threads: 4 } }, /unsupported field 'threads'/],
  ["seeded randomness", { randomness: { mode: "seeded", seed: "1" } }, /randomness\.mode='none'/],
  [
    "a non-Python script",
    { inputs: { script: { path: "cube.txt", sha256: "1".repeat(64) } } },
    /must be a \.py file/,
  ],
  ["no script input", { inputs: {} }, /input named 'script'/],
] as const) {
  test(`Blender script specs reject ${name}`, async () => {
    const { specPath } = await writeWorkspace(blenderSpec(overrides as Record<string, unknown>));
    await assert.rejects(validateSpec(specPath), pattern);
  });
}

test("Blender script generation replays exactly and records the pinned Blender build", {
  skip: !blenderConfigured && "ASSET_TOOLING_BLENDER is not set",
  timeout: 120_000,
}, async () => {
  const { specPath, root } = await writeWorkspace();
  const generated = await generateAsset(specPath);
  const blender = generated.receipt.environment.components.find((component) => component.id === "blender");
  assert.equal(blender.version, BLENDER_VERSION);
  assert.match(blender.executableSha256, /^[0-9a-f]{64}$/);
  const runner = generated.receipt.environment.components.find((component) => component.id === "blender-script-runner");
  assert.equal(runner.sha256, await sha256File(new URL("../adapters/blender/script_runner.py", import.meta.url)));
  assert.deepEqual(generated.receipt.observations, {
    runner: "blender-script-runner-v1",
    blenderVersion: BLENDER_VERSION,
    script: { objects: 1 },
  });
  const bytes = await readFile(path.join(root, ".asset-tooling/cube.glb"));
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "glTF");

  const report = await verifyAsset(specPath);
  assert.equal(report.status, "exact");
});

test("Blender scripts receive the same portable input paths in different checkouts", {
  skip: !blenderConfigured && "ASSET_TOOLING_BLENDER is not set",
  timeout: 120_000,
}, async () => {
  const script = `from pathlib import Path
def generate(output_path, arguments, inputs):
    Path(output_path).write_text(inputs["source"] + ":" + Path(inputs["source"]).read_text())
    return {"inputPath": inputs["source"]}
`;
  const spec = blenderSpec({
    inputs: {
      script: { path: "cube.py", sha256: sha256Text(script) },
      source: { path: "input.txt", sha256: sha256Text("source bytes") },
    },
  }, script);
  const first = await writeWorkspace(spec, script);
  const second = await writeWorkspace(spec, script);
  await writeFile(path.join(first.root, "input.txt"), "source bytes");
  await writeFile(path.join(second.root, "input.txt"), "source bytes");
  const a = await generateAsset(first.specPath);
  const b = await generateAsset(second.specPath);
  assert.equal(a.receipt.output.sha256, b.receipt.output.sha256);
  assert.deepEqual(a.receipt.observations, b.receipt.observations);
  assert.equal(a.receipt.observations.script.inputPath, "input.txt");
});

test("Blender script generation fails closed on a Blender version mismatch", {
  skip: !blenderConfigured && "ASSET_TOOLING_BLENDER is not set",
  timeout: 120_000,
}, async () => {
  const { specPath } = await writeWorkspace(
    blenderSpec({ parameters: { blenderVersion: "1.0.0", arguments: { size: 2 } } }),
  );
  await assert.rejects(generateAsset(specPath), /does not match declared blenderVersion 1\.0\.0/);
});

test("Blender script verification breaks when the script changes after generation", {
  skip: !blenderConfigured && "ASSET_TOOLING_BLENDER is not set",
  timeout: 120_000,
}, async () => {
  const { specPath, root } = await writeWorkspace();
  await generateAsset(specPath);
  await writeFile(path.join(root, "cube.py"), CUBE_SCRIPT.replace('arguments["size"]', "3"), "utf8");
  const report = await verifyAsset(specPath);
  assert.equal(report.status, "broken");
});

test("Blender script generation fails closed when the script writes no output", {
  skip: !blenderConfigured && "ASSET_TOOLING_BLENDER is not set",
  timeout: 120_000,
}, async () => {
  const script = "def generate(output_path, arguments, inputs):\n    return {}\n";
  const { specPath } = await writeWorkspace(
    blenderSpec({ inputs: { script: { path: "cube.py", sha256: sha256Text(script) } } }, script),
    script,
  );
  await assert.rejects(generateAsset(specPath), /did not write the output file/);
});

const PINNED_TEXT_SCRIPT = `from pathlib import Path
def generate(output_path: str, arguments, inputs):
    Path(output_path).write_text("declared")
    return {"implementation": "declared", "module": __name__, "source": Path(__file__).name, "package": __package__, "sourceAnnotations": generate.__annotations__["output_path"] is str}
`;

test("Blender executes hash-pinned source even with contradictory timestamp-valid Python bytecode", {
  skip: !blenderConfigured && "ASSET_TOOLING_BLENDER is not set",
  timeout: 120_000,
}, async t => {
  const { root, specPath } = await writeWorkspace(blenderSpec({}, PINNED_TEXT_SCRIPT), PINNED_TEXT_SCRIPT);
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "cube.py"), PINNED_TEXT_SCRIPT.replaceAll("declared", "poisoned"));
  // Compile with Blender's own Python, so magic/version match the actual loader. The replacement
  // source has the same byte length and mtime, making this a genuine accepted timestamp cache.
  const compiler = spawnSync(process.env.ASSET_TOOLING_BLENDER!, [
    "--background", "--factory-startup", "--quiet", "--python-exit-code", "1", "--python-expr",
    'import os, py_compile; os.utime("cube.py", (1700000000, 1700000000)); py_compile.compile("cube.py", doraise=True, invalidation_mode=py_compile.PycInvalidationMode.TIMESTAMP)',
  ], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(compiler.status, 0, compiler.error?.message ?? compiler.stderr);
  await writeFile(path.join(root, "cube.py"), PINNED_TEXT_SCRIPT);
  await utimes(path.join(root, "cube.py"), 1700000000, 1700000000);
  const cacheDirectory = path.join(root, "__pycache__");
  const cacheFiles = await readdir(cacheDirectory);
  assert.equal(cacheFiles.length, 1);
  const bytecode = await readFile(path.join(cacheDirectory, cacheFiles[0]!));
  assert.equal(bytecode.readUInt32LE(4), 0); // timestamp-based invalidation, not source-hash mode
  assert.equal(bytecode.readUInt32LE(8), 1700000000);
  assert.equal(bytecode.readUInt32LE(12), Buffer.byteLength(PINNED_TEXT_SCRIPT));
  assert.ok(bytecode.includes(Buffer.from("poisoned")));

  const generated = await generateAsset(specPath);
  assert.equal((await readFile(path.join(root, ".asset-tooling/cube.glb"))).toString(), "declared");
  assert.deepEqual(generated.receipt.observations.script, {
    implementation: "declared", module: "asset_tooling_blender_script", source: "cube.py", package: "", sourceAnnotations: true,
  });
  assert.equal((await verifyAsset(specPath)).status, "exact");
  assert.deepEqual(await readFile(path.join(cacheDirectory, cacheFiles[0]!)), bytecode);
});

test("Blender generation and clean-workspace replay do not create source-adjacent bytecode", {
  skip: !blenderConfigured && "ASSET_TOOLING_BLENDER is not set",
  timeout: 120_000,
}, async t => {
  const { root, specPath } = await writeWorkspace(blenderSpec({}, PINNED_TEXT_SCRIPT), PINNED_TEXT_SCRIPT);
  t.after(() => rm(root, { recursive: true, force: true }));
  await generateAsset(specPath);
  assert.ok(!(await readdir(root)).includes("__pycache__"));
  const before = (await readdir(root, { recursive: true })).sort();
  assert.equal((await verifyAsset(specPath)).status, "exact");
  assert.deepEqual((await readdir(root, { recursive: true })).sort(), before);
});
