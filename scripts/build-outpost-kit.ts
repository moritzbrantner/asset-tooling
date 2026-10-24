// Build the Greyhaven Outpost building kit bundle (#366, docs/outpost-kit.md) from the scripted Blender recipe
// adapters/blender/outpost.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-outpost-kit.ts --out <directory>
// Each module (and each roof module's slate variant) is one external.blender.script@1 run, imported through
// scene.import.gltf@2. The outpost-kit-descriptor-v1 attachment combines the recipe's observations (proxies,
// openings, hinge, roof, chimney, compositions) with bounds measured on the imported GLBs. <directory> becomes
// the object-store root; the bundle is exported to <directory>/bundle and packed to <directory>/outpost.kit.tar.
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

export const OUTPOST_PARTS = [
  "wall", "wall-half", "wall-window", "wall-door", "door", "corner", "gable", "roof", "roof-half", "roof-verge", "chimney",
] as const;
export type OutpostPart = (typeof OUTPOST_PARTS)[number];
/** Roof modules also ship a `slate` variant; their `default` is shingle. */
export const OUTPOST_ROOF_PARTS: readonly OutpostPart[] = ["roof", "roof-half", "roof-verge"];
export const OUTPOST_ROOF_VARIANTS = { default: "shingle", slate: "slate" } as const;
export const OUTPOST_KEY_PREFIX = "outpost.kit";
export const OUTPOST_VARIANT = "default";
export const OUTPOST_DESCRIPTOR_SCHEMA = "outpost-kit-descriptor-v1";
export const OUTPOST_DESCRIPTOR_ATTACHMENT = "outpost-descriptor";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const OUTPOST_RELEASE = "outpost-kit";
export const OUTPOST_TAR_NAME = "outpost.kit.tar";
export const OUTPOST_GRID = {
  module: 2, halfModule: 1, wallHeight: 3.2, wallThickness: 0.32, plinthHeight: 0.5,
  span: 6, pitchDegrees: 30, eaveOverhang: 0.35, vergeOverhang: 0.3,
} as const;
/** Triangle ceilings per module, for the Greyhaven camera (12 m, 0.42 rad pitch, 50 degree fov). */
export const OUTPOST_TRIANGLE_BUDGET: Record<OutpostPart, number> = {
  wall: 500, "wall-half": 400, "wall-window": 800, "wall-door": 800, door: 300, corner: 200, gable: 400,
  roof: 500, "roof-half": 450, "roof-verge": 450, chimney: 400,
};
const CATEGORY: Record<OutpostPart, "wall" | "door" | "corner" | "roof" | "chimney"> = {
  wall: "wall", "wall-half": "wall", "wall-window": "wall", "wall-door": "wall", door: "door", corner: "corner",
  gable: "wall", roof: "roof", "roof-half": "roof", "roof-verge": "roof", chimney: "chimney",
};
/** Recipe observations copied into the descriptor when a module declares them. */
const EXTRAS = ["module", "window", "doorway", "mount", "hinge", "leafBounds", "roof", "span", "smoke"] as const;

const round = (value: number) => { const r = Math.round(value * 1e6) / 1e6; return r === 0 ? 0 : r; };
const round3 = (v: readonly number[]): Vec3 => [round(v[0]!), round(v[1]!), round(v[2]!)];

function single(result: AssetOperationResult, port = "output"): AssetRef {
  const output = result.outputs[port];
  if (!output || Array.isArray(output)) throw new Error(`operation output '${port}' is missing`);
  return output;
}

export const outpostKey = (part: OutpostPart) => `${OUTPOST_KEY_PREFIX}.${part}`;

