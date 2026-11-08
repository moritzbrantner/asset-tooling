// Build the red sandstone building kit bundle for mmorpg (docs/sandstone-kit.md): the hand-authored geometry
// assets/authored/sandstone-kit.blend, dressed with the textures of adapters/blender/sandstone.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-sandstone-kit.ts [--atlas 2048|1024] --out <directory>
// Each module is one external.blender.script@1 run, imported through scene.import.gltf@2; every texture then ships as
// KTX2. The sandstone-kit-descriptor-v1 attachment combines the observations stored on the authored modules, the
// recipe's compositions and bounds measured on the imported GLBs. <directory> becomes the object-store root; the
// bundle is exported to <directory>/bundle and packed to <directory>/sandstone.kit.tar.
import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { Document } from "@gltf-transform/core";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec } from "../src/blender-script-spec.js";
import { readAuthoredBlenderSource, readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { buildKitPart, byKey, exportKitBundle, kitEntry, ktx2Assets, runKitCli, type KitPart } from "../src/kit-bundle.js";

export const SANDSTONE_PARTS = [
  "wall", "wall-half", "wall-window", "wall-door", "door", "corner", "gable-6", "gable-8", "roof-6", "roof-6-half", "roof-8", "roof-8-half", "chimney",
] as const;
export type SandstonePart = (typeof SANDSTONE_PARTS)[number];
/** The kit's hand-authored geometry (Git LFS): one collection per module, edited in Blender. */
export const SANDSTONE_GEOMETRY = "assets/authored/sandstone-kit.blend";
export const SANDSTONE_KEY_PREFIX = "sandstone.kit";
export const SANDSTONE_VARIANT = "default";
export const SANDSTONE_DESCRIPTOR_SCHEMA = "sandstone-kit-descriptor-v1";
export const SANDSTONE_DESCRIPTOR_ATTACHMENT = "sandstone-descriptor";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const SANDSTONE_RELEASE = "sandstone-kit";
export const SANDSTONE_TAR_NAME = "sandstone.kit.tar";
export const SANDSTONE_GRID = {
  module: 2, halfModule: 1, wallHeight: 4, wallThickness: 0.5, plinthHeight: 0.55, spans: [6, 8], pitchDegrees: 42, eaveOverhang: 0.22,
} as const;
/** Triangle ceilings per module, for the Greyhaven camera (12 m, 0.42 rad pitch, 50 degree fov). */
export const SANDSTONE_TRIANGLE_BUDGET: Record<SandstonePart, number> = {
  wall: 60, "wall-half": 60, "wall-window": 400, "wall-door": 400, door: 200, corner: 250, "gable-6": 300, "gable-8": 400,
  "roof-6": 60, "roof-6-half": 60, "roof-8": 60, "roof-8-half": 60, chimney: 60,
};
const CATEGORY: Record<SandstonePart, "wall" | "door" | "corner" | "roof" | "chimney"> = {
  wall: "wall", "wall-half": "wall", "wall-window": "wall", "wall-door": "wall", door: "door", corner: "corner", "gable-6": "wall", "gable-8": "wall",
  "roof-6": "roof", "roof-6-half": "roof", "roof-8": "roof", "roof-8-half": "roof", chimney: "chimney",
};
/** Recipe observations copied into the descriptor when a module declares them. */
const EXTRAS = ["module", "window", "doorway", "mount", "hinge", "leafBounds", "roof", "span", "gable", "smoke"] as const;

export const sandstoneKey = (part: SandstonePart) => `${SANDSTONE_KEY_PREFIX}.${part}`;

/** The atlas resolutions (ATLAS_MODES in adapters/blender/sandstone.py); the release ships the default. */
export const SANDSTONE_ATLAS_MODES = ["2048", "1024"] as const;
export type SandstoneAtlas = (typeof SANDSTONE_ATLAS_MODES)[number];
export const SANDSTONE_DEFAULT_ATLAS: SandstoneAtlas = "2048";

export function createSandstoneAssetSpec({ part, atlas = SANDSTONE_DEFAULT_ATLAS, scriptSha256, outpostSha256, commonSha256, kitSha256, blenderVersion }: {
  part: SandstonePart; atlas?: SandstoneAtlas; scriptSha256: string; outpostSha256: string; commonSha256: string; kitSha256: string; blenderVersion: string;
}) {
  return blenderScriptSpec({
    assetId: sandstoneKey(part),
    inputs: {
      script: { path: "sandstone.py", sha256: scriptSha256 }, outpost: { path: "outpost.py", sha256: outpostSha256 },
      common: { path: "kit_common.py", sha256: commonSha256 }, kit: { path: "sandstone-kit.blend", sha256: kitSha256 },
    },
    blenderVersion, arguments: { schemaVersion: 1, part, ...(atlas === SANDSTONE_DEFAULT_ATLAS ? {} : { atlas }) }, output: "sandstone.glb",
  });
}

export async function buildSandstoneKit({ outDir, atlas = SANDSTONE_DEFAULT_ATLAS, log = () => {} }: { outDir: string; atlas?: SandstoneAtlas; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("sandstone.py");
  const outpost = await readBlenderRecipeSource("outpost.py");
  const common = await readBlenderRecipeSource("kit_common.py");
  const kit = await readAuthoredBlenderSource(SANDSTONE_GEOMETRY);
  const parts = {} as Record<SandstonePart, KitPart>;
  for (const part of SANDSTONE_PARTS) {
    log(`generate ${part} (external.blender.script@1 sandstone recipe, scene.import.gltf@2)`);
    parts[part] = await buildKitPart(root, {
      workspace: path.join(root, "sandstone", part),
      files: { "sandstone.py": source.bytes, "outpost.py": outpost.bytes, "kit_common.py": common.bytes, "sandstone-kit.blend": kit.bytes },
      spec: createSandstoneAssetSpec({ part, atlas, scriptSha256: source.sha256, outpostSha256: outpost.sha256, commonSha256: common.sha256, kitSha256: kit.sha256, blenderVersion: source.blenderVersion }),
    });
  }

  log("measure the sandstone-kit descriptor");
  const assets = SANDSTONE_PARTS.map((part) => kitEntry({
    key: sandstoneKey(part), role: part, fields: { category: CATEGORY[part], parentName: `sandstone.${part}` }, extras: EXTRAS, ...parts[part],
  })).sort(byKey);
  const descriptor = {
    schema: SANDSTONE_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right", origin: "module-anchor",
    grid: SANDSTONE_GRID, atlas: Number(atlas), assets, compositions: parts.wall.observations.compositions,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "sandstone-descriptor", mediaType: "application/json" })).asset;

  log("encode every texture as KTX2 (ktx create)");
  const delivered = await ktx2Assets(root, "sandstone-kit", SANDSTONE_PARTS.map((part) => parts[part].asset));
  const selections = SANDSTONE_PARTS.map((part) => ({
    key: sandstoneKey(part), variant: SANDSTONE_VARIANT, ...(part === "wall" ? { attachments: [{ name: SANDSTONE_DESCRIPTOR_ATTACHMENT }] } : {}),
  }));
  const packed = await exportKitBundle(root, {
    tarName: SANDSTONE_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(SANDSTONE_PARTS.map((part) => [part, parts[part].document])) as Record<SandstonePart, Document>,
    lineage: {
      recipe: {
        script: "adapters/blender/sandstone.py", sha256: source.sha256, outpost: { script: "adapters/blender/outpost.py", sha256: outpost.sha256 },
        common: { script: "adapters/blender/kit_common.py", sha256: common.sha256 }, geometry: { file: SANDSTONE_GEOMETRY, sha256: kit.sha256 }, blenderVersion: source.blenderVersion,
      },
      release: SANDSTONE_RELEASE,
      parts: Object.fromEntries(SANDSTONE_PARTS.map((part, i) => [part, delivered[i]!])),
      descriptor: descriptorAsset,
    },
  };
}

if (import.meta.main) {
  // `--atlas <mode>` is this kit's own option; the shared command line takes only `--out`.
  const at = process.argv.indexOf("--atlas");
  const atlas = (at < 0 ? SANDSTONE_DEFAULT_ATLAS : process.argv.splice(at, 2)[1]) as SandstoneAtlas;
  if (!SANDSTONE_ATLAS_MODES.includes(atlas)) {
    console.error(`--atlas must be one of ${SANDSTONE_ATLAS_MODES.join(", ")}`);
    process.exit(2);
  }
  await runKitCli("scripts/build-sandstone-kit.ts", "sandstone", (options) => buildSandstoneKit({ ...options, atlas }), { descriptorFile: true });
}
