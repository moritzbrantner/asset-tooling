// Build Zoo's baked particle flipbooks (#136 slice 1, docs/zoo-effects.md) from the deterministic 2D recipe in
// src/zoo-effect-flipbooks.ts:
//   bun scripts/build-zoo-effects.ts --out <directory>
// Each effect is one 256×256 atlas PNG (4×4 cells of 64 px, 16 frames). The PNGs are exported as the
// static-glb-png-v1 package (the zoo-scenery format), packed to <directory>/zoo-effects.tar (+ .sha256), next to
// the zoo-effects-descriptor-v1 (<directory>/zoo-effects.descriptor.json) carrying each atlas layout and its
// BurstPresets, lineage.json, export.ref.json and review boards under <directory>/review/.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { STATIC_ASSET_BUNDLE_PROFILE, exportAssetBundle } from "../src/asset-bundle.js";
import { ASSET_BUNDLE_REF_FILE, readAssetBundleTar } from "../src/asset-bundle-pack.js";
import { storeAssetObject } from "../src/asset-store.js";
import { sha256Bytes } from "../src/hash.js";
import { canonicalJson } from "../src/canonical.js";
import type { AssetRef } from "../src/operations.js";
import {
  ZOO_EFFECT_KINDS, ZOO_EFFECT_LAYOUT, ZOO_EFFECT_RECIPES, burstPresetErrors, encodeRgbaPng, rasterizeZooEffectAtlas, transparentRgb,
  type ZooEffectKind,
} from "../src/zoo-effect-flipbooks.ts";

type Json = Record<string, any>;
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const RECIPE_SOURCE = "src/zoo-effect-flipbooks.ts";

export const ZOO_EFFECTS_DESCRIPTOR_SCHEMA = "zoo-effects-descriptor-v1";
export const ZOO_EFFECTS_DESCRIPTOR_FILE = "zoo-effects.descriptor.json";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const ZOO_EFFECTS_RELEASE = "zoo-effects";
export const ZOO_EFFECTS_TAR_NAME = "zoo-effects.tar";
export const ZOO_EFFECT_VARIANT = "toy";
export const zooEffectKey = (kind: ZooEffectKind) => `${kind}.flipbook`;

/** Each atlas framed on a checkerboard, a light and a dark background, at 2× (nearest), as one review PNG. */
export function reviewBoard(atlas: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  const { width: w, height: h } = ZOO_EFFECT_LAYOUT, zoom = 2, gap = 8;
  const backgrounds = [(x: number, y: number) => ((x >> 3) + (y >> 3)) % 2 ? [205, 205, 205] : [250, 250, 250], () => [126, 187, 90], () => [38, 44, 52]];
  const width = backgrounds.length * (w * zoom + gap) + gap, height = h * zoom + 2 * gap;
  const pixels = new Uint8Array(width * height * 4).fill(255);
  backgrounds.forEach((bg, panel) => {
    const ox = gap + panel * (w * zoom + gap);
    for (let y = 0; y < h * zoom; y += 1) for (let x = 0; x < w * zoom; x += 1) {
      const s = ((y / zoom | 0) * w + (x / zoom | 0)) * 4, a = atlas[s + 3]! / 255, b = bg(x, y);
      // Cell borders every 64 px so frame order is readable.
      const border = (x / zoom) % ZOO_EFFECT_LAYOUT.cell === 0 || (y / zoom) % ZOO_EFFECT_LAYOUT.cell === 0;
      const rgb = border ? [255, 80, 160] : [0, 1, 2].map((c) => Math.round(atlas[s + c]! * a + b[c]! * (1 - a)));
      pixels.set([...rgb, 255], ((gap + y) * width + ox + x) * 4);
    }
  });
  return { width, height, pixels };
}

