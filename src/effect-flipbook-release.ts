// Shared packaging for baked effect flipbooks (docs/zoo-effects.md, docs/combat-effects.md): writes each atlas PNG and
// its review board, exports the PNGs as a static-glb-png-v1 package (asset.bundle@1), packs it into one deterministic
// release tar (+ .sha256), and writes the consumer descriptor, export.ref.json and lineage.json next to it.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { STATIC_ASSET_BUNDLE_PROFILE, exportAssetBundle } from "./asset-bundle.js";
import { ASSET_BUNDLE_REF_FILE, packAssetBundle } from "./asset-bundle-pack.js";
import { storeAssetObject } from "./asset-store.js";
import { sha256Bytes } from "./hash.js";
import { canonicalJson } from "./canonical.js";
import type { AssetRef } from "./operations.js";
import { type EffectFlipbookLayout, encodeRgbaPng, reviewBoard } from "./effect-flipbook-raster.ts";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
type Json = Record<string, any>;

export type EffectFlipbookPart = {
  /** File stem of `<outDir>/<name>.png` and `<outDir>/review/<name>.png`. */
  name: string;
  key: string;
  variant: string;
  layout: EffectFlipbookLayout;
  pixels: Uint8Array;
  reviewBackgrounds: readonly ((x: number, y: number) => readonly number[])[];
  /** This effect's descriptor entry, given its PNG pin. */
  describe: (png: { sha256: string; byteLength: number }) => Json;
};

export async function buildEffectFlipbookRelease(options: {
  outDir: string; release: string; recipeSource: string; descriptorFile: string;
  /** The whole descriptor, given the effect entries in part order. */
  descriptor: (effects: Json[]) => Json;
  parts: readonly EffectFlipbookPart[];
  log?: (line: string) => void;
}) {
  const { release, recipeSource, parts, log = () => {} } = options;
  const root = path.resolve(options.outDir);
  await mkdir(path.join(root, "review"), { recursive: true });
  const recipeBytes = await readFile(path.join(REPOSITORY_ROOT, recipeSource));
  const stored = new Map<string, { asset: AssetRef; png: Buffer }>();
  for (const part of parts) {
    const png = encodeRgbaPng(part.layout.width, part.layout.height, part.pixels);
    await writeFile(path.join(root, `${part.name}.png`), png);
    const board = reviewBoard(part.pixels, part.reviewBackgrounds, part.layout);
    await writeFile(path.join(root, "review", `${part.name}.png`), encodeRgbaPng(board.width, board.height, board.pixels));
    stored.set(part.name, { asset: (await storeAssetObject(root, { bytes: png, kind: "image", mediaType: "image/png" })).asset, png });
  }

  log(`write ${options.descriptorFile}`);
  const descriptor = options.descriptor(parts.map((part) => {
    const { png } = stored.get(part.name)!;
    return part.describe({ sha256: sha256Bytes(png), byteLength: png.length });
  }));
  const descriptorPath = path.join(root, options.descriptorFile);
  await writeFile(descriptorPath, `${canonicalJson(descriptor)}\n`);

  log("export static-glb-png-v1 package (asset.bundle@1)");
  const bundleDir = path.join(root, "bundle");
  const sorted = [...parts].sort((a, b) => a.key.localeCompare(b.key));
  await exportAssetBundle(root, bundleDir, {
    parameters: { profile: STATIC_ASSET_BUNDLE_PROFILE, assets: sorted.map((part) => ({ key: part.key, variant: part.variant })) },
    inputs: { assets: sorted.map((part) => stored.get(part.name)!.asset) },
  });
  log(`pack ${release}.tar`);
  const packed = await packAssetBundle(bundleDir);
  const tarPath = path.join(root, `${release}.tar`);
  await writeFile(tarPath, packed.tar);
  await writeFile(`${tarPath}.sha256`, `${packed.sha256}  ${path.basename(tarPath)}\n`);
  const exportRef = JSON.parse(canonicalJson(packed.ref)) as Json;
  const exportRefPath = path.join(root, ASSET_BUNDLE_REF_FILE);
  await writeFile(exportRefPath, `${canonicalJson(packed.ref)}\n`);
  const lineage = {
    recipe: { source: recipeSource, sha256: sha256Bytes(recipeBytes) },
    provenance: "procedural: original deterministic 2D rasterization of flat-colour shapes, no third-party art, no models, no Blender",
    release, tar: { sha256: packed.sha256, byteLength: packed.tar.byteLength },
    parts: Object.fromEntries([...stored].map(([name, part]) => [name, part.asset])),
  };
  await writeFile(path.join(root, "lineage.json"), `${JSON.stringify(lineage, null, 2)}\n`);
  return {
    bundleDir, tar: tarPath, tarSha256: packed.sha256, tarByteLength: packed.tar.byteLength, descriptor, descriptorPath,
    exportRef, exportRefPath, lineage, reviews: parts.map((part) => path.join(root, "review", `${part.name}.png`)),
  };
}
