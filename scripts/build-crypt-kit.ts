// Build the undead crypt environment kit bundle (#269, docs/crypt-kit.md) from the scripted Blender recipe
// adapters/blender/crypt.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-crypt-kit.ts --out <directory>
// Each module is one external.blender.script@1 run, imported through scene.import.gltf@2. The
// crypt-kit-descriptor-v1 attachment combines the recipe's observations (proxies, doorway, hinge, lights)
// with bounds measured on the imported GLBs. <directory> becomes the object-store root; the bundle is
// exported to <directory>/bundle and packed to <directory>/crypt.kit.tar (+ .sha256).
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO, type Document } from "@gltf-transform/core";
import { GLTF_RESOURCES_BUNDLE_PROFILE, exportAssetBundle } from "../src/asset-bundle.js";
import { ASSET_BUNDLE_REF_FILE, readAssetBundleTar } from "../src/asset-bundle-pack.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { executeGltfProductionImportOperation } from "../src/gltf-production-operations.js";
import { generateAsset } from "../src/index.js";
import { parseAssetSpec } from "../src/schema.js";
import type { AssetOperationResult, AssetRef } from "../src/operations.js";

type Json = Record<string, any>;
type Vec3 = [number, number, number];
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export const CRYPT_PARTS = ["wall", "doorway-narrow", "doorway-wide", "door", "floor", "pillar", "sarcophagus", "candles", "bones"] as const;
export type CryptPart = (typeof CRYPT_PARTS)[number];
export const CRYPT_KEY_PREFIX = "crypt.kit";
export const CRYPT_VARIANT = "default";
export const CRYPT_DESCRIPTOR_SCHEMA = "crypt-kit-descriptor-v1";
export const CRYPT_DESCRIPTOR_ATTACHMENT = "crypt-descriptor";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const CRYPT_RELEASE = "crypt-kit";
export const CRYPT_TAR_NAME = "crypt.kit.tar";
export const CRYPT_GRID = { module: 2, wallHeight: 3, wallThickness: 0.5, floorTop: 0 } as const;
const CATEGORY: Record<CryptPart, "structure" | "prop"> = {
  wall: "structure", "doorway-narrow": "structure", "doorway-wide": "structure", door: "structure", floor: "structure",
  pillar: "structure", sarcophagus: "prop", candles: "prop", bones: "prop",
};
/** Recipe observations copied into the descriptor when a module declares them. */
const EXTRAS = ["module", "doorway", "hinge", "mount", "lights", "lid"] as const;

const round = (value: number) => { const r = Math.round(value * 1e6) / 1e6; return r === 0 ? 0 : r; };
const round3 = (v: readonly number[]): Vec3 => [round(v[0]!), round(v[1]!), round(v[2]!)];

function single(result: AssetOperationResult, port = "output"): AssetRef {
  const output = result.outputs[port];
  if (!output || Array.isArray(output)) throw new Error(`operation output '${port}' is missing`);
  return output;
}

export const cryptKey = (part: CryptPart) => `${CRYPT_KEY_PREFIX}.${part}`;

export function createCryptAssetSpec({ part, scriptSha256, blenderVersion }: { part: CryptPart; scriptSha256: string; blenderVersion: string }) {
  return parseAssetSpec({
    schemaVersion: 1, assetId: cryptKey(part), generator: { id: "external.blender.script", version: "1" }, randomness: { mode: "none" },
    inputs: { script: { path: "crypt.py", sha256: scriptSha256 } }, models: {},
    parameters: { blenderVersion, arguments: { schemaVersion: 1, part } }, output: { path: "crypt.glb" }, reproducibility: { expected: "exact" },
  });
}

/** World-space AABB of every mesh node in the document. */
export function documentBounds(document: Document): { min: Vec3; max: Vec3 } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
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
  if (!Number.isFinite(min[0]!)) throw new Error("no mesh geometry");
  return { min: round3(min), max: round3(max) };
}

function triangles(document: Document) {
  let count = 0;
  for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    count += (primitive.getIndices()?.getCount() ?? primitive.getAttribute("POSITION")!.getCount()) / 3;
  }
  return count;
}

