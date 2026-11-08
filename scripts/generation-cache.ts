// The shared generation-cache directory a release build reuses across runs (docs/cache.md#shared-cache-directory,
// #516): every generateAsset of the build, whatever throwaway --out folder its spec is written into, reads and
// writes the same directory, and the Publish rolling releases workflow restores and saves it between runs.
//   bun scripts/generation-cache.ts key                      # the Blender backend's cache-source fingerprint
//   bun scripts/generation-cache.ts prune <dir> --since <ms> # drop entries the build since <ms> did not use
// This module imports nothing from src/ at load time, so the release planner can import it cheaply.
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The environment variable generateAsset reads (GENERATION_CACHE_DIRECTORY_ENV in src/core.ts). */
export const GENERATION_CACHE_DIRECTORY_ENV = "ASSET_TOOLING_GENERATION_CACHE_DIR";

/** `<repository>/.asset-tooling/cache`, the default, so repeated local builds reuse it too. */
export const DEFAULT_GENERATION_CACHE_DIRECTORY = path.resolve(fileURLToPath(new URL("../.asset-tooling/cache", import.meta.url)));

/**
 * Select the shared generation-cache directory for this process and the builds it spawns: `directory` (a flag),
 * else ASSET_TOOLING_GENERATION_CACHE_DIR, else the default. Returns the absolute directory.
 */
export function useSharedGenerationCache(directory?: string): string {
  const configured = process.env[GENERATION_CACHE_DIRECTORY_ENV];
  const chosen = path.resolve(directory || configured || DEFAULT_GENERATION_CACHE_DIRECTORY);
  process.env[GENERATION_CACHE_DIRECTORY_ENV] = chosen;
  return chosen;
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "key" && rest.length === 0) {
    const { captureScopedToolIdentity } = await import("../src/tool.js");
    const { BLENDER_SCRIPT_CACHE_SOURCES } = await import("../src/blender-script-backend.js");
    console.log((await captureScopedToolIdentity(BLENDER_SCRIPT_CACHE_SOURCES)).sourceFingerprint.sha256);
  } else if (command === "prune" && rest.length === 3 && rest[1] === "--since" && /^[0-9]+$/.test(rest[2]!)) {
    const { pruneGenerationCache } = await import("../src/cache.js");
    console.log(JSON.stringify(await pruneGenerationCache(path.resolve(rest[0]!), new Date(Number(rest[2])))));
  } else {
    console.error("Usage: bun scripts/generation-cache.ts key | prune <directory> --since <epoch milliseconds>");
    process.exit(2);
  }
}
