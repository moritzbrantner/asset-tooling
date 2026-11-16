// Build the Greyhaven settlement prop bundle (#369, docs/settlement-props.md) from the scripted Blender recipe
// adapters/blender/settlement_props.py, which reuses the Outpost kit recipe (adapters/blender/outpost.py)
// as its declared Python input `outpost`:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-settlement-props.ts --out <directory>
// Each prop is one external.blender.script@1 run, imported through scene.import.gltf@2. The
// settlement-props-descriptor-v1 attachment combines the recipe's observations (proxies, nodes, composition)
// with bounds measured on the imported GLBs. <directory> becomes the object-store root; the bundle is exported
// to <directory>/bundle and packed to <directory>/settlement.props.tar.
import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { Document } from "@gltf-transform/core";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec } from "../src/blender-script-spec.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { buildKitPart, byKey, exportKitBundle, ktx2Assets, kitEntry, runKitCli, type KitPart } from "../src/kit-bundle.js";

export const SETTLEMENT_PROPS = [
  "stall", "cart", "crate", "barrel", "signpost", "lantern-post", "bench", "fence", "planter", "firewood", "footbridge",
  "bed", "table", "chair", "chest", "hearth",
  "barrel-group", "crate-stack", "grain-sacks", "wheelbarrow", "well", "fingerpost", "hay-bale", "haystack",
  "chopping-block", "washing-line", "flower-tub", "vegetable-bed", "kennel",
  "dresser", "settle", "rug", "cooking-pot", "jar-shelf", "spinning-wheel", "cradle", "hall-table",
  "shrine", "standing-stone", "watchtower-ruin", "bridge-railing", "stall-awning",
  "bread-basket", "cheese-board", "fish-crate", "apple-crate", "hanging-meats", "cask-rack", "merchant-scale", "cloth-bolts",
  "pottery", "anvil", "grindstone", "cooper-barrel",
  "table-set", "candles", "candelabra", "inn-sign", "stool", "bar-counter", "log-stack", "wall-shield", "wall-trophy",
  "rowing-boat", "jetty", "fishing-nets",
  "banner-outpost", "banner-village", "pennant-outpost", "pennant-village", "bunting",
  "scarecrow", "weather-vane", "beehive-skeps", "water-trough", "feed-trough", "hen-coop", "plough",
] as const;
export type SettlementProp = (typeof SETTLEMENT_PROPS)[number];
export type SettlementFamily = "market" | "street" | "dressing";
/** mmorpg#421's three families: work/market props, street furniture and architectural dressing; cottage furniture (mmorpg#843) is dressing. */
export const SETTLEMENT_FAMILY: Record<SettlementProp, SettlementFamily> = {
  stall: "market", cart: "market", crate: "market", barrel: "market",
  signpost: "street", "lantern-post": "street", bench: "street",
  fence: "dressing", planter: "dressing", firewood: "dressing", footbridge: "street",
  bed: "dressing", table: "dressing", chair: "dressing", chest: "dressing", hearth: "dressing",
  "barrel-group": "market", "crate-stack": "market", "grain-sacks": "market", wheelbarrow: "market",
  well: "street", fingerpost: "street", "hay-bale": "dressing", haystack: "dressing", "chopping-block": "dressing",
  "washing-line": "dressing", "flower-tub": "dressing", "vegetable-bed": "dressing", kennel: "dressing",
  dresser: "dressing", settle: "dressing", rug: "dressing", "cooking-pot": "dressing", "jar-shelf": "dressing",
  "spinning-wheel": "dressing", cradle: "dressing", "hall-table": "dressing",
  shrine: "street", "standing-stone": "street", "watchtower-ruin": "street", "bridge-railing": "street", "stall-awning": "market",
  "bread-basket": "market", "cheese-board": "market", "fish-crate": "market", "apple-crate": "market", "hanging-meats": "market",
  "cask-rack": "market", "merchant-scale": "market", "cloth-bolts": "market", pottery: "market",
  anvil: "dressing", grindstone: "dressing", "cooper-barrel": "dressing",
  "table-set": "dressing", candles: "dressing", candelabra: "dressing", "inn-sign": "street", stool: "dressing",
  "bar-counter": "dressing", "log-stack": "dressing", "wall-shield": "dressing", "wall-trophy": "dressing",
  "rowing-boat": "dressing", jetty: "street", "fishing-nets": "dressing",
  "banner-outpost": "street", "banner-village": "street", "pennant-outpost": "street", "pennant-village": "street", bunting: "street",
  scarecrow: "dressing", "weather-vane": "dressing", "beehive-skeps": "dressing", "water-trough": "dressing", "feed-trough": "dressing",
  "hen-coop": "dressing", plough: "dressing",
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
  fence: 250, planter: 600, firewood: 1200, footbridge: 2400,
  bed: 500, table: 700, chair: 250, chest: 250, hearth: 900,
  "barrel-group": 900, "crate-stack": 750, "grain-sacks": 650, wheelbarrow: 600, well: 900, fingerpost: 350,
  "hay-bale": 200, haystack: 400, "chopping-block": 600, "washing-line": 400, "flower-tub": 700, "vegetable-bed": 650,
  kennel: 400, dresser: 850, settle: 400, rug: 350, "cooking-pot": 800, "jar-shelf": 900, "spinning-wheel": 600,
  cradle: 350, "hall-table": 900,
  shrine: 700, "standing-stone": 500, "watchtower-ruin": 700, "bridge-railing": 200, "stall-awning": 1200,
  "bread-basket": 500, "cheese-board": 350, "fish-crate": 1000, "apple-crate": 700, "hanging-meats": 750, "cask-rack": 1300,
  "merchant-scale": 550, "cloth-bolts": 700, pottery: 900, anvil: 400, grindstone: 600, "cooper-barrel": 500,
  "table-set": 1100, candles: 300, candelabra: 550, "inn-sign": 300, stool: 250, "bar-counter": 1000, "log-stack": 450,
  "wall-shield": 400, "wall-trophy": 400,
  "rowing-boat": 1000, jetty: 700, "fishing-nets": 1500,
  "banner-outpost": 550, "banner-village": 550, "pennant-outpost": 300, "pennant-village": 300, bunting: 700,
  scarecrow: 1000, "weather-vane": 800, "beehive-skeps": 1000, "water-trough": 350, "feed-trough": 250, "hen-coop": 550, plough: 750,
};
/** The named node-animation loops (#695), in seconds. They live in the props' glTF and the bundle manifest's observations; the
 * published descriptor schema keeps its fields. */