export async function buildCryptKit({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("crypt.py");
  const io = new NodeIO();
  const parts = {} as Record<CryptPart, { asset: AssetRef; document: Document; observations: Json }>;
  for (const part of CRYPT_PARTS) {
    log(`generate ${part} (external.blender.script@1 crypt recipe, scene.import.gltf@2)`);
    const workspace = path.join(root, "crypt", part);
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "crypt.py"), source.bytes);
    const specPath = path.join(workspace, "asset.json");
    await writeFile(specPath, `${canonicalJson(createCryptAssetSpec({ part, scriptSha256: source.sha256, blenderVersion: source.blenderVersion }))}\n`);
    const generated = await generateAsset(specPath);
    const observations = (generated.receipt.observations as Json).script as Json;
    const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, "crypt.glb")), kind: "mesh", mediaType: "model/gltf-binary" })).asset;
    const asset = single(await executeGltfProductionImportOperation(root, { inputs: { source: glb }, parameters: { policy: { allowedValidatorWarnings: [] } } }));
    parts[part] = { asset, document: await io.readBinary(new Uint8Array(await resolveAssetObject(root, asset))), observations };
  }

  log("measure the crypt-kit descriptor");
  const assets = CRYPT_PARTS.map((part) => {
    const { document, observations } = parts[part];
    const bounds = documentBounds(document);
    const entry: Json = {
      key: cryptKey(part), role: part, category: CATEGORY[part], parentName: `crypt.${part}`, triangles: triangles(document),
      footprint: { width: round(bounds.max[0] - bounds.min[0]), depth: round(bounds.max[2] - bounds.min[2]), height: round(bounds.max[1] - bounds.min[1]) },
      bounds, collisionProxies: observations.collisionProxies,
    };
    for (const extra of EXTRAS) if (observations[extra] !== undefined) entry[extra] = observations[extra];
    return entry;
  }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const descriptor = {
    schema: CRYPT_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right", origin: "module-base-center",
    grid: CRYPT_GRID, assets,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "crypt-descriptor", mediaType: "application/json" })).asset;

  log("export gltf-resources-v1 bundle (asset.bundle@4)");
  const bundleDir = path.join(root, "bundle");
  const selections = CRYPT_PARTS.map((part) => ({ key: cryptKey(part), variant: CRYPT_VARIANT, ...(part === "wall" ? { attachments: [{ name: CRYPT_DESCRIPTOR_ATTACHMENT }] } : {}) }));
  await exportAssetBundle(root, bundleDir, {
    parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections },
    inputs: { assets: CRYPT_PARTS.map((part) => parts[part].asset), attachments: [descriptorAsset] },
  });
  const tarPath = path.join(root, CRYPT_TAR_NAME);
  log("pack release tar (scripts/pack-asset-bundle.ts)");
  const pack = Bun.spawnSync(["bun", path.join(REPOSITORY_ROOT, "scripts/pack-asset-bundle.ts"), bundleDir, tarPath], { stdout: "pipe", stderr: "pipe" });
  if (pack.exitCode !== 0) throw new Error(`pack-asset-bundle failed: ${pack.stderr.toString()}`);
  const packed = JSON.parse(pack.stdout.toString());
  const refEntry = readAssetBundleTar(await readFile(tarPath)).find((entry) => entry.path === ASSET_BUNDLE_REF_FILE);
  if (!refEntry) throw new Error(`packed tar has no ${ASSET_BUNDLE_REF_FILE}`);
  const exportRefPath = path.join(root, ASSET_BUNDLE_REF_FILE);
  await writeFile(exportRefPath, refEntry.bytes);
  return {
    bundleDir, tar: tarPath, tarSha256: packed.sha256 as string, tarByteLength: packed.byteLength as number, descriptor,
    documents: Object.fromEntries(CRYPT_PARTS.map((part) => [part, parts[part].document])) as Record<CryptPart, Document>,
    exportRef: JSON.parse(Buffer.from(refEntry.bytes).toString("utf8")) as Json, exportRefPath,
    lineage: { recipe: { script: "adapters/blender/crypt.py", sha256: source.sha256, blenderVersion: source.blenderVersion }, release: CRYPT_RELEASE, parts: Object.fromEntries(CRYPT_PARTS.map((part) => [part, parts[part].asset])), descriptor: descriptorAsset },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") {
    console.error("Usage: ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-crypt-kit.ts --out <directory>");
    process.exit(2);
  }
  try {
    const result = await buildCryptKit({ outDir: args[1]!, log: (line) => console.error(`[crypt] ${line}`) });
    await writeFile(path.join(path.resolve(args[1]!), "lineage.json"), `${JSON.stringify(result.lineage, null, 2)}\n`);
    console.log(JSON.stringify({ bundle: result.bundleDir, tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength, exportRef: result.exportRef }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}
