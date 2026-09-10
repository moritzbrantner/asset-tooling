#!/usr/bin/env bun

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [mode, ...args] = process.argv.slice(2);

if (mode === "probe" && args.length === 0) {
  process.stdout.write(
    `${JSON.stringify([
      {
        id: "three-d-lod",
        version: "0.1.0",
        algorithm: "fixture-mesh-simplify-v1",
        protocol: "asset-tooling-process-adapter-v1",
        codec: "three-d-mesh-json-v1",
        dependencies: { fixture: "1" },
        cargoLock: "fixture-lock-v1",
      },
    ])}\n`,
  );
  process.exit(0);
}

if (mode !== "generate" || args.length !== 3) {
  process.stderr.write("usage: mesh-process-adapter.js probe | generate REQUEST OUTPUT OBSERVATIONS\n");
  process.exit(2);
}

const [requestPath, outputPath, observationsPath] = args;
const request = JSON.parse(await readFile(requestPath, "utf8"));
if (request.schemaVersion !== 1 || request.operation !== "mesh.simplify") {
  throw new Error("unsupported fixture request");
}

const sourcePath = path.join(process.cwd(), ...request.inputPath.split("/"));
const source = JSON.parse(await readFile(sourcePath, "utf8"));
const sourceTriangleCount = source.indices.length / 3;
if (sourceTriangleCount !== request.parameters.sourceTriangleCount) {
  throw new Error("fixture sourceTriangleCount mismatch");
}

const requestedIndexCount = request.parameters.targetTriangleCount * 3;
const resultIndices = source.indices.slice(0, Math.min(requestedIndexCount, source.indices.length));
const output = {
  schemaVersion: 1,
  vertices: source.vertices,
  indices: resultIndices,
};
await writeFile(outputPath, JSON.stringify(output), "utf8");
await writeFile(
  observationsPath,
  JSON.stringify({
    sourceTriangleCount,
    sourceVertexCount: source.vertices.length,
    requestedTriangleCount: request.parameters.targetTriangleCount,
    resultTriangleCount: resultIndices.length / 3,
    resultIndexCount: resultIndices.length,
    relativeError: 0,
    sharedSourceVertexBuffer: true,
  }),
  "utf8",
);