export const SETTLEMENT_CLIPS: Partial<Record<SettlementProp, Record<string, number>>> = { scarecrow: { Sway_Loop: 4 }, "weather-vane": { Turn_Loop: 8 } };
/** Recipe observations copied into the descriptor when a prop declares them. */
const EXTRAS = ["stackTop", "sign", "light", "seat", "module"] as const;

export const settlementKey = (prop: SettlementProp) => `${SETTLEMENT_KEY_PREFIX}.${prop}`;

export function createSettlementAssetSpec({ prop, scriptSha256, outpostSha256, commonSha256, blenderVersion }: { prop: SettlementProp; scriptSha256: string; outpostSha256: string; commonSha256: string; blenderVersion: string }) {
  return blenderScriptSpec({
    assetId: settlementKey(prop),
    inputs: { script: { path: "settlement_props.py", sha256: scriptSha256 }, outpost: { path: "outpost.py", sha256: outpostSha256 }, common: { path: "kit_common.py", sha256: commonSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, prop }, output: "settlement.glb",
  });
}

type Built = KitPart & { prop: SettlementProp };

export async function buildSettlementProps({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("settlement_props.py");
  const outpost = await readBlenderRecipeSource("outpost.py");
  const common = await readBlenderRecipeSource("kit_common.py");
  const built: Built[] = [];
  for (const prop of SETTLEMENT_PROPS) {
    log(`generate ${prop} (external.blender.script@1 settlement recipe, scene.import.gltf@2)`);
    built.push({ prop, ...await buildKitPart(root, {
      workspace: path.join(root, "settlement", prop),
      files: { "settlement_props.py": source.bytes, "outpost.py": outpost.bytes, "kit_common.py": common.bytes },
      spec: createSettlementAssetSpec({ prop, scriptSha256: source.sha256, outpostSha256: outpost.sha256, commonSha256: common.sha256, blenderVersion: source.blenderVersion }),
    }) });
  }
  const of = (prop: SettlementProp) => built.find((b) => b.prop === prop)!;

  log("measure the settlement-props descriptor");
  const assets = SETTLEMENT_PROPS.map((prop) => kitEntry({
    key: settlementKey(prop), role: prop, fields: { family: SETTLEMENT_FAMILY[prop], parentName: `settlement.${prop}` }, extras: EXTRAS, ...of(prop),
  })).sort(byKey);
  const descriptor = {
    schema: SETTLEMENT_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right", origin: "footprint-base-center",
    assets, compositions: of("stall").observations.compositions,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "settlement-descriptor", mediaType: "application/json" })).asset;

  const selections = built.map((b) => ({
    key: settlementKey(b.prop), variant: SETTLEMENT_VARIANT,
    ...(b.prop === "stall" ? { attachments: [{ name: SETTLEMENT_DESCRIPTOR_ATTACHMENT }] } : {}),
  }));
  const packed = await exportKitBundle(root, {
    tarName: SETTLEMENT_TAR_NAME, log,
    invocation: {
      parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections },
      inputs: { assets: await ktx2Assets(root, "settlement-props", built.map((b) => b.asset)), attachments: [descriptorAsset] },
    },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(built.map((b) => [b.prop, b.document])) as Record<SettlementProp, Document>,
    lineage: {
      recipe: { script: "adapters/blender/settlement_props.py", sha256: source.sha256, outpost: { script: "adapters/blender/outpost.py", sha256: outpost.sha256 }, common: { script: "adapters/blender/kit_common.py", sha256: common.sha256 }, blenderVersion: source.blenderVersion },
      release: SETTLEMENT_RELEASE, props: Object.fromEntries(built.map((b) => [b.prop, b.asset])), descriptor: descriptorAsset,
    },
  };
}

if (import.meta.main) await runKitCli("scripts/build-settlement-props.ts", "settlement", buildSettlementProps, { descriptorFile: true });
