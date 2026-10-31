// Shared pieces of the scripted kit builders (#424): run every part's Blender recipe and import it, measure the
// imported documents, export the bundle and pack the release tar. Each scripts/build-<kit>.ts keeps only its
// constants, its spec and its descriptor.
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { NodeIO, type Document } from "@gltf-transform/core";
import { exportAssetBundle } from "./asset-bundle.js";
import { ASSET_BUNDLE_REF_FILE, packAssetBundle } from "./asset-bundle-pack.js";
import { resolveAssetObject } from "./asset-store.js";
import { runBlenderRecipe } from "./blender-recipe-run.js";
import type { blenderScriptSpec } from "./blender-script-spec.js";
import { canonicalJson } from "./canonical.js";
import { executeGltfProductionImportOperation } from "./gltf-production-operations.js";
import type { AssetOperationResult, AssetRef } from "./operations.js";

type Json = Record<string, any>;
export type Vec3 = [number, number, number];

/** The single AssetRef an operation wrote to `port`. */
export function single(result: AssetOperationResult, port = "output"): AssetRef {
  const output = result.outputs[port];
  if (!output || Array.isArray(output)) throw new Error(`operation output '${port}' is missing`);
  return output;
}

/** Round to 6 decimals, without negative zero. */
export const round = (value: number) => { const r = Math.round(value * 1e6) / 1e6; return r === 0 ? 0 : r; };
export const round3 = (v: readonly number[]): Vec3 => [round(v[0]!), round(v[1]!), round(v[2]!)];

/** World-space AABB of every mesh node in the document, or of the mesh node named `nodeName`. */
export function documentBounds(document: Document, nodeName?: string): { min: Vec3; max: Vec3 } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || (nodeName !== undefined && node.getName() !== nodeName)) continue;
    const m = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION")!;
      const p: number[] = [0, 0, 0];
      for (let i = 0; i < position.getCount(); i += 1) {
        position.getElement(i, p);
        for (let k = 0; k < 3; k += 1) {
          const w = m[k]! * p[0]! + m[4 + k]! * p[1]! + m[8 + k]! * p[2]! + m[12 + k]!;
          min[k] = Math.min(min[k]!, w); max[k] = Math.max(max[k]!, w);
        }
      }
    }
  }
  if (!Number.isFinite(min[0]!)) throw new Error(`no mesh geometry${nodeName ? ` for node '${nodeName}'` : ""}`);
  return { min: round3(min), max: round3(max) };
}

/** The rounded world translation of the empty (mesh-less) node `name`. */
export function emptyTranslation(document: Document, name: string): Vec3 {
  const node = document.getRoot().listNodes().find((candidate) => candidate.getName() === name && !candidate.getMesh());
  if (!node) throw new Error(`empty node '${name}' is missing`);
  return round3(node.getWorldTranslation());
}

/** Triangle count of every primitive in the document. */
export function triangles(document: Document) {
  let count = 0;
  for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    count += (primitive.getIndices()?.getCount() ?? primitive.getAttribute("POSITION")!.getCount()) / 3;
  }
  return count;
}

/** A kit part: the asset that enters the bundle, its document and the recipe's observations. */
export type KitPart = { asset: AssetRef; document: Document; observations: Json };

/**
 * Run one part's recipe and import its GLB through scene.import.gltf@2. `use: "imported"` (the default) bundles
 * the imported asset; `use: "source"` bundles the recipe's GLB as written, with the import only as validation.
 */
export async function buildKitPart(root: string, { workspace, spec, files, use = "imported", allowedValidatorWarnings = [] }: {
  workspace: string; spec: ReturnType<typeof blenderScriptSpec>; files: Record<string, Uint8Array>; use?: "imported" | "source";
  allowedValidatorWarnings?: string[];
}): Promise<KitPart> {
  const { glb, observations } = await runBlenderRecipe(root, { workspace, spec, files });
  const imported = single(await executeGltfProductionImportOperation(root, { inputs: { source: glb }, parameters: { policy: { allowedValidatorWarnings } } }));
  const asset = use === "imported" ? imported : glb;
  return { asset, document: await new NodeIO().readBinary(new Uint8Array(await resolveAssetObject(root, asset))), observations };
}

