#!/usr/bin/env bun
import { pathToFileURL } from "node:url";
import { captureEnvironment } from "./environment.js";
import { generateAsset, validateSpec, verifyAsset } from "./core.js";
import { stablePrettyJson } from "./canonical.js";

function usage() {
  return `asset-tooling

Usage:
  asset-tooling validate <asset-spec.json>
  asset-tooling generate <asset-spec.json> [--receipt <relative-path>]
  asset-tooling verify <asset-spec.json> [--receipt <relative-path>]
  asset-tooling fingerprint
`;
}

function parseReceiptOption(args) {
  const index = args.indexOf("--receipt");
  if (index === -1) {
    return undefined;
  }
  if (index + 1 >= args.length) {
    throw new Error("--receipt requires a relative path");
  }
  if (args.length !== 3) {
    throw new Error("unexpected arguments");
  }
  return args[index + 1];
}

export async function main(args) {
  const [command, specPath] = args;
  if (command === "fingerprint") {
    if (args.length !== 1) throw new Error("fingerprint does not accept arguments");
    console.log(stablePrettyJson(await captureEnvironment()).trimEnd());
    return 0;
  }

  if (!command || !specPath) {
    console.error(usage());
    return 2;
  }

  if (command === "validate") {
    if (args.length !== 2) throw new Error("validate accepts exactly one asset spec path");
    console.log(stablePrettyJson(await validateSpec(specPath)).trimEnd());
    return 0;
  }

  if (command === "generate" || command === "verify") {
    const receiptPath = parseReceiptOption(args.slice(1));
    const result =
      command === "generate"
        ? await generateAsset(specPath, { receiptPath })
        : await verifyAsset(specPath, { receiptPath });
    console.log(stablePrettyJson(result).trimEnd());
    return result.status === "broken" || result.status === "drift" ? 1 : 0;
  }

  console.error(usage());
  return 2;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
