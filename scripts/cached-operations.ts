// The Ranger build's non-Blender operations through the operation result cache (#516 step 4, docs/cache.md): each
// call runs through runAssetOperation with the build's shared cache directory (the same one the Blender steps use), so
// a repeated build into a fresh --out reuses every unchanged import, compose, subset, extract, embed, retarget, image
// codec and texture-resize result, and verifies each output by its SHA-256 before reuse. `verify` never reads it.
//
// The key is the operation build identity: operation id@version, the canonical parameters, the input AssetRefs, and
// an implementation identity scoped to the operation module's own source closure (scripts/source-closure.ts) and the
// dependency lock, plus the external tools it runs (ffmpeg/ffprobe for the image codecs, the pinned processor revision
// for the retarget). An edit elsewhere in src/** keeps the entries; an edit in the closure misses.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ANIMATION_RETARGET_OPERATION, executeAnimationRetargetOperation } from "../src/animation-processing-operations.js";
import { runAssetOperation } from "../src/asset-store.js";
import { readDependencyLockSha256 } from "../src/dependency-lock.js";
import { GLTF_EMBED_ANIMATION_OPERATION, GLTF_EXTRACT_ANIMATION_OPERATION, executeGltfEmbedAnimationOperation, executeGltfExtractAnimationOperation } from "../src/gltf-animation-operations.js";
import { GLTF_COMPOSE_SKINNED_OPERATION, executeGltfComposeSkinnedOperation } from "../src/gltf-compose-operations.js";
import { GLTF_PRODUCTION_IMPORT_OPERATION, executeGltfProductionImportOperation } from "../src/gltf-production-operations.js";
import { GLTF_SUBSET_SKINNED_OPERATION, executeGltfSubsetSkinnedOperation } from "../src/gltf-subset-operations.js";
import { GLTF_TEXTURE_RESIZE_OPERATION, executeGltfTextureResizeOperation } from "../src/gltf-texture-resize-operations.js";
import { IMAGE_DECODE_OPERATION, IMAGE_ENCODE_PNG_OPERATION, executeImageDecodeOperation, executeImageEncodePngOperation } from "../src/image-codec-operations.js";
import type { AssetOperationInvocation, AssetOperationResult, ReadonlyAssetOperationDescriptor } from "../src/operations.js";
import { captureScopedToolIdentity } from "../src/tool.js";
import { GENERATION_CACHE_DIRECTORY_ENV } from "./generation-cache.ts";
import { sourceClosure } from "./source-closure.ts";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

type Json = Record<string, unknown>;
type Executor<Extra extends unknown[]> = (root: string, invocation: AssetOperationInvocation, ...extra: Extra) => Promise<AssetOperationResult>;

/** The repository files an operation module's output depends on: its source closure, regular files only. */
export function operationCacheSources(module: string, root: string = REPOSITORY_ROOT): string[] {
  return sourceClosure([module], root).filter((file) => statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile());
}

const memo = new Map<string, Promise<unknown>>();
function once<T>(key: string, compute: () => Promise<T>): Promise<T> {
  if (!memo.has(key)) memo.set(key, compute());
  return memo.get(key) as Promise<T>;
}

/** The first line of `<tool> -version` (ffmpeg, ffprobe) or `<tool> -V` (cargo, rustc): the build an operation runs. */
function toolVersion(executable: string, flag = "-version"): string {
  const result = spawnSync(executable, [flag], { encoding: "utf8" });
  const line = result.status === 0 ? String(result.stdout).split(/\r?\n/, 1)[0]?.trim() : undefined;
  if (!line) throw new Error(`${executable} ${flag} failed; a cached operation needs its identity`);
  return line;
}

/** Implementation identity of `module`: its scoped source fingerprint and the dependency lock (memoized per process). */
function moduleIdentity(module: string, root: string = REPOSITORY_ROOT) {
  return once(`module:${root}:${module}`, async () => ({
    module,
    sources: (await captureScopedToolIdentity(operationCacheSources(module, root), root)).sourceFingerprint,
    dependencyLockSha256: await readDependencyLockSha256(),
  }));
}

