#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const mode = process.argv[2];
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

if (mode !== "generate" || process.argv.length !== 6) {
  throw new Error("usage: fixture probe | generate REQUEST OUTPUT OBSERVATIONS");
}

const [, , , requestPath, outputPath, observationsPath] = process.argv;
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
await writeFile(
  observationsPath,
  JSON.stringify({
    jointCount: source.joints.length,
    mappedBoneCount: source.bindings.length,
    helperJointCount: source.joints.length - source.bindings.length,
    socketCount: source.sockets.length,
    rootNode: nodeFor("root"),
    hipsNode: nodeFor("hips"),
    optionalToeCount,
    referenceHeight: Math.fround(source.referenceHeight),
    semanticHierarchyValid: true,
    rootHipsSeparated: nodeFor("root") !== nodeFor("hips"),
    standardSocketsPresent: true,
  }),
);
