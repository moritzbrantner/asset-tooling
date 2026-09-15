#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const mode = process.argv[2];
if (mode === "probe") {
  process.stdout.write(
    JSON.stringify([
      {
        id: "three-d-skinning-validate",
        version: "0.1.0",
        algorithm: "three-d-animation-skinning-profile-v1",
        protocol: "asset-tooling-process-adapter-v1",
        codec: "three-d-skinning-json-v1",
        dependencies: { "three-d-animation": "0.1.0" },
        cargoLock: "fixture-skinning-lock-v1",
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
if (request.operation !== "mesh.skinning.validate") {
  throw new Error(`unsupported fixture operation '${request.operation}'`);
}
const source = JSON.parse(await readFile(path.resolve(process.cwd(), request.inputPath), "utf8"));
const influences = source.influences.map((influence) => {
  const sum = influence.weights.reduce((total, weight) => total + weight, 0);
  return {
    joints: influence.joints,
    weights: influence.weights.map((weight) => Math.fround(weight / sum)),
  };
});
const output = { schemaVersion: 1, joints: source.joints, influences };
const maxActiveInfluences = influences.reduce(
  (maximum, influence) =>
    Math.max(maximum, influence.weights.filter((weight) => weight > 0).length),
  0,
);
await writeFile(outputPath, JSON.stringify(output));
await writeFile(
  observationsPath,
  JSON.stringify({
    jointCount: source.joints.length,
    rootJointCount: source.joints.filter((joint) => joint.parent === null).length,
    vertexInfluenceCount: influences.length,
    influenceSlotsPerVertex: 4,
    maxActiveInfluences,
    parentBeforeChild: true,
    weightsNormalized: true,
    activeJointIndicesInRange: true,
    inverseBindMatchesBindPose: true,
    maxBindPoseIdentityError: 0,
    matrixLayout: "column-major-4x4",
    skinMatrixRule: "joint-world-times-inverse-bind",
  }),
);
