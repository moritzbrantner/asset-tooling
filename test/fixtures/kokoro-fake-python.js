// Fake "Python" for the Kokoro adapter acceptance tests (asset-tooling#30).
//
// It stands in for the venv interpreter so CI can exercise the TypeScript side of the
// process-adapter protocol without torch, kokoro, misaki or the model. The test passes it as
// the adapter's `python` command: [process.execPath, <this file>, <stateDir>]. The adapter then
// appends `<script path> probe` or `<script path> generate REQUEST OUTPUT OBSERVATIONS`.
//
// <stateDir>/config.json controls behaviour and is re-read on every invocation:
//   probe:   JSON array printed for `probe` (default: a fixed fixture runtime)
//   probeExitCode / probeStderr: make `probe` fail
//   output:  { sampleRate, channels, frames, silent?, raw? } for the WAV written by `generate`
//   generateExitCode / generateStderr: make `generate` fail
//   observations: JSON object written as observations.json
// Every invocation is appended to <stateDir>/invocations.jsonl with its argv, environment,
// the parsed request (for `generate`) and the SHA-256 of every request string that names an
// existing regular file at invocation time.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const [stateDir, scriptPath, mode, requestPath, outputPath, observationsPath] = process.argv.slice(2);
const config = JSON.parse(readFileSync(path.join(stateDir, "config.json"), "utf8"));

function referencedFiles(value, found = {}) {
  if (typeof value === "string") {
    try {
      if (existsSync(value) && statSync(value).isFile()) {
        found[value] = createHash("sha256").update(readFileSync(value)).digest("hex");
      }
    } catch {
      // not a path
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) referencedFiles(entry, found);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) referencedFiles(entry, found);
  }
  return found;
}

function log(entry) {
  appendFileSync(
    path.join(stateDir, "invocations.jsonl"),
    `${JSON.stringify({ scriptPath, mode, argv: process.argv.slice(3), env: { ...process.env }, ...entry })}\n`,
  );
}

function wav({ sampleRate, channels, frames, silent = false }) {
  const samples = frames * channels;
  const dataSize = samples * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples; index += 1) {
    bytes.writeInt16LE(silent ? 0 : ((index * 97) % 4000) - 2000, 44 + index * 2);
  }
  return bytes;
}

if (mode === "probe") {
  log({});
  if (config.probeExitCode) {
    process.stderr.write(config.probeStderr ?? "fake probe failure\n");
    process.exit(config.probeExitCode);
  }
  process.stdout.write(`${JSON.stringify(config.probe ?? [{ id: "fixture.kokoro-runtime", version: "1" }])}\n`);
  process.exit(0);
}

if (mode === "generate" && requestPath && outputPath && observationsPath) {
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  log({ request, files: referencedFiles(request) });
  if (config.generateExitCode) {
    process.stderr.write(config.generateStderr ?? "fake generate failure\n");
    process.exit(config.generateExitCode);
  }
  const output = config.output ?? { sampleRate: 24000, channels: 1, frames: 4800 };
  writeFileSync(outputPath, output.raw !== undefined ? Buffer.from(output.raw, "utf8") : wav(output));
  writeFileSync(observationsPath, `${JSON.stringify(config.observations ?? { fixture: "kokoro-fake" })}\n`);
  process.exit(0);
}

log({});
process.stderr.write("usage: kokoro-fake-python.js STATE_DIR SCRIPT probe | generate REQUEST OUTPUT OBSERVATIONS\n");
process.exit(2);
