// Build the Greyhaven Outpost building kit bundle (#366, docs/outpost-kit.md): the hand-authored geometry
// assets/authored/outpost-kit.blend, dressed with the textures and wear of adapters/blender/outpost.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-outpost-kit.ts --out <directory>
// Each module variant (roofing and wear) is one external.blender.script@1 run, imported through
// scene.import.gltf@2. The outpost-kit-descriptor-v1 attachment combines the observations stored on the authored
// modules (proxies, openings, hinge, roof, chimney), the recipe's compositions and bounds measured on the
// imported GLBs. <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and
// packed to <directory>/outpost.kit.tar.
import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { Document } from "@gltf-transform/core";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec } from "../src/blender-script-spec.js";
import { readAuthoredBlenderSource, readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { buildKitPart, byKey, exportKitBundle, kitEntry, runKitCli, triangles, type KitPart } from "../src/kit-bundle.js";

export const OUTPOST_PARTS = [
  "wall", "wall-half", "wall-window", "wall-door", "door", "corner", "gable", "roof", "roof-half", "roof-verge", "chimney",
] as const;
export type OutpostPart = (typeof OUTPOST_PARTS)[number];
/** Roof modules also ship a `slate` variant; their `default` is shingle. */
export const OUTPOST_ROOF_PARTS: readonly OutpostPart[] = ["roof", "roof-half", "roof-verge"];
export const OUTPOST_ROOF_VARIANTS = { default: "shingle", slate: "slate" } as const;
/**
 * Every module also ships aged variants for remixing (the recipe takes any `wear` in [0, 1]): grime, greyed
 * timber, moss, plaster fallen to wattle and daub and missing shingles, all in the textures over the same
 * geometry. Roof modules combine them with slate as `slate-weathered` and `slate-worn`. The v1 descriptor
 * lists only the pristine roof variants.
 */
export const OUTPOST_WEAR_VARIANTS = { weathered: 0.5, worn: 1 } as const;
/** The kit's hand-authored geometry (Git LFS): one collection per module, edited in Blender. */
export const OUTPOST_GEOMETRY = "assets/authored/outpost-kit.blend";
export const OUTPOST_KEY_PREFIX = "outpost.kit";
export const OUTPOST_VARIANT = "default";
export const OUTPOST_DESCRIPTOR_SCHEMA = "outpost-kit-descriptor-v1";
export const OUTPOST_DESCRIPTOR_ATTACHMENT = "outpost-descriptor";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const OUTPOST_RELEASE = "outpost-kit";
export const OUTPOST_TAR_NAME = "outpost.kit.tar";
export const OUTPOST_GRID = {
  module: 2, halfModule: 1, wallHeight: 3.6, wallThickness: 0.32, plinthHeight: 0.5,
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

export const outpostKey = (part: OutpostPart) => `${OUTPOST_KEY_PREFIX}.${part}`;

export function createOutpostAssetSpec({ part, roof, wear, scriptSha256, commonSha256, kitSha256, blenderVersion }: {
  part: OutpostPart; roof?: "shingle" | "slate" | undefined; wear?: number | undefined; scriptSha256: string; commonSha256: string; kitSha256: string; blenderVersion: string;
}) {
  return blenderScriptSpec({
    assetId: outpostKey(part),
    inputs: { script: { path: "outpost.py", sha256: scriptSha256 }, common: { path: "kit_common.py", sha256: commonSha256 }, kit: { path: "outpost-kit.blend", sha256: kitSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, part, ...(roof ? { roof } : {}), ...(wear ? { wear } : {}) }, output: "outpost.glb",
  });
}

type Run = { part: OutpostPart; variant: string; roof?: "slate"; wear?: number };
type Built = KitPart & Run;

/** Every bundle variant of one module: pristine and aged, and for roof modules each also in slate. */
export function outpostRuns(part: OutpostPart): Run[] {
  const roofs: { prefix: string; roof?: "slate" }[] = [{ prefix: "" }, ...(OUTPOST_ROOF_PARTS.includes(part) ? [{ prefix: "slate", roof: "slate" as const }] : [])];
  return roofs.flatMap(({ prefix, roof }) => [
    { part, variant: prefix || OUTPOST_VARIANT, ...(roof ? { roof } : {}) },
    ...Object.entries(OUTPOST_WEAR_VARIANTS).map(([name, wear]) => ({ part, variant: prefix ? `${prefix}-${name}` : name, ...(roof ? { roof } : {}), wear })),
  ]);
}

export async function buildOutpostKit({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("outpost.py");
  const common = await readBlenderRecipeSource("kit_common.py");
  const kit = await readAuthoredBlenderSource(OUTPOST_GEOMETRY);
  const runs = OUTPOST_PARTS.flatMap(outpostRuns);
  const built: Built[] = [];
  for (const run of runs) {
    log(`generate ${run.part} ${run.variant} (external.blender.script@1 outpost recipe, scene.import.gltf@2)`);
    built.push({ ...run, ...await buildKitPart(root, {
      workspace: path.join(root, "outpost", `${run.part}.${run.variant}`),
      files: { "outpost.py": source.bytes, "kit_common.py": common.bytes, "outpost-kit.blend": kit.bytes },
      spec: createOutpostAssetSpec({ part: run.part, roof: run.roof, wear: run.wear, scriptSha256: source.sha256, commonSha256: common.sha256, kitSha256: kit.sha256, blenderVersion: source.blenderVersion }),
    }) });
  }
  const main = (part: OutpostPart) => built.find((b) => b.part === part && b.variant === OUTPOST_VARIANT)!;

  log("measure the outpost-kit descriptor");
  const assets = OUTPOST_PARTS.map((part) => {
    const entry = kitEntry({ key: outpostKey(part), role: part, fields: { category: CATEGORY[part], parentName: `outpost.${part}` }, extras: EXTRAS, ...main(part) });
    if (OUTPOST_ROOF_PARTS.includes(part)) {
      entry.variants = built.filter((b) => b.part === part && !b.wear).map((b) => ({ variant: b.variant, material: b.observations.roofMaterial, triangles: triangles(b.document) }));
    }
    return entry;
  }).sort(byKey);
  const descriptor = {
    schema: OUTPOST_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right", origin: "module-anchor",
    grid: OUTPOST_GRID, assets, compositions: main("wall").observations.compositions,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "outpost-descriptor", mediaType: "application/json" })).asset;

  const selections = built.map((b) => ({
    key: outpostKey(b.part), variant: b.variant,
    ...(b.part === "wall" && b.variant === OUTPOST_VARIANT ? { attachments: [{ name: OUTPOST_DESCRIPTOR_ATTACHMENT }] } : {}),
  }));
  const packed = await exportKitBundle(root, {
    tarName: OUTPOST_TAR_NAME, log,
    invocation: {
      parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections },
      inputs: { assets: built.map((b) => b.asset), attachments: [descriptorAsset] },
    },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(OUTPOST_PARTS.map((part) => [part, main(part).document])) as Record<OutpostPart, Document>,
    lineage: {
      recipe: {
        script: "adapters/blender/outpost.py", sha256: source.sha256, common: { script: "adapters/blender/kit_common.py", sha256: common.sha256 },
        geometry: { file: OUTPOST_GEOMETRY, sha256: kit.sha256 }, blenderVersion: source.blenderVersion,
      },
      release: OUTPOST_RELEASE,
      parts: Object.fromEntries(built.map((b) => [`${b.part}.${b.variant}`, b.asset])), descriptor: descriptorAsset,
    },
  };
}

if (import.meta.main) await runKitCli("scripts/build-outpost-kit.ts", "outpost", buildOutpostKit, { descriptorFile: true });
