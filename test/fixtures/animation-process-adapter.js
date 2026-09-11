#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const mode = process.argv[2];
if (mode === "probe") {
  process.stdout.write(
    JSON.stringify([
      {
        id: "three-d-animation-resample",
        version: "0.1.0",
        algorithm: "three-d-animation-resample-v1",
        protocol: "asset-tooling-process-adapter-v1",
        codec: "three-d-animation-json-v1",
        dependencies: { "three-d-animation": "0.1.0" },
        cargoLock: "fixture-animation-lock-v1",
      },
      {
        id: "three-d-animation-reduce",
        version: "0.1.0",
        algorithm: "three-d-animation-key-reduction-v1",
        protocol: "asset-tooling-process-adapter-v1",
        codec: "three-d-animation-json-v1",
        dependencies: { "three-d-animation": "0.1.0" },
        cargoLock: "fixture-animation-lock-v1",
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
const source = JSON.parse(await readFile(path.resolve(process.cwd(), request.inputPath), "utf8"));
const sourceKeyframeCount = source.channels.reduce((total, channel) => total + channel.keyframes.length, 0);

if (request.operation === "animation.resample") {
  const targetTimes = request.parameters.targetTimesSeconds;
  const output = {
    schemaVersion: 1,
    channels: source.channels.map((channel) => ({
      kind: channel.kind,
      node: channel.node,
      keyframes: targetTimes.map((time) => {
        const match = channel.keyframes.find(
          (keyframe) => Math.fround(keyframe.time) === Math.fround(time),
        );
        if (!match) throw new Error("fixture requires target times that already exist in the source");
        return match;
      }),
    })),
  };
  const resultKeyframeCount = output.channels.reduce(
    (total, channel) => total + channel.keyframes.length,
    0,
  );
  await writeFile(outputPath, JSON.stringify(output));
  await writeFile(
    observationsPath,
    JSON.stringify({
      sourceKeyframeCount,
      resultKeyframeCount,
      channelCount: output.channels.length,
      durationSeconds: Math.fround(
        Math.fround(targetTimes[targetTimes.length - 1]) - Math.fround(targetTimes[0]),
      ),
    }),
  );
  process.exit(0);
}

if (request.operation === "animation.reduce") {
  const output = {
    schemaVersion: 1,
    channels: source.channels.map((channel) => ({
      kind: channel.kind,
      node: channel.node,
      keyframes:
        channel.keyframes.length <= 2
          ? channel.keyframes
          : [channel.keyframes[0], channel.keyframes[channel.keyframes.length - 1]],
    })),
  };
  const resultKeyframeCount = output.channels.reduce(
    (total, channel) => total + channel.keyframes.length,
    0,
  );
  await writeFile(outputPath, JSON.stringify(output));
  await writeFile(
    observationsPath,
    JSON.stringify({
      sourceKeyframeCount,
      resultKeyframeCount,
      maxTranslationError: 0,
      maxRotationErrorRadians: 0,
      maxScaleError: 0,
      endpointsPreserved: true,
    }),
  );
  process.exit(0);
}

throw new Error(`unsupported fixture operation '${request.operation}'`);
