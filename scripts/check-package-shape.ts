import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type PackageJson = {
  name?: string;
  version?: string;
  private?: boolean;
  type?: string;
  bin?: Record<string, string>;
  exports?: Record<string, string>;
  files?: string[];
};

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packagePath = path.join(root, "package.json");
const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as PackageJson;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

assert(packageJson.name === "asset-tooling", "package name must remain 'asset-tooling'");
assert(packageJson.private === false, "package must be consumable (private=false)");
assert(packageJson.type === "module", "package must remain an ES module package");
assert(
  typeof packageJson.version === "string" && /^\d+\.\d+\.\d+$/.test(packageJson.version),
  "package version must be an explicit semver version",
);
assert(
  packageJson.bin?.["asset-tooling"] === "./src/entry.ts",
  "asset-tooling CLI entry must resolve to the TypeScript authority",
);

const expectedSourceExports: Record<string, string> = {
  ".": "./src/index.ts",
  "./operations": "./src/operations.ts",
  "./operations/store": "./src/asset-store.ts",
  "./operations/instances": "./src/scatter-operations.ts",
  "./operations/generation": "./src/generation-operations.ts",
  "./operations/generation/procedural-image": "./src/procedural-image-operations.ts",
  "./operations/generation/procedural-shapes": "./src/procedural-shape-operations.ts",
  "./operations/generation/procedural-textures": "./src/procedural-texture-operations.ts",
  "./operations/generation/procedural-mesh": "./src/procedural-mesh-operations.ts",
  "./operations/generation/procedural-animation": "./src/procedural-animation-operations.ts",
  "./operations/generation/parametric-surfaces": "./src/parametric-surface-operations.ts",
  "./operations/generation/triposr": "./src/triposr-operation.ts",
  "./operations/generation/stable-fast-3d": "./src/stable-fast-3d-operation.ts",
  "./operations/generation/trellis2": "./src/trellis2-operation.ts",
  "./operations/processing": "./src/processing-operations.ts",
  "./operations/processing/animation": "./src/animation-processing-operations.ts",
  "./operations/processing/skinning": "./src/skinning-processing-operations.ts",
  "./operations/processing/humanoid": "./src/humanoid-processing-operations.ts",
  "./operations/mesh/analysis": "./src/mesh-analysis-operations.ts",
  "./operations/mesh/collision": "./src/collision-operations.ts",
  "./operations/material": "./src/material-operations.ts",
  "./operations/image": "./src/image-operations.ts",
  "./operations/image/filters": "./src/image-filter-operations.ts",
  "./operations/image/advanced": "./src/image-advanced-operations.ts",
  "./operations/image/background": "./src/image-background-operations.ts",
  "./operations/image/colorspace": "./src/image-colorspace-operations.ts",
  "./operations/image/channels": "./src/image-channel-operations.ts",
  "./operations/image/analysis": "./src/image-analysis-operations.ts",
  "./operations/image/codecs": "./src/image-codec-operations.ts",
  "./operations/image/perturbations": "./src/image-perturbation-recipes.ts",
  "./operations/image/terrain": "./src/terrain-operations.ts",
  "./image/rgba8": "./src/image-rgba8.ts",
  "./image/linear-rgba8": "./src/image-linear-rgba8.ts",
  "./instance-set": "./src/instance-set.ts",
  "./operations/audio": "./src/audio-operations.ts",
  "./operations/audio/procedural": "./src/audio-procedural-operations.ts",
  "./operations/audio/codecs": "./src/audio-codec-operations.ts",
  "./operations/audio/model": "./src/audio-model-operations.ts",
  "./audio": "./src/audio.ts",
  "./operations/workflow": "./src/workflow-operations.ts",
  "./catalog": "./src/catalog.ts",
  "./catalog/acquisition": "./src/catalog-acquisition.ts",
  "./catalog/storage": "./src/catalog-storage.ts",
  "./3d/production-profile": "./src/three-d-production-profile.ts",
  "./recipes/medieval-character-kit": "./src/medieval-character-kit.ts",
  "./recipes/medieval-character-materials": "./src/medieval-character-materials.ts",
  "./recipes/production-props": "./src/production-prop-kit.ts",
};

for (const [subpath, target] of Object.entries(expectedSourceExports)) {
  assert(packageJson.exports?.[subpath] === target, `${subpath} must resolve to ${target}`);
  await access(path.join(root, target));
}
assert(
  packageJson.exports?.["./schemas/*"] === "./schemas/*",
  "versioned schemas must remain directly consumable",
);

const requiredPackageRoots = ["src", "schemas", "adapters", "catalog", "docs", "README.md"];
for (const item of requiredPackageRoots) {
  assert(packageJson.files?.includes(item), `package files must include '${item}'`);
  await access(path.join(root, item));
}
assert(
  !packageJson.files?.includes("assets"),
  "durable Git LFS payloads must remain outside the package payload",
);

const requiredInternalFiles = [
  "src/procedural-image.ts",
  "src/procedural-shapes.ts",
  "src/procedural-textures.ts",
  "src/procedural-mesh.ts",
  "src/image-advanced.ts",
  "src/image-analysis.ts",
  "src/image-channels.ts",
  "src/image-colorspace.ts",
  "src/image-convolution.ts",
  "src/image-color.ts",
  "src/image-geometry.ts",
  "src/process-adapter.ts",
  "src/processing-handoff.ts",
  "src/processor-runtime.ts",
  "src/receipts.ts",
  "src/schema.ts",
  "src/tool.ts",
  "src/entry.ts",
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
];
for (const file of requiredInternalFiles) {
  await access(path.join(root, file));
}

const cli = await readFile(path.join(root, "src/entry.ts"), "utf8");
assert(cli.split(/\r?\n/, 1)[0] === "#!/usr/bin/env bun", "CLI entry must retain its Bun shebang");

console.log(JSON.stringify({ status: "valid", package: packageJson.name, version: packageJson.version }));