/**
 * The shared descriptor entry of the modular kits (crypt, shrine, outpost, settlement props): key, role, the
 * kit's own `fields`, triangles, footprint, bounds and collision proxies, then every `extras` observation the
 * recipe declared.
 */
export function kitEntry({ key, role, fields, document, observations, extras }: {
  key: string; role: string; fields: Json; document: Document; observations: Json; extras: readonly string[];
}): Json {
  const bounds = documentBounds(document);
  const entry: Json = {
    key, role, ...fields, triangles: triangles(document),
    footprint: { width: round(bounds.max[0] - bounds.min[0]), depth: round(bounds.max[2] - bounds.min[2]), height: round(bounds.max[1] - bounds.min[1]) },
    bounds, collisionProxies: observations.collisionProxies,
  };
  for (const extra of extras) if (observations[extra] !== undefined) entry[extra] = observations[extra];
  return entry;
}

/** Sort descriptor entries by key. */
export const byKey = (a: Json, b: Json) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

/**
 * Pack an exported bundle into `<root>/<tarName>` (+ `.sha256`), as scripts/pack-asset-bundle.ts does, and write
 * the export ref next to it.
 */
export async function packReleaseTar(root: string, bundleDir: string, tarName: string) {
  const packed = await packAssetBundle(bundleDir);
  const tar = path.join(root, tarName);
  await writeFile(tar, packed.tar);
  await writeFile(`${tar}.sha256`, `${packed.sha256}  ${tarName}\n`);
  const exportRefPath = path.join(root, ASSET_BUNDLE_REF_FILE);
  await writeFile(exportRefPath, `${canonicalJson(packed.ref)}\n`);
  return { tar, tarSha256: packed.sha256, tarByteLength: packed.tar.byteLength, exportRef: packed.ref as Json, exportRefPath };
}

type KitBuildResult = { bundleDir: string; tar: string; tarSha256: string; tarByteLength: number; exportRef: Json; lineage: Json; descriptor: Json };

/**
 * The `--out <directory>` command line every kit builder shares: build, write `lineage.json` (and with
 * `descriptorFile`, `descriptor.json`) next to the tar, and print the bundle, tar and export ref plus `summary`.
 */
export async function runKitCli<R extends KitBuildResult>(script: string, label: string, build: (options: { outDir: string; log: (line: string) => void }) => Promise<R>,
  { descriptorFile = false, summary = () => ({}) }: { descriptorFile?: boolean; summary?: (result: R) => Json } = {}) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") {
    console.error(`Usage: ASSET_TOOLING_BLENDER=<blender 5.2.2> bun ${script} --out <directory>`);
    process.exit(2);
  }
  try {
    const result = await build({ outDir: args[1]!, log: (line) => console.error(`[${label}] ${line}`) });
    await writeFile(path.join(path.resolve(args[1]!), "lineage.json"), `${JSON.stringify(result.lineage, null, 2)}\n`);
    if (descriptorFile) await writeFile(path.join(path.resolve(args[1]!), "descriptor.json"), `${JSON.stringify(result.descriptor, null, 2)}\n`);
    console.log(JSON.stringify({ bundle: result.bundleDir, tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength, exportRef: result.exportRef, ...summary(result) }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}

/** Export the kit bundle to `<root>/bundle` and pack it to `<root>/<tarName>`. */
export async function exportKitBundle(root: string, { invocation, tarName, log = () => {} }: {
  invocation: Parameters<typeof exportAssetBundle>[2]; tarName: string; log?: (line: string) => void;
}) {
  const bundleDir = path.join(root, "bundle");
  log(`export ${(invocation?.parameters as Json | undefined)?.profile} bundle`);
  await exportAssetBundle(root, bundleDir, invocation);
  log(`pack release tar ${tarName}`);
  return { bundleDir, ...(await packReleaseTar(root, bundleDir, tarName)) };
}
