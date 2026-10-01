import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile, copyFile, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createAssetRef } from "asset-tooling/operations";

function acceptance(stdout: string) {
  const value: unknown = JSON.parse(stdout.trim());
  assert.ok(value && typeof value === "object" && "accepted" in value && "expectedManifest" in value && "files" in value && "manifest" in value && "bytesWritten" in value && "manifestStatus" in value, "consumer must report executed acceptance");
  assert.equal(value.accepted, true);
  assert.ok(Array.isArray(value.files));
  const files = value.files.map((file: unknown) => {
    assert.equal(typeof file, "string");
    assert.ok(typeof file === "string" && (file === "manifest.json" || /^assets\/[a-f0-9]{64}\.png$/.test(file)), "distribution paths must be explicit portable files");
    return file;
  });
  assert.equal(typeof value.manifest, "string");
  assert.equal(typeof value.bytesWritten, "number");
  return { ...value, files, expectedManifest: createAssetRef(value.expectedManifest) };
}
const exec = promisify(execFile);
const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const directory = await mkdtemp(path.join(tmpdir(), "asset-bundle-consumer-"));
const consumer = path.join(directory, "consumer");
const producer = path.join(directory, "producer");
async function run(args: string[], cwd = consumer) {
  return exec(process.execPath, args, { cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
}
try {
  await mkdir(consumer);
  // Packing runs explicit prepack reconciliation; keep that mutation in disposable producer state.
  const excluded = new Set([".git", "node_modules", ".artifacts", ".asset-tooling", "dist", "build"]);
  await cp(repository, producer, {
    recursive: true,
    filter: source => !excluded.has(path.relative(repository, source).split(path.sep)[0] ?? ""),
  });
  await run(["pm", "pack", "--destination", directory], producer);
  const packageJson: unknown = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8"));
  assert.ok(packageJson && typeof packageJson === "object" && "version" in packageJson && typeof packageJson.version === "string");
  await copyFile(path.join(directory, `asset-tooling-${packageJson.version}.tgz`), path.join(consumer, "asset-tooling.tgz"));
  await copyFile(path.join(repository, "examples/selected-bundle/consumer-package.json"), path.join(consumer, "package.json"));
  // The same small app wrapper is used by the native generator; recipe logic stays in the public export.
  await copyFile(path.join(repository, "examples/selected-bundle/consumer.ts"), path.join(consumer, "consumer.ts"));
  await run(["install", "--backend", "copyfile"]);
  await run(["install", "--frozen-lockfile", "--backend", "copyfile"]);
  const packagedLock = path.join(consumer, "node_modules", "asset-tooling", "adapters", "dependency.lock");
  const lockBytes = await readFile(packagedLock);
  assert.deepEqual(lockBytes, await readFile(path.join(repository, "bun.lock")), "packed provenance must carry the exact producer lock");
  const first = acceptance((await run(["run", "accept"])).stdout);
  assert.equal(first.accepted, true);
  const expected = createAssetRef(first.expectedManifest);
  assert.ok(Array.isArray(first.files) && first.files.length === 2, "one manifest and one selected PNG must ship");
  const bundle = path.join(consumer, ".artifacts", "selected-bundle");
  const files: string[] = first.files;
  const before = await Promise.all(files.map(async file => ({ file, bytes: await readFile(path.join(bundle, file)), mtime: (await stat(path.join(bundle, file))).mtimeMs })));
  await writeFile(path.join(consumer, "user-note.txt"), "keep my project\n");
  const second = acceptance((await run(["run", "accept"])).stdout);
  assert.equal(second.manifest, first.manifest);
  assert.equal(second.bytesWritten, 0);
  assert.equal(second.manifestStatus, "unchanged");
  for (const previous of before) {
    assert.deepEqual(await readFile(path.join(bundle, previous.file)), previous.bytes);
    assert.equal((await stat(path.join(bundle, previous.file))).mtimeMs, previous.mtime);
  }
  assert.equal(await readFile(path.join(consumer, "user-note.txt"), "utf8"), "keep my project\n");
  await writeFile(path.join(consumer, "verify.ts"), `import path from "node:path";
import { consumeSelectedBundle } from "asset-tooling/examples/selected-bundle";
console.log(JSON.stringify(await consumeSelectedBundle(path.resolve(".artifacts/selected-bundle"), ${JSON.stringify(expected)}, path.resolve(".artifacts/independent-consumer"))));
`);
  // Only this disposable fixture's producer store is deleted. Acceptance must use distribution bytes.
  await rm(path.join(consumer, ".asset-tooling"), { recursive: true, force: true });
  assert.equal(JSON.parse((await run(["verify.ts"])).stdout.trim()).accepted, true);
  const payload = before.find(file => file.file.endsWith(".png"));
  assert.ok(payload, "an actual selected PNG must be verified");
  await writeFile(path.join(bundle, payload.file), "corrupt payload");
  await assert.rejects(run(["verify.ts"]), /hash|length|mismatch|pin/i);
  assert.equal(await readFile(path.join(bundle, payload.file), "utf8"), "corrupt payload", "verification must not repair files");
  await writeFile(path.join(bundle, payload.file), payload.bytes);
  await run(["verify.ts"]);
  const installed = path.join(consumer, "node_modules", "asset-tooling", "package.json");
  const original = await readFile(installed);
  const installedJson: unknown = JSON.parse(original.toString());
  assert.ok(installedJson && typeof installedJson === "object" && "exports" in installedJson && installedJson.exports && typeof installedJson.exports === "object");
  await writeFile(installed, JSON.stringify({ ...installedJson, exports: { ...installedJson.exports, "./examples/selected-bundle": "./missing-public-example.ts" } }));
  await assert.rejects(run(["verify.ts"]), /cannot find|module not found|resolve/i);
  await writeFile(installed, original);
  await run(["verify.ts"]);
  await rm(packagedLock);
  await assert.rejects(run(["run", "accept"]), /dependency.lock|ENOENT/);
  await writeFile(packagedLock, lockBytes);
  await writeFile(path.join(consumer, "missing-tool.ts"), `import { probeImageCodecImplementation, IMAGE_ENCODE_PNG_OPERATION } from "asset-tooling/operations/image/codecs";
await probeImageCodecImplementation(IMAGE_ENCODE_PNG_OPERATION, {ffmpeg: "missing-asset-adoption-codec"});
`);
  await assert.rejects(run(["missing-tool.ts"]), /could not execute/);
  // Keep generator templates and the source-owned app wrapper identical.
  assert.deepEqual(await readFile(path.join(repository, ".coding-tooling/generators/selected-bundle/templates/consumer.ts.tmpl")), await readFile(path.join(repository, "examples/selected-bundle/consumer.ts")));
  console.log(JSON.stringify({ status: "accepted", package: "asset-tooling", cases: 8, publicExport: "asset-tooling/examples/selected-bundle", offlineAcceptance: true, producerStoreRequired: false, repeatBytesWritten: second.bytesWritten }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
