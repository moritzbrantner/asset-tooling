#!/usr/bin/env bun
import path from "node:path";
import { doctorLocal3DBatch, runLocal3DBatch } from "../src/local-3d-batch.js";

function usage() {
  return [
    "Usage: bun scripts/run-weekend-3d.ts [options]",
    "",
    "  --config PATH       Config file (default: weekend-3d.local.json)",
    "  --doctor            Verify models, FFmpeg, Python adapters, and accelerator",
    "  --dry-run           Parse and plan without inference",
    "  --refresh-lock      Accept current local model-bundle hashes",
    "  --max-items N       Run at most N unchecked jobs",
    "  --only ASSET_ID     Run/resume one unchecked job",
  ].join("\n");
}

const args = process.argv.slice(2);
let config = "weekend-3d.local.json";
let doctor = false;
let dryRun = false;
let refreshLock = false;
let maxItems;
let only;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--config") {
    config = args[++index];
    if (!config) throw new Error("--config requires a path");
  } else if (arg === "--doctor") {
    doctor = true;
  } else if (arg === "--dry-run") {
    dryRun = true;
  } else if (arg === "--refresh-lock") {
    refreshLock = true;
  } else if (arg === "--max-items") {
    const value = Number(args[++index]);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error("--max-items requires a positive integer");
    }
    maxItems = value;
  } else if (arg === "--only") {
    only = args[++index];
    if (!only) throw new Error("--only requires an asset id");
  } else if (arg === "--help" || arg === "-h") {
    console.log(usage());
    process.exit(0);
  } else {
    throw new Error("unknown option '" + arg + "'\n\n" + usage());
  }
}

const root = path.resolve(".");
const result = doctor
  ? await doctorLocal3DBatch(root, config, { refreshLock })
  : await runLocal3DBatch(root, config, { dryRun, refreshLock, maxItems, only });

console.log(JSON.stringify(result, null, 2));
if (result.status === "completed-with-failures") process.exitCode = 1;
