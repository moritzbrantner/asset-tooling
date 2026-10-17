import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { applyAssetCatalogLfsPromotion } from "../src/catalog-lfs-promotion.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const USAGE =
  "usage: bun scripts/promote-catalog-lfs-source.ts <catalog-source-id | archive-member-id> [--from <file> | --from=<file>]";

// Returns { sourceId, localFile? } or null for a usage error.
function parseArguments(args) {
  let sourceId;
  let localFile;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    let value;
    if (argument === "--from") {
      value = args[index + 1];
      index += 1;
    } else if (argument.startsWith("--from=")) {
      value = argument.slice("--from=".length);
    } else if (argument.startsWith("-")) {
      return null;
    } else if (sourceId === undefined) {
      sourceId = argument;
      continue;
    } else {
      return null;
    }
    if (localFile !== undefined || value === undefined || value.length === 0) return null;
    // A relative --from path is relative to where the command was run.
    localFile = path.resolve(process.cwd(), value);
  }
  if (!sourceId) return null;
  return localFile === undefined ? { sourceId } : { sourceId, localFile };
}

const parsed = parseArguments(process.argv.slice(2));

if (!parsed) {
  console.error(USAGE);
  process.exitCode = 2;
} else {
  const providersDocument = JSON.parse(await readFile(path.join(root, "catalog/providers.json"), "utf8"));
  const sourcesDocument = JSON.parse(await readFile(path.join(root, "catalog/sources.json"), "utf8"));
  const storageDocument = JSON.parse(await readFile(path.join(root, "catalog/storage.json"), "utf8"));

  try {
    const result = await applyAssetCatalogLfsPromotion({
      providersDocument,
      sourcesDocument,
      storageDocument,
      sourceId: parsed.sourceId,
      repositoryRoot: root,
      ...(parsed.localFile === undefined ? {} : { localFile: parsed.localFile }),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