export function createOutpostAssetSpec({ part, roof, scriptSha256, blenderVersion }: { part: OutpostPart; roof?: "shingle" | "slate"; scriptSha256: string; blenderVersion: string }) {
  return parseAssetSpec({
    schemaVersion: 1, assetId: outpostKey(part), generator: { id: "external.blender.script", version: "1" }, randomness: { mode: "none" },
    inputs: { script: { path: "outpost.py", sha256: scriptSha256 } }, models: {},
    parameters: { blenderVersion, arguments: { schemaVersion: 1, part, ...(roof ? { roof } : {}) } }, output: { path: "outpost.glb" }, reproducibility: { expected: "exact" },
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

type Built = { part: OutpostPart; variant: string; asset: AssetRef; document: Document; observations: Json };

export async function buildOutpostKit({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("outpost.py");
  const io = new NodeIO();
  const runs: { part: OutpostPart; variant: string; roof?: "slate" }[] = OUTPOST_PARTS.flatMap((part) => [
    { part, variant: OUTPOST_VARIANT },
    ...(OUTPOST_ROOF_PARTS.includes(part) ? [{ part, variant: "slate", roof: "slate" as const }] : []),
  ]);
  const built: Built[] = [];
  for (const run of runs) {
    log(`generate ${run.part} ${run.variant} (external.blender.script@1 outpost recipe, scene.import.gltf@2)`);
    const workspace = path.join(root, "outpost", `${run.part}.${run.variant}`);
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "outpost.py"), source.bytes);
    const specPath = path.join(workspace, "asset.json");
    const spec = createOutpostAssetSpec({ part: run.part, roof: run.roof, scriptSha256: source.sha256, blenderVersion: source.blenderVersion });
    await writeFile(specPath, `${canonicalJson(spec)}\n`);
    const generated = await generateAsset(specPath);
    const observations = (generated.receipt.observations as Json).script as Json;
    const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, "outpost.glb")), kind: "mesh", mediaType: "model/gltf-binary" })).asset;
    const asset = single(await executeGltfProductionImportOperation(root, { inputs: { source: glb }, parameters: { policy: { allowedValidatorWarnings: [] } } }));
    built.push({ ...run, asset, document: await io.readBinary(new Uint8Array(await resolveAssetObject(root, asset))), observations });
  }
  const main = (part: OutpostPart) => built.find((b) => b.part === part && b.variant === OUTPOST_VARIANT)!;

  log("measure the outpost-kit descriptor");
  const assets = OUTPOST_PARTS.map((part) => {
    const { document, observations } = main(part);
    const bounds = documentBounds(document);
    const entry: Json = {
      key: outpostKey(part), role: part, category: CATEGORY[part], parentName: `outpost.${part}`, triangles: triangles(document),
      footprint: { width: round(bounds.max[0] - bounds.min[0]), depth: round(bounds.max[2] - bounds.min[2]), height: round(bounds.max[1] - bounds.min[1]) },
      bounds, collisionProxies: observations.collisionProxies,
    };
    for (const extra of EXTRAS) if (observations[extra] !== undefined) entry[extra] = observations[extra];
    if (OUTPOST_ROOF_PARTS.includes(part)) {
      entry.variants = built.filter((b) => b.part === part).map((b) => ({ variant: b.variant, material: b.observations.roofMaterial, triangles: triangles(b.document) }));
    }
    return entry;
  }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const descriptor = {
    schema: OUTPOST_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right", origin: "module-anchor",
    grid: OUTPOST_GRID, assets, compositions: main("wall").observations.compositions,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "outpost-descriptor", mediaType: "application/json" })).asset;

  log("export gltf-resources-v1 bundle (asset.bundle@4)");
  const bundleDir = path.join(root, "bundle");
  const selections = built.map((b) => ({
    key: outpostKey(b.part), variant: b.variant,
    ...(b.part === "wall" && b.variant === OUTPOST_VARIANT ? { attachments: [{ name: OUTPOST_DESCRIPTOR_ATTACHMENT }] } : {}),
  }));
  await exportAssetBundle(root, bundleDir, {
    parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections },
    inputs: { assets: built.map((b) => b.asset), attachments: [descriptorAsset] },
  });
  const tarPath = path.join(root, OUTPOST_TAR_NAME);
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
    documents: Object.fromEntries(OUTPOST_PARTS.map((part) => [part, main(part).document])) as Record<OutpostPart, Document>,
    exportRef: JSON.parse(Buffer.from(refEntry.bytes).toString("utf8")) as Json, exportRefPath,
    lineage: {
      recipe: { script: "adapters/blender/outpost.py", sha256: source.sha256, blenderVersion: source.blenderVersion }, release: OUTPOST_RELEASE,
      parts: Object.fromEntries(built.map((b) => [`${b.part}.${b.variant}`, b.asset])), descriptor: descriptorAsset,
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") {
    console.error("Usage: ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-outpost-kit.ts --out <directory>");
    process.exit(2);
  }
  try {
    const result = await buildOutpostKit({ outDir: args[1]!, log: (line) => console.error(`[outpost] ${line}`) });
    await writeFile(path.join(path.resolve(args[1]!), "lineage.json"), `${JSON.stringify(result.lineage, null, 2)}\n`);
    await writeFile(path.join(path.resolve(args[1]!), "descriptor.json"), `${JSON.stringify(result.descriptor, null, 2)}\n`);
    console.log(JSON.stringify({ bundle: result.bundleDir, tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength, exportRef: result.exportRef }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}
