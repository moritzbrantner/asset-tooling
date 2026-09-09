#!/usr/bin/env bun
import { pathToFileURL } from "node:url";
import { captureEnvironment } from "./environment.js";
import { generateAsset, validateSpec, verifyAsset } from "./core.js";
import { prepareProcessingHandoff } from "./processing-handoff.js";
import { stablePrettyJson } from "./canonical.js";

function usage() {
  return `asset-tooling

Usage:
  asset-tooling validate <asset-spec.json>
  asset-tooling generate <asset-spec.json> [--receipt <relative-path>]
  asset-tooling verify <asset-spec.json> [--receipt <relative-path>]
  asset-tooling processing-input <asset-spec.json> --media-type <media-type> [--receipt <relative-path>]
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

function parseProcessingInputOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== "--media-type" && flag !== "--receipt") {
      throw new Error(`unexpected argument '${flag}'`);
    }
    if (index + 1 >= args.length) {
      throw new Error(`${flag} requires a value`);
    }
    const value = args[index + 1];
    index += 1;
    if (flag === "--media-type") {
      if (options.mediaType !== undefined) throw new Error("--media-type may be supplied only once");
      options.mediaType = value;
    } else {
      if (options.receiptPath !== undefined) throw new Error("--receipt may be supplied only once");
      options.receiptPath = value;
    }
  }
  if (options.mediaType === undefined) {
    throw new Error("processing-input requires --media-type");
  }
  return options;
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

  if (command === "processing-input") {
    const options = parseProcessingInputOptions(args.slice(2));
    console.log(stablePrettyJson(await prepareProcessingHandoff(specPath, options)).trimEnd());
    return 0;
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