export async function buildZooEffects({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(path.join(root, "review"), { recursive: true });
  const recipeBytes = await readFile(path.join(REPOSITORY_ROOT, RECIPE_SOURCE));
  const parts = new Map<ZooEffectKind, { asset: AssetRef; png: Buffer }>();
  for (const kind of ZOO_EFFECT_KINDS) {
    for (const [name, preset] of Object.entries(ZOO_EFFECT_RECIPES[kind].presets)) {
      const errors = burstPresetErrors(preset);
      if (errors.length) throw new Error(`${kind}/${name} preset: ${errors.join("; ")}`);
    }
    log(`bake ${kind} flipbook (${ZOO_EFFECT_LAYOUT.columns}×${ZOO_EFFECT_LAYOUT.rows}, ${ZOO_EFFECT_LAYOUT.frameCount} frames)`);
    const atlas = rasterizeZooEffectAtlas(kind);
    const png = encodeRgbaPng(ZOO_EFFECT_LAYOUT.width, ZOO_EFFECT_LAYOUT.height, atlas);
    await writeFile(path.join(root, `${kind}.png`), png);
    const board = reviewBoard(atlas);
    await writeFile(path.join(root, "review", `${kind}.png`), encodeRgbaPng(board.width, board.height, board.pixels));
    parts.set(kind, { asset: (await storeAssetObject(root, { bytes: png, kind: "image", mediaType: "image/png" })).asset, png });
  }

  log("write the zoo-effects descriptor");
  const { cell, columns, rows, frameCount, width, height, filter } = ZOO_EFFECT_LAYOUT;
  const descriptor = {
    schema: ZOO_EFFECTS_DESCRIPTOR_SCHEMA, units: { time: "second", distance: "metre" }, up: "+Y", renderer: "three-d-renderer frame.effects.bursts",
    effects: ZOO_EFFECT_KINDS.map((kind) => {
      const recipe = ZOO_EFFECT_RECIPES[kind], { png } = parts.get(kind)!;
      return {
        key: zooEffectKey(kind), variant: ZOO_EFFECT_VARIANT, role: kind, description: recipe.description,
        atlas: { width, height, columns, rows, frameCount, filter, cell, colorSpace: "srgb", alpha: "straight", rowOrder: "top-first", transparentRgb: [...transparentRgb(kind)] },
        png: { sha256: sha256Bytes(png), byteLength: png.length },
        scale: recipe.scale, presets: recipe.presets,
      };
    }),
  };
  const descriptorPath = path.join(root, ZOO_EFFECTS_DESCRIPTOR_FILE);
  await writeFile(descriptorPath, `${canonicalJson(descriptor)}\n`);

  log("export static-glb-png-v1 package (asset.bundle@1)");
  const bundleDir = path.join(root, "bundle");
  const kinds = [...ZOO_EFFECT_KINDS].sort((a, b) => zooEffectKey(a).localeCompare(zooEffectKey(b)));
  await exportAssetBundle(root, bundleDir, {
    parameters: { profile: STATIC_ASSET_BUNDLE_PROFILE, assets: kinds.map((kind) => ({ key: zooEffectKey(kind), variant: ZOO_EFFECT_VARIANT })) },
    inputs: { assets: kinds.map((kind) => parts.get(kind)!.asset) },
  });
  const tarPath = path.join(root, ZOO_EFFECTS_TAR_NAME);
  log("pack release tar (scripts/pack-asset-bundle.ts)");
  const pack = Bun.spawnSync(["bun", path.join(REPOSITORY_ROOT, "scripts/pack-asset-bundle.ts"), bundleDir, tarPath], { stdout: "pipe", stderr: "pipe" });
  if (pack.exitCode !== 0) throw new Error(`pack-asset-bundle failed: ${pack.stderr.toString()}`);
  const packed = JSON.parse(pack.stdout.toString());
  const refEntry = readAssetBundleTar(await readFile(tarPath)).find((entry) => entry.path === ASSET_BUNDLE_REF_FILE);
  if (!refEntry) throw new Error(`packed tar has no ${ASSET_BUNDLE_REF_FILE}`);
  const exportRefPath = path.join(root, ASSET_BUNDLE_REF_FILE);
  await writeFile(exportRefPath, refEntry.bytes);
  const lineage = {
    recipe: { source: RECIPE_SOURCE, sha256: sha256Bytes(recipeBytes) },
    provenance: "procedural: original deterministic 2D rasterization of flat-colour shapes, no third-party art, no models, no Blender",
    release: ZOO_EFFECTS_RELEASE, tar: { sha256: packed.sha256 as string, byteLength: packed.byteLength as number },
    parts: Object.fromEntries([...parts].map(([kind, part]) => [kind, part.asset])),
  };
  await writeFile(path.join(root, "lineage.json"), `${JSON.stringify(lineage, null, 2)}\n`);
  return {
    bundleDir, tar: tarPath, tarSha256: packed.sha256 as string, tarByteLength: packed.byteLength as number, descriptor, descriptorPath,
    exportRef: JSON.parse(Buffer.from(refEntry.bytes).toString("utf8")) as Json, exportRefPath, lineage,
    reviews: ZOO_EFFECT_KINDS.map((kind) => path.join(root, "review", `${kind}.png`)),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") {
    console.error("Usage: bun scripts/build-zoo-effects.ts --out <directory>");
    process.exit(2);
  }
  try {
    const result = await buildZooEffects({ outDir: args[1]!, log: (line) => console.error(`[zoo-effects] ${line}`) });
    console.log(JSON.stringify({ bundle: result.bundleDir, tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength, descriptor: result.descriptorPath, reviews: result.reviews, exportRef: result.exportRef }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}
