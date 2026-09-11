import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

function assert(condition, message) { if (!condition) throw new Error(message); }
assert(packageJson.name === "asset-tooling", "package name must remain 'asset-tooling'");
assert(packageJson.private === false, "package must be consumable (private=false)");
assert(packageJson.type === "module", "package must remain an ES module package");
assert(/^\d+\.\d+\.\d+$/.test(packageJson.version), "package version must be an explicit semver version");
assert(packageJson.bin?.["asset-tooling"] === "./src/entry.js", "asset-tooling CLI entry must remain stable");
for (const [subpath, target] of Object.entries({
  ".": "./src/index.js",
  "./operations": "./src/operations.js",
  "./operations/store": "./src/asset-store.js",
  "./operations/generation": "./src/generation-operations.js",
  "./operations/processing": "./src/processing-operations.js",
  "./operations/audio": "./src/audio-operations.js",
  "./operations/audio/model": "./src/audio-model-operations.js",
  "./audio": "./src/audio.js",
  "./operations/workflow": "./src/workflow-operations.js",
  "./catalog": "./src/catalog.js",
  "./catalog/storage": "./src/catalog-storage.js",
  "./schemas/*": "./schemas/*",
})) assert(packageJson.exports?.[subpath] === target, `package export ${subpath} must resolve to ${target}`);

for (const item of ["src", "schemas", "adapters", "catalog", "docs", "README.md"]) {
  assert(packageJson.files?.includes(item), `package files must include '${item}'`);
  await access(path.join(root, item));
}
assert(!packageJson.files?.includes("assets"), "durable Git LFS payloads must remain outside the package payload");

for (const file of [
  "src/index.js", "src/operations.js", "src/asset-store.js", "src/generation-operations.js",
  "src/processing-operations.js", "src/audio.js", "src/audio-operations.js", "src/audio-model-operations.js",
  "src/workflow-operations.js", "src/catalog.js", "src/catalog-storage.js", "src/entry.js",
  "catalog/providers.json", "catalog/sources.json", "catalog/storage.json",
  "schemas/asset-spec-v1.schema.json", "schemas/audio-asset-v1.schema.json",
  "schemas/generation-receipt-v1.schema.json", "schemas/generation-receipt-v2.schema.json",
  "schemas/processing-handoff-v1.schema.json", "schemas/processing-receipt-v1.schema.json",
  "schemas/processing-receipt-v2.schema.json",
]) await access(path.join(root, file));

const cli = await readFile(path.join(root, "src/entry.js"), "utf8");
assert(cli.split(/\r?\n/, 1)[0] === "#!/usr/bin/env bun", "CLI entry must retain its Bun shebang");
console.log(JSON.stringify({ status: "valid", package: packageJson.name, version: packageJson.version }));
