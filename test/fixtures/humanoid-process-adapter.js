#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const mismatchArgument = args[0]?.startsWith("--mismatch=") ? args.shift() : null;
const mismatch = mismatchArgument?.slice("--mismatch=".length) ?? null;
const mode = args[0];
if (mode === "probe") {
  process.stdout.write(
    JSON.stringify([
      {
        id: "three-d-humanoid-validate",
        version: "0.1.0",
        algorithm: "three-d-animation-humanoid-production-v1",
        protocol: "asset-tooling-process-adapter-v1",
        codec: "three-d-humanoid-json-v1",
        dependencies: { "three-d-animation": "0.1.0" },
        cargoLock: "fixture-humanoid-lock-v1",
      },
    ]),
  );
  process.exit(0);
}

if (mode !== "generate" || args.length !== 4) {
  throw new Error(
    "usage: fixture [--mismatch=root|toes] probe | generate REQUEST OUTPUT OBSERVATIONS",
  );
}

const [, requestPath, outputPath, observationsPath] = args;
const request = JSON.parse(await readFile(requestPath, "utf8"));
if (request.operation !== "rig.humanoid.validate") {
  throw new Error(`unsupported fixture operation '${request.operation}'`);
}
const source = JSON.parse(await readFile(path.resolve(process.cwd(), request.inputPath), "utf8"));
const nodeFor = (bone) => source.bindings.find((binding) => binding.bone === bone)?.node;
const optionalToeCount = ["left-toes", "right-toes"].filter(
  (bone) => nodeFor(bone) !== undefined,
).length;

await writeFile(outputPath, JSON.stringify(source));
const rootNode = mismatch === "root" ? nodeFor("hips") : nodeFor("root");
const observedToeCount = mismatch === "toes" ? optionalToeCount + 1 : optionalToeCount;
await writeFile(
  observationsPath,
  JSON.stringify({
    jointCount: source.joints.length,
    mappedBoneCount: source.bindings.length,
    helperJointCount: source.joints.length - source.bindings.length,
    socketCount: source.sockets.length,
    rootNode,
    hipsNode: nodeFor("hips"),
    optionalToeCount: observedToeCount,
    referenceHeight: Math.fround(source.referenceHeight),
    semanticHierarchyValid: true,
    rootHipsSeparated: rootNode !== nodeFor("hips"),
    standardSocketsPresent: true,
  }),
);
