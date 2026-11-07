// Build the Greyhaven Outpost building kit bundle (#366, docs/outpost-kit.md): the hand-authored geometry
// assets/authored/outpost-kit.blend, dressed with the textures and wear of adapters/blender/outpost.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-outpost-kit.ts --out <directory>
// Each module variant (roofing) and the wear masks are one external.blender.script@1 run each, imported through
// scene.import.gltf@2; every texture then ships as KTX2 (Basis Universal), encoded by KTX-Software's `ktx` CLI
// (ASSET_TOOLING_KTX, or `ktx` on PATH). The outpost-kit-descriptor-v1 attachment combines the observations stored
// on the authored modules (proxies, openings, hinge, roof, chimney), the recipe's compositions and bounds measured
// on the imported GLBs. <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and
// packed to <directory>/outpost.kit.tar.
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { NodeIO, type Document, type Texture } from "@gltf-transform/core";
import { KHRTextureBasisu } from "@gltf-transform/extensions";
import { ktxArguments, textureEncoding, type TextureEncoding } from "./pack-downloads.ts";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import type { AssetRef } from "../src/operations.js";
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
 * Wear ships as data, not as baked variants: the `outpost.kit.wear-masks` entry holds one mask per texture
 * (plaster, wood, stone, shingle, slate) as the base colour of material `outpost-wear-<texture>`, which a consumer's
 * shader blends over the pristine maps at any wear in [0, 1] (docs/outpost-kit.md#wear-masks). Every wear level then
 * shares one material. The recipe still bakes any `wear` for a live Blender session.
 */
export const OUTPOST_WEAR_MASKS = "wear-masks";
export const OUTPOST_WEAR_TEXTURES = ["plaster", "wood", "stone", "shingle", "slate"] as const;
/**
 * The KTX2 encoding per texture slot, each with a full mip chain (`ktxArguments`, scripts/pack-downloads.ts): colour
 * ETC1S sRGB, ORM ETC1S linear, normals UASTC; the wear masks UASTC linear, since their channels are thresholds that
 * ETC1S's shared endpoints would smear into one another.
 */
export const OUTPOST_KTX2 = { wearMask: "uastc" } as const satisfies Record<string, TextureEncoding>;
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
  part: OutpostPart | typeof OUTPOST_WEAR_MASKS; roof?: "shingle" | "slate" | undefined; wear?: number | undefined; scriptSha256: string; commonSha256: string; kitSha256: string; blenderVersion: string;
}) {
  return blenderScriptSpec({
    assetId: `${OUTPOST_KEY_PREFIX}.${part}`,
    inputs: { script: { path: "outpost.py", sha256: scriptSha256 }, common: { path: "kit_common.py", sha256: commonSha256 }, kit: { path: "outpost-kit.blend", sha256: kitSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, part, ...(roof ? { roof } : {}), ...(wear ? { wear } : {}) }, output: "outpost.glb",
  });
}

type Run = { part: OutpostPart; variant: string; roof?: "slate" };
type Built = KitPart & Run;

/** Every bundle variant of one module: the default, and for roof modules also slate. */
export function outpostRuns(part: OutpostPart): Run[] {
  return [{ part, variant: OUTPOST_VARIANT }, ...(OUTPOST_ROOF_PARTS.includes(part) ? [{ part, variant: "slate", roof: "slate" as const }] : [])];
}

/** The KTX2 encoding of a texture by the slots that use it; the wear masks' base colour is data. */
function outpostEncoding(slots: ReadonlySet<string>, wearMask: boolean): TextureEncoding {
  return wearMask ? OUTPOST_KTX2.wearMask : textureEncoding(slots);
}

/**
 * `asset` with every texture as KTX2 (KHR_texture_basisu, required): each distinct image and encoding is encoded
 * once across the kit (`encoded`), so the bundle still stores every texture once.
 */
async function ktx2Asset(root: string, asset: AssetRef, scratch: string, encoded: Map<string, Uint8Array>, wearMask = false): Promise<AssetRef> {
  const io = new NodeIO().registerExtensions([KHRTextureBasisu]);
  const document = await io.readBinary(new Uint8Array(await resolveAssetObject(root, asset)));
  const slots = new Map<Texture, Set<string>>();
  for (const material of document.getRoot().listMaterials()) {
    for (const [slot, texture] of [
      ["baseColorTexture", material.getBaseColorTexture()], ["normalTexture", material.getNormalTexture()],
      ["metallicRoughnessTexture", material.getMetallicRoughnessTexture()], ["occlusionTexture", material.getOcclusionTexture()],
      ["emissiveTexture", material.getEmissiveTexture()],
    ] as const) {
      if (texture) slots.set(texture, (slots.get(texture) ?? new Set()).add(slot));
    }
  }
  for (const [texture, used] of slots) {
    if (texture.getMimeType() !== "image/png") throw new Error(`outpost texture '${texture.getName()}' is ${texture.getMimeType()}, not PNG`);
    const encoding = outpostEncoding(used, wearMask);
    const png = texture.getImage()!;
    const key = `${createHash("sha256").update(png).digest("hex")}:${encoding}`;
    let ktx2 = encoded.get(key);
    if (!ktx2) {
      const input = path.join(scratch, `${encoded.size}.png`), output = path.join(scratch, `${encoded.size}.ktx2`);
      await writeFile(input, png);
      const run = Bun.spawnSync([process.env.ASSET_TOOLING_KTX ?? "ktx", ...ktxArguments(encoding, input, output)], { stdout: "pipe", stderr: "pipe" });
      if (run.exitCode !== 0) throw new Error(`ktx create failed for ${texture.getName()}: ${run.stderr.toString()}`);
      ktx2 = new Uint8Array(await readFile(output));
      encoded.set(key, ktx2);
    }
    texture.setImage(ktx2).setMimeType("image/ktx2");
  }
  document.createExtension(KHRTextureBasisu).setRequired(true);
  return (await storeAssetObject(root, { bytes: await io.writeBinary(document), kind: asset.kind, mediaType: "model/gltf-binary" })).asset;
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
      spec: createOutpostAssetSpec({ part: run.part, roof: run.roof, scriptSha256: source.sha256, commonSha256: common.sha256, kitSha256: kit.sha256, blenderVersion: source.blenderVersion }),
    }) });
  }
  log(`generate ${OUTPOST_WEAR_MASKS} (external.blender.script@1 outpost recipe, scene.import.gltf@2)`);
  const masks = await buildKitPart(root, {
    workspace: path.join(root, "outpost", OUTPOST_WEAR_MASKS),
    files: { "outpost.py": source.bytes, "kit_common.py": common.bytes, "outpost-kit.blend": kit.bytes },
    spec: createOutpostAssetSpec({ part: OUTPOST_WEAR_MASKS, scriptSha256: source.sha256, commonSha256: common.sha256, kitSha256: kit.sha256, blenderVersion: source.blenderVersion }),
  });

  log("encode every texture as KTX2 (ktx create)");
  const scratch = await mkdtemp(path.join(os.tmpdir(), "outpost-kit-"));
  const encoded = new Map<string, Uint8Array>();
  const delivered: AssetRef[] = [];
  let maskAsset: AssetRef;
  try {
    for (const b of built) delivered.push(await ktx2Asset(root, b.asset, scratch, encoded));
    maskAsset = await ktx2Asset(root, masks.asset, scratch, encoded, true);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const main = (part: OutpostPart) => built.find((b) => b.part === part && b.variant === OUTPOST_VARIANT)!;

  log("measure the outpost-kit descriptor");
  const assets = OUTPOST_PARTS.map((part) => {
    const entry = kitEntry({ key: outpostKey(part), role: part, fields: { category: CATEGORY[part], parentName: `outpost.${part}` }, extras: EXTRAS, ...main(part) });
    if (OUTPOST_ROOF_PARTS.includes(part)) {
      entry.variants = built.filter((b) => b.part === part).map((b) => ({ variant: b.variant, material: b.observations.roofMaterial, triangles: triangles(b.document) }));
    }
    return entry;
  }).sort(byKey);
  const descriptor = {
    schema: OUTPOST_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right", origin: "module-anchor",
    grid: OUTPOST_GRID, assets, compositions: main("wall").observations.compositions,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "outpost-descriptor", mediaType: "application/json" })).asset;

  const selections = [...built.map((b) => ({
    key: outpostKey(b.part), variant: b.variant,
    ...(b.part === "wall" && b.variant === OUTPOST_VARIANT ? { attachments: [{ name: OUTPOST_DESCRIPTOR_ATTACHMENT }] } : {}),
  })), { key: `${OUTPOST_KEY_PREFIX}.${OUTPOST_WEAR_MASKS}`, variant: OUTPOST_VARIANT }];
  const packed = await exportKitBundle(root, {
    tarName: OUTPOST_TAR_NAME, log,
    invocation: {
      parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections },
      inputs: { assets: [...delivered, maskAsset], attachments: [descriptorAsset] },
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
      parts: Object.fromEntries([...built.map((b, i) => [`${b.part}.${b.variant}`, delivered[i]!] as const), [OUTPOST_WEAR_MASKS, maskAsset] as const]),
      descriptor: descriptorAsset,
    },
  };
}

if (import.meta.main) await runKitCli("scripts/build-outpost-kit.ts", "outpost", buildOutpostKit, { descriptorFile: true });
