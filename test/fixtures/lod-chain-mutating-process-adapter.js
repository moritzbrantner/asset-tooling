#!/usr/bin/env bun

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [mode, ...args] = process.argv.slice(2);

if (mode === "probe" && args.length === 0) {
  process.stdout.write(
    `${JSON.stringify([
      {
        id: "three-d-lod-chain",
        version: "0.1.0",
        algorithm: "fixture-source-based-lod-v1",
        protocol: "asset-tooling-process-adapter-v1",
        codec: "three-d-lod-chain-json-v1",
        dependencies: { fixture: "1" },
        cargoLock: "fixture-lock-v1",
      },
    ])}\n`,
  );
  process.exit(0);
}

if (mode !== "generate" || args.length !== 3) {
  process.stderr.write(
    "usage: lod-chain-mutating-process-adapter.js probe | generate REQUEST OUTPUT OBSERVATIONS\n",
  );
  process.exit(2);
}

const [requestPath, outputPath, observationsPath] = args;
const request = JSON.parse(await readFile(requestPath, "utf8"));
if (request.schemaVersion !== 1 || request.operation !== "mesh.lod_chain") {
  throw new Error("unsupported fixture request");
}

const sourcePath = path.join(process.cwd(), ...request.inputPath.split("/"));
const source = JSON.parse(await readFile(sourcePath, "utf8"));
const sourceTriangleCount = source.indices.length / 3;
const levels = request.parameters.levels.map((level, index) => {
  const resultIndices = source.indices.slice(0, level.targetTriangleCount * 3);
  return {
    output: {
      level: index + 1,
      triangleRatio: level.triangleRatio,
      indices: resultIndices,
    },
    observations: {
      level: index + 1,
      triangleRatio: level.triangleRatio,
      requestedTriangleCount: level.targetTriangleCount,
      resultTriangleCount: resultIndices.length / 3,
      resultIndexCount: resultIndices.length,
      relativeError: 0,
    },
  };
});
const sourceVertices = source.vertices.map((vertex) => [...vertex]);
sourceVertices[0][0] += 1;

await writeFile(
  outputPath,
  JSON.stringify({
    schemaVersion: 1,
    sourceVertices,
    levels: levels.map((level) => level.output),
  }),
  "utf8",
);
await writeFile(
  observationsPath,
  JSON.stringify({
    sourceTriangleCount,
    sourceVertexCount: source.vertices.length,
    sourceBased: true,
    sharedSourceVertexBuffer: true,
    levels: levels.map((level) => level.observations),
  }),
  "utf8",
);
