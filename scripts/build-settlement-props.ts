// Build the Greyhaven settlement prop bundle (#369, docs/settlement-props.md) from the scripted Blender recipe
// adapters/blender/settlement_props.py, which reuses the Outpost kit recipe (adapters/blender/outpost.py)
// as its declared Python input `outpost`:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-settlement-props.ts --out <directory>
// Each prop is one external.blender.script@1 run, imported through scene.import.gltf@2. The
// settlement-props-descriptor-v1 attachment combines the recipe's observations (proxies, nodes, composition)
// with bounds measured on the imported GLBs. <directory> becomes the object-store root; the bundle is exported
// to <directory>/bundle and packed to <directory>/settlement.props.tar.
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
import { documentBounds } from "./build-outpost-kit.ts";

type Json = Record<string, any>;
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export const SETTLEMENT_PROPS = [
  "stall", "cart", "crate", "barrel", "signpost", "lantern-post", "bench", "fence", "planter", "firewood",
] as const;
export type SettlementProp = (typeof SETTLEMENT_PROPS)[number];
export type SettlementFamily = "market" | "street" | "dressing";
/** mmorpg#421's three families: work/market props, street furniture and architectural dressing. */
export const SETTLEMENT_FAMILY: Record<SettlementProp, SettlementFamily> = {
  stall: "market", cart: "market", crate: "market", barrel: "market",
  signpost: "street", "lantern-post": "street", bench: "street",
  fence: "dressing", planter: "dressing", firewood: "dressing",
};
export const SETTLEMENT_KEY_PREFIX = "settlement.props";
export const SETTLEMENT_VARIANT = "default";
export const SETTLEMENT_DESCRIPTOR_SCHEMA = "settlement-props-descriptor-v1";
export const SETTLEMENT_DESCRIPTOR_ATTACHMENT = "settlement-descriptor";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const SETTLEMENT_RELEASE = "settlement-props";
export const SETTLEMENT_TAR_NAME = "settlement.props.tar";
/** Triangle ceilings per prop, for the Greyhaven camera (12 m, 0.42 rad pitch, 50 degree fov). */
export const SETTLEMENT_TRIANGLE_BUDGET: Record<SettlementProp, number> = {
  stall: 1400, cart: 1600, crate: 300, barrel: 500, signpost: 450, "lantern-post": 400, bench: 350,
  fence: 250, planter: 600, firewood: 1200,
};
/** Recipe observations copied into the descriptor when a prop declares them. */
const EXTRAS = ["stackTop", "sign", "light", "seat", "module"] as const;

const round = (value: number) => { const r = Math.round(value * 1e6) / 1e6; return r === 0 ? 0 : r; };

function single(result: AssetOperationResult, port = "output"): AssetRef {
  const output = result.outputs[port];
  if (!output || Array.isArray(output)) throw new Error(`operation output '${port}' is missing`);
  return output;
}

export const settlementKey = (prop: SettlementProp) => `${SETTLEMENT_KEY_PREFIX}.${prop}`;

export function createSettlementAssetSpec({ prop, scriptSha256, outpostSha256, commonSha256, blenderVersion }: { prop: SettlementProp; scriptSha256: string; outpostSha256: string; commonSha256: string; blenderVersion: string }) {
  return parseAssetSpec({
    schemaVersion: 1, assetId: settlementKey(prop), generator: { id: "external.blender.script", version: "1" }, randomness: { mode: "none" },
    inputs: { script: { path: "settlement_props.py", sha256: scriptSha256 }, outpost: { path: "outpost.py", sha256: outpostSha256 }, common: { path: "kit_common.py", sha256: commonSha256 } }, models: {},
    parameters: { blenderVersion, arguments: { schemaVersion: 1, prop } }, output: { path: "settlement.glb" }, reproducibility: { expected: "exact" },
  });
}

export function triangles(document: Document) {
  let count = 0;
  for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    count += (primitive.getIndices()?.getCount() ?? primitive.getAttribute("POSITION")!.getCount()) / 3;
  }
  return count;
}

type Built = { prop: SettlementProp; asset: AssetRef; document: Document; observations: Json };

