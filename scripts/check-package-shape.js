import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packagePath = path.join(root, "package.json");
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(packageJson.name === "asset-tooling", "package name must remain 'asset-tooling'");
assert(packageJson.private === false, "package must be consumable (private=false)");
assert(packageJson.type === "module", "package must remain an ES module package");
assert(/^\d+\.\d+\.\d+$/.test(packageJson.version), "package version must be an explicit semver version");
assert(packageJson.bin?.["asset-tooling"] === "./src/entry.js", "asset-tooling CLI entry must remain stable");
assert(packageJson.exports?.["."] === "./src/index.js", "root programmatic export must resolve to src/index.js");
assert(
  packageJson.exports?.["./operations"] === "./src/operations.js",
  "asset operation contracts must remain available through the focused ./operations subpath",
);
assert(
  packageJson.exports?.["./operations/store"] === "./src/asset-store.js",
  "content-addressed asset storage must remain available through the focused ./operations/store subpath",
);
assert(
  packageJson.exports?.["./operations/generation"] === "./src/generation-operations.js",
  "generation operation adapters must remain available through the focused ./operations/generation subpath",
);
assert(
  packageJson.exports?.["./operations/generation/procedural-image"] ===
    "./src/procedural-image-operations.js",
  "procedural image generation must remain available through the focused ./operations/generation/procedural-image subpath",
);
assert(
  packageJson.exports?.["./operations/generation/triposr"] === "./src/triposr-operation.js",
  "TripoSR generation operation must remain available through the focused ./operations/generation/triposr subpath",
);
assert(
  packageJson.exports?.["./operations/processing"] === "./src/processing-operations.js",
  "processing operation adapters must remain available through the focused ./operations/processing subpath",
);
assert(
  packageJson.exports?.["./operations/processing/animation"] ===
    "./src/animation-processing-operations.js",
  "animation processing operation adapters must remain available through the focused ./operations/processing/animation subpath",
);
assert(
  packageJson.exports?.["./operations/image"] === "./src/image-operations.js",
  "deterministic image operations must remain available through the focused ./operations/image subpath",
);
assert(
  packageJson.exports?.["./operations/image/filters"] === "./src/image-filter-operations.js",
  "deterministic image filter operations must remain available through the focused ./operations/image/filters subpath",
);
assert(
  packageJson.exports?.["./operations/image/advanced"] === "./src/image-advanced-operations.js",
  "advanced deterministic image operations must remain available through the focused ./operations/image/advanced subpath",
);
assert(
  packageJson.exports?.["./operations/image/colorspace"] === "./src/image-colorspace-operations.js",
  "image colorspace operations must remain available through the focused ./operations/image/colorspace subpath",
);
assert(
  packageJson.exports?.["./operations/image/channels"] === "./src/image-channel-operations.js",
  "image channel operations must remain available through the focused ./operations/image/channels subpath",
);
assert(
  packageJson.exports?.["./operations/image/analysis"] === "./src/image-analysis-operations.js",
  "image analysis operations must remain available through the focused ./operations/image/analysis subpath",
);
assert(
  packageJson.exports?.["./image/rgba8"] === "./src/image-rgba8.js",
  "canonical RGBA8 image contracts must remain available through the focused ./image/rgba8 subpath",
);
assert(
  packageJson.exports?.["./image/linear-rgba8"] === "./src/image-linear-rgba8.js",
  "canonical linear RGBA8 image contracts must remain available through the focused ./image/linear-rgba8 subpath",
);
assert(
  packageJson.exports?.["./operations/audio"] === "./src/audio-operations.js",
  "audio operations must remain available through the focused ./operations/audio subpath",
);
assert(
  packageJson.exports?.["./operations/audio/model"] === "./src/audio-model-operations.js",
  "model-backed audio operations must remain available through the focused ./operations/audio/model subpath",
);
assert(
  packageJson.exports?.["./audio"] === "./src/audio.js",
  "canonical audio contracts must remain available through the focused ./audio subpath",
);
assert(
  packageJson.exports?.["./operations/workflow"] === "./src/workflow-operations.js",
  "workflow operation adapters must remain available through the focused ./operations/workflow subpath",
);
assert(
  packageJson.exports?.["./catalog"] === "./src/catalog.js",
  "asset catalog contracts must remain available through the focused ./catalog subpath",
);
assert(
  packageJson.exports?.["./catalog/storage"] === "./src/catalog-storage.js",
  "durable catalog storage consumers must remain available through the focused ./catalog/storage subpath",
);
assert(packageJson.exports?.["./schemas/*"] === "./schemas/*", "versioned schemas must remain directly consumable");

const requiredPackageRoots = ["src", "schemas", "adapters", "catalog", "docs", "README.md"];
for (const item of requiredPackageRoots) {
  assert(packageJson.files?.includes(item), `package files must include '${item}'`);
  await access(path.join(root, item));
}
assert(!packageJson.files?.includes("assets"), "durable Git LFS payloads must remain outside the package payload");

for (const file of [
  "src/index.js",
  "src/operations.js",
  "src/asset-store.js",
  "src/generation-operations.js",
  "src/procedural-image.js",
  "src/procedural-image-operations.js",
  "src/triposr-operation.js",
  "src/processing-operations.js",
  "src/animation-processing-operations.js",
  "src/image-rgba8.js",
  "src/image-linear-rgba8.js",
  "src/image-operations.js",
  "src/image-filter-operations.js",
  "src/image-advanced-operations.js",
  "src/image-colorspace-operations.js",
  "src/image-channel-operations.js",
  "src/image-analysis-operations.js",
  "src/audio.js",
  "src/audio-operations.js",
  "src/audio-model-operations.js",
  "src/workflow-operations.js",
  "src/catalog.js",
  "src/catalog-storage.js",
  "src/entry.js",
  "catalog/providers.json",
  "catalog/sources.json",
  "catalog/storage.json",
  "schemas/asset-spec-v1.schema.json",
  "schemas/audio-asset-v1.schema.json",
  "schemas/generation-receipt-v1.schema.json",
  "schemas/generation-receipt-v2.schema.json",
  "schemas/processing-handoff-v1.schema.json",
  "schemas/processing-receipt-v1.schema.json",
  "schemas/processing-receipt-v2.schema.json",
]) {
  await access(path.join(root, file));
}

const cli = await readFile(path.join(root, "src/entry.js"), "utf8");
assert(cli.split(/\r?\n/, 1)[0] === "#!/usr/bin/env bun", "CLI entry must retain its Bun shebang");

console.log(JSON.stringify({ status: "valid", package: packageJson.name, version: packageJson.version }));
