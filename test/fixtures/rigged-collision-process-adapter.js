import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [mode, ...args] = process.argv.slice(2);

if (mode === "probe") {
  process.stdout.write(
    JSON.stringify([
      {
        id: "three-d-rigged-collision-fit",
        version: "0.1.0",
        algorithm: "three-d-rigged-assets-joint-proxy-fit-v1",
        protocol: "asset-tooling-process-adapter-v1",
        codec: "three-d-rigged-collision-json-v1",
        dependencies: {
          serde: "1.0.229",
          serdeJson: "1.0.151",
          threeDAnimation: "0.1.0",
          threeDCore: "0.1.0",
          threeDRiggedAssets: "0.1.0",
        },
        cargoLock: "fixture-rigged-collision-lock-v1",
      },
    ]),
  );
  process.exit(0);
}

if (mode !== "generate" || args.length !== 3) {
  process.stderr.write(
    "usage: rigged-collision-process-adapter.js probe | generate REQUEST OUTPUT OBSERVATIONS\n",
  );
  process.exit(2);
}

const [requestPath, outputPath, observationsPath] = args;
const request = JSON.parse(await readFile(requestPath, "utf8"));
if (request.operation !== "mesh.rigged-collision.fit") {
  throw new Error("unsupported fixture operation '" + request.operation + "'");
}
const source = JSON.parse(
  await readFile(path.resolve(process.cwd(), request.inputPath), "utf8"),
);

const xs = source.positions.map((position) => position[0]);
const ys = source.positions.map((position) => position[1]);
const zs = source.positions.map((position) => position[2]);
const min = [Math.min(...xs), Math.min(...ys), Math.min(...zs)];
const max = [Math.max(...xs), Math.max(...ys), Math.max(...zs)];
const center = min.map((value, axis) => Math.fround((value + max[axis]) / 2));
const size = min.map((value, axis) => Math.fround(max[axis] - value + request.parameters.padding * 2));
const lateral = Math.max(size[0], size[2]);
const radius = Math.fround(lateral / 2);
const segmentLength = Math.fround(Math.max(size[1] - radius * 2, request.parameters.minimumExtent));

const output = {
  schemaVersion: 1,
  coordinateSystem: "right-handed-y-up",
  transformSpace: "joint-bind-local",
  capsuleAxis: "local-y",
  proxies: [
    {
      shape: "capsule",
      joint: 0,
      center,
      radius,
      segmentLength,
    },
  ],
};
const observations = {
  jointCount: source.joints.length,
  vertexCount: source.positions.length,
  assignedVertices: source.positions.length,
  lowConfidenceVertices: 0,
  representedVertices: source.positions.length,
  unrepresentedAssignedVertices: 0,
  representedJointCount: 1,
  proxyCount: 1,
  shapeCounts: { boxCount: 0, sphereCount: 0, capsuleCount: 1 },
  capsuleAxis: "local-y",
  transformSpace: "joint-bind-local",
};

await writeFile(outputPath, JSON.stringify(output));
await writeFile(observationsPath, JSON.stringify(observations));