export async function buildSettlementProps({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("settlement_props.py");
  const outpost = await readBlenderRecipeSource("outpost.py");
  const common = await readBlenderRecipeSource("kit_common.py");
  const io = new NodeIO();
  const built: Built[] = [];
  for (const prop of SETTLEMENT_PROPS) {
    log(`generate ${prop} (external.blender.script@1 settlement recipe, scene.import.gltf@2)`);
    const workspace = path.join(root, "settlement", prop);
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "settlement_props.py"), source.bytes);
    await writeFile(path.join(workspace, "outpost.py"), outpost.bytes);
    await writeFile(path.join(workspace, "kit_common.py"), common.bytes);
    const specPath = path.join(workspace, "asset.json");
    const spec = createSettlementAssetSpec({ prop, scriptSha256: source.sha256, outpostSha256: outpost.sha256, commonSha256: common.sha256, blenderVersion: source.blenderVersion });
    await writeFile(specPath, `${canonicalJson(spec)}\n`);
    const generated = await generateAsset(specPath);
    const observations = (generated.receipt.observations as Json).script as Json;
    const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, "settlement.glb")), kind: "mesh", mediaType: "model/gltf-binary" })).asset;
    const asset = single(await executeGltfProductionImportOperation(root, { inputs: { source: glb }, parameters: { policy: { allowedValidatorWarnings: [] } } }));
    built.push({ prop, asset, document: await io.readBinary(new Uint8Array(await resolveAssetObject(root, asset))), observations });
  }
  const of = (prop: SettlementProp) => built.find((b) => b.prop === prop)!;

  log("measure the settlement-props descriptor");
  const assets = SETTLEMENT_PROPS.map((prop) => {
    const { document, observations } = of(prop);
    const bounds = documentBounds(document);
    const entry: Json = {
      key: settlementKey(prop), role: prop, family: SETTLEMENT_FAMILY[prop], parentName: `settlement.${prop}`, triangles: triangles(document),
      footprint: { width: round(bounds.max[0] - bounds.min[0]), depth: round(bounds.max[2] - bounds.min[2]), height: round(bounds.max[1] - bounds.min[1]) },
      bounds, collisionProxies: observations.collisionProxies,
    };
    for (const extra of EXTRAS) if (observations[extra] !== undefined) entry[extra] = observations[extra];
    return entry;
  }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const descriptor = {
    schema: SETTLEMENT_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right", origin: "footprint-base-center",
    assets, compositions: of("stall").observations.compositions,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "settlement-descriptor", mediaType: "application/json" })).asset;

  log("export gltf-resources-v1 bundle (asset.bundle@4)");
  const bundleDir = path.join(root, "bundle");
  const selections = built.map((b) => ({
    key: settlementKey(b.prop), variant: SETTLEMENT_VARIANT,
    ...(b.prop === "stall" ? { attachments: [{ name: SETTLEMENT_DESCRIPTOR_ATTACHMENT }] } : {}),
  }));
  await exportAssetBundle(root, bundleDir, {
    parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections },
    inputs: { assets: built.map((b) => b.asset), attachments: [descriptorAsset] },
  });
  const tarPath = path.join(root, SETTLEMENT_TAR_NAME);
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
    documents: Object.fromEntries(built.map((b) => [b.prop, b.document])) as Record<SettlementProp, Document>,
    exportRef: JSON.parse(Buffer.from(refEntry.bytes).toString("utf8")) as Json, exportRefPath,
    lineage: {
      recipe: { script: "adapters/blender/settlement_props.py", sha256: source.sha256, outpost: { script: "adapters/blender/outpost.py", sha256: outpost.sha256 }, common: { script: "adapters/blender/kit_common.py", sha256: common.sha256 }, blenderVersion: source.blenderVersion },
      release: SETTLEMENT_RELEASE, props: Object.fromEntries(built.map((b) => [b.prop, b.asset])), descriptor: descriptorAsset,
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") {
    console.error("Usage: ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-settlement-props.ts --out <directory>");
    process.exit(2);
  }
  try {
    const result = await buildSettlementProps({ outDir: args[1]!, log: (line) => console.error(`[settlement] ${line}`) });
    await writeFile(path.join(path.resolve(args[1]!), "lineage.json"), `${JSON.stringify(result.lineage, null, 2)}\n`);
    await writeFile(path.join(path.resolve(args[1]!), "descriptor.json"), `${JSON.stringify(result.descriptor, null, 2)}\n`);
    console.log(JSON.stringify({ bundle: result.bundleDir, tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength, exportRef: result.exportRef }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}