const imageCodecTools = () => once("ffmpeg", async () => ({ ffmpeg: toolVersion("ffmpeg"), ffprobe: toolVersion("ffprobe") }));

/** The shared cache directory of this build (ASSET_TOOLING_GENERATION_CACHE_DIR), or none: then nothing is cached. */
export function operationCacheDirectory(): string | undefined {
  const directory = process.env[GENERATION_CACHE_DIRECTORY_ENV];
  return directory && path.isAbsolute(directory) ? directory : undefined;
}

export type OperationCacheStatistics = { hits: number; misses: number };
const statistics: OperationCacheStatistics = { hits: 0, misses: 0 };
/** Hits and misses of the cached operations in this process. */
export function operationCacheStatistics(): OperationCacheStatistics {
  return { ...statistics };
}

/**
 * `execute` through runAssetOperation with the shared cache directory: the same signature and result. `extra` arguments
 * (the retarget's processor) reach `execute` unchanged; `implementation(...extra)` names what in them affects the
 * output. Without a shared directory it calls `execute` directly.
 */
export function cachedOperation<Extra extends unknown[]>(descriptor: ReadonlyAssetOperationDescriptor, module: string, execute: Executor<Extra>,
  implementation: (...extra: Extra) => Promise<Json> | Json = () => ({})): Executor<Extra> {
  if (!existsSync(path.join(REPOSITORY_ROOT, module))) throw new Error(`cached operation module '${module}' does not exist`);
  return async (root, invocation, ...extra) => {
    const directory = operationCacheDirectory();
    if (!directory) return execute(root, invocation, ...extra);
    const run = await runAssetOperation(root, {
      descriptor,
      implementation: { id: "asset-tooling.cached-operation", version: "1", ...await moduleIdentity(module), ...await implementation(...extra) },
      execute: (assetRoot, canonical) => execute(assetRoot, canonical, ...extra),
    }, { parameters: invocation.parameters ?? {}, inputs: invocation.inputs ?? {} }, { cacheDirectory: directory });
    statistics[run.status === "hit" ? "hits" : "misses"] += 1;
    return run.result;
  };
}

export const cachedImport = cachedOperation(GLTF_PRODUCTION_IMPORT_OPERATION, "src/gltf-production-operations.ts", executeGltfProductionImportOperation);
export const cachedSubset = cachedOperation(GLTF_SUBSET_SKINNED_OPERATION, "src/gltf-subset-operations.ts", executeGltfSubsetSkinnedOperation);
export const cachedCompose = cachedOperation(GLTF_COMPOSE_SKINNED_OPERATION, "src/gltf-compose-operations.ts", executeGltfComposeSkinnedOperation);
export const cachedExtract = cachedOperation(GLTF_EXTRACT_ANIMATION_OPERATION, "src/gltf-animation-operations.ts", executeGltfExtractAnimationOperation);
export const cachedEmbed = cachedOperation(GLTF_EMBED_ANIMATION_OPERATION, "src/gltf-animation-operations.ts", executeGltfEmbedAnimationOperation);
export const cachedTextureResize = cachedOperation(GLTF_TEXTURE_RESIZE_OPERATION, "src/gltf-texture-resize-operations.ts", executeGltfTextureResizeOperation, imageCodecTools);
export const cachedImageDecode = cachedOperation(IMAGE_DECODE_OPERATION, "src/image-codec-operations.ts", executeImageDecodeOperation, imageCodecTools);
export const cachedImageEncodePng = cachedOperation(IMAGE_ENCODE_PNG_OPERATION, "src/image-codec-operations.ts", executeImageEncodePngOperation, imageCodecTools);
const rustTools = () => once("rust", async () => ({ cargo: toolVersion("cargo", "-V"), rustc: toolVersion("rustc", "-V") }));

/**
 * The retarget runs the pinned processor checkout with cargo: the repository, revision and the cargo/rustc versions are
 * part of the identity, the checkout path is not.
 */
export const cachedRetarget = cachedOperation(ANIMATION_RETARGET_OPERATION, "src/animation-processing-operations.ts",
  executeAnimationRetargetOperation as Executor<[processor: { repository: string; revision: string }]>,
  async (processor) => ({ processor: { repository: processor.repository, revision: processor.revision, ...await rustTools() } }));
