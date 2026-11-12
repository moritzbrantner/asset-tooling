// Build the coordinated feedback kits of #144 (docs/feedback-kits.md) as one rolling release:
//   bun scripts/build-feedback-kits.ts --out <directory>
// Each preset in src/feedback-kits.ts runs through executeFeedbackKitRecipe: authored effect frames packed into a
// sprite atlas, and a synthesized cue built with audio.oscillator@1, audio.adsr@1 and audio.mix@1. Per kit and
// intensity the atlas and its reduced-motion still are encoded as PNG, and the cue stays a canonical 48 kHz mono WAV.
// They, each kit's recipe and the feedback-kits-descriptor-v1 are exported as a png-wav-v1 package (asset.bundle@6)
// and packed to <directory>/feedback-kits.tar (+ .sha256), next to export.ref.json, lineage.json, the plain descriptor
// and review copies under <directory>/review/. No third-party source, model, Blender, FFmpeg or network is involved.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PNG_WAV_BUNDLE_PROFILE, exportAssetBundle } from "../src/asset-bundle.js";
import { ASSET_BUNDLE_REF_FILE, packAssetBundle } from "../src/asset-bundle-pack.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { decodePcmWav } from "../src/audio.js";
import { canonicalJson } from "../src/canonical.js";
import { encodeRgbaPng } from "../src/effect-flipbook-raster.ts";
import {
  FEEDBACK_KIT_INTENSITIES, FEEDBACK_KIT_PRESETS, FEEDBACK_KIT_SAMPLE_RATE, executeFeedbackKitRecipe, type FeedbackKitIntensity,
} from "../src/feedback-kits.ts";
import { sha256Bytes } from "../src/hash.js";
import { parseRgba8Image, type Rgba8Image } from "../src/image-rgba8.js";
import type { AssetRef } from "../src/operations.js";
import { parseSpriteAtlasManifest } from "../src/sprite-atlas-operations.js";

type Json = Record<string, any>;
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const RECIPE_SOURCE = "src/feedback-kits.ts";

export const FEEDBACK_KITS_DESCRIPTOR_SCHEMA = "feedback-kits-descriptor-v1";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const FEEDBACK_KITS_RELEASE = "feedback-kits";
export const FEEDBACK_KITS_DESCRIPTOR_KEY = "feedback-kits.descriptor";
export const FEEDBACK_KITS_DESCRIPTOR_FILE = "feedback-kits.descriptor.json";

/** The kits in release order, with the runtime owner each was made for. The owner schedules, mixes and coalesces. */
export const FEEDBACK_KIT_RELEASE_KITS = [
  { preset: FEEDBACK_KIT_PRESETS.uiReward, consumer: "ui Pop/Pulse success and reward feedback (moritzbrantner/ui#60)" },
  { preset: FEEDBACK_KIT_PRESETS.harvest, consumer: "My Farm confirmed harvest and collection (moritzbrantner/my-farm#229)" },
  { preset: FEEDBACK_KIT_PRESETS.impact, consumer: "a confirmed shield or weapon contact, such as Raid Defense's accepted impacts (moritzbrantner/raid-defense#37)" },
  { preset: FEEDBACK_KIT_PRESETS.puzzleSolved, consumer: "a solved board in the puzzle web gallery (moritzbrantner/puzzle-game-core#15)" },
] as const;

const pin = (bytes: Uint8Array) => ({ sha256: sha256Bytes(bytes), byteLength: bytes.byteLength });
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Peak and unweighted RMS in dBFS (not LUFS). */
export function cueLevels(samples: Int16Array) {
  let peak = 0, sum = 0;
  for (const s of samples) { peak = Math.max(peak, Math.abs(s)); sum += s * s; }
  return { peakDbfs: round2(20 * Math.log10(peak / 32768)), rmsDbfs: round2(20 * Math.log10(Math.sqrt(sum / samples.length) / 32768)) };
}

/** One review row: every authored frame at 1× over a dark page, then the cue's min/max waveform. */
function reviewRow(frames: Rgba8Image[], samples: Int16Array) {
  const cell = 64, gap = 8, waveWidth = 480, width = 6 * cell + gap + waveWidth, height = cell;
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([24, 24, 30, 255], i);
  frames.slice(0, 6).forEach((frame, index) => {
    for (let y = 0; y < Math.min(cell, frame.height); y += 1) for (let x = 0; x < Math.min(cell, frame.width); x += 1) {
      const s = (y * frame.width + x) * 4, a = frame.pixels[s + 3]! / 255, d = (y * width + index * cell + x) * 4;
      for (let c = 0; c < 3; c += 1) pixels[d + c] = Math.round(frame.pixels[s + c]! * a + pixels[d + c]! * (1 - a));
    }
  });
  // 1000 ms across the waveform panel, so every row shares one time scale.
  const left = 6 * cell + gap, framesPerColumn = FEEDBACK_KIT_SAMPLE_RATE / waveWidth;
  for (let x = 0; x < waveWidth; x += 1) {
    const d = (Math.round(height / 2) * width + left + x) * 4;
    pixels.set([70, 70, 84, 255], d);
    const from = Math.floor(x * framesPerColumn), to = Math.min(samples.length, Math.floor((x + 1) * framesPerColumn));
    if (from >= samples.length) continue;
    let min = 0, max = 0;
    for (let i = from; i < to; i += 1) { min = Math.min(min, samples[i]!); max = Math.max(max, samples[i]!); }
    const y0 = Math.round(height / 2 - (max / 32768) * (height / 2 - 1)), y1 = Math.round(height / 2 - (min / 32768) * (height / 2 - 1));
    for (let y = y0; y <= y1; y += 1) pixels.set([120, 220, 160, 255], (y * width + left + x) * 4);
  }
  return { width, height, pixels };
}

export async function buildFeedbackKits({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(path.join(root, "review"), { recursive: true });
  const selected: { key: string; variant: string; asset: AssetRef }[] = [];
  const kits: Json[] = [];
  const rows: ReturnType<typeof reviewRow>[] = [];
  const storePng = async (image: Rgba8Image) => {
    const png = encodeRgbaPng(image.width, image.height, image.pixels);
    return { png, asset: (await storeAssetObject(root, { bytes: png, kind: "image", mediaType: "image/png" })).asset };
  };

  for (const { preset, consumer } of FEEDBACK_KIT_RELEASE_KITS) {
    log(`build ${preset.kit} (authored frames, sprite atlas, oscillator/ADSR/mix cue per intensity)`);
    const result = await executeFeedbackKitRecipe(root, preset);
    const recipeBytes = Buffer.from(`${canonicalJson(result.recipe)}\n`);
    selected.push({ key: `${preset.kit}.recipe`, variant: "default", asset: (await storeAssetObject(root, { bytes: recipeBytes, kind: "descriptor", mediaType: "application/json" })).asset });
    const kitManifest = await resolveAssetObject(root, result.kit);
    const variants: Partial<Record<FeedbackKitIntensity, Json>> = {};
    for (const intensity of FEEDBACK_KIT_INTENSITIES) {
      const v = result.manifest.variants[intensity], evidence = result.evidence[intensity];
      const atlasImage = parseRgba8Image(await resolveAssetObject(root, v.visual.image));
      const atlas = parseSpriteAtlasManifest(await resolveAssetObject(root, v.visual.atlas));
      const still = parseRgba8Image(await resolveAssetObject(root, v.visual.reducedMotion.image));
      const visual = await storePng(atlasImage), stillPng = await storePng(still);
      const wav = await resolveAssetObject(root, v.audio.cue), samples = decodePcmWav(wav).samples;
      const name = `${preset.kit}-${intensity}`;
      await writeFile(path.join(root, "review", `${name}.wav`), wav);
      await writeFile(path.join(root, "review", `${name}.atlas.png`), visual.png);
      await writeFile(path.join(root, "review", `${name}.still.png`), stillPng.png);
      selected.push(
        { key: `${preset.kit}.visual`, variant: intensity, asset: visual.asset },
        { key: `${preset.kit}.still`, variant: intensity, asset: stillPng.asset },
        { key: `${preset.kit}.cue`, variant: intensity, asset: v.audio.cue },
      );
      const frames = [...atlas.sprites].sort((a, b) => a.frame!.index - b.frame!.index).map((sprite) => ({
        id: sprite.id, index: sprite.frame!.index, timeMs: sprite.frame!.timeMs, durationMs: sprite.frame!.durationMs,
        rect: sprite.rect, trimOffset: sprite.trimOffset, sourceSize: sprite.sourceSize, pivot: sprite.pivot, empty: sprite.empty,
      }));
      variants[intensity] = {
        visual: {
          key: `${preset.kit}.visual`, variant: intensity, png: { ...pin(visual.png), width: atlasImage.width, height: atlasImage.height },
          onsetMs: v.visual.onsetMs, durationMs: v.visual.durationMs, loop: false, frames,
        },
        reducedMotion: {
          key: `${preset.kit}.still`, variant: intensity, png: { ...pin(stillPng.png), width: still.width, height: still.height },
          frameIndex: preset.variants[intensity].reducedMotionFrameIndex, frameId: v.visual.reducedMotion.frameId,
        },
        audio: {
          key: `${preset.kit}.cue`, variant: intensity, wav: pin(wav), onsetMs: v.audio.onsetMs, durationMs: v.audio.durationMs,
          frameCount: v.audio.frameCount, ...cueLevels(samples), tones: preset.variants[intensity].tones.length,
        },
        endMs: v.endMs,
      };
      const sourceFrames = await Promise.all(evidence.visual.frames.map(async (frame) => parseRgba8Image(await resolveAssetObject(root, frame.image))));
      rows.push(reviewRow(sourceFrames, samples));
    }
    kits.push({
      kit: preset.kit, consumer, recipe: { key: `${preset.kit}.recipe`, variant: "default", ...pin(recipeBytes) }, recipeSha256: result.recipeSha256,
      kitManifest: pin(kitManifest), concurrency: result.recipe.concurrency, variants,
    });
  }

  const descriptor = {
    schema: FEEDBACK_KITS_DESCRIPTOR_SCHEMA, release: FEEDBACK_KITS_RELEASE, presentation: "cosmetic-only",
    time: { unit: "ms", origin: "accepted-cosmetic-event" },
    controls: { intensities: [...FEEDBACK_KIT_INTENSITIES], visual: "independent", audio: "independent", reducedMotion: "still", off: "draw-and-play-nothing" },
    images: { mediaType: "image/png", colorSpace: "srgb", alpha: "straight", coordinates: "top-left-pixels" },
    audio: { mediaType: "audio/wav", codec: "pcm-s16le", sampleRate: FEEDBACK_KIT_SAMPLE_RATE, channels: 1, clipping: "amplitude-sum-headroom" },
    provenance: {
      license: "original work generated in this repository; no third-party source",
      visual: "image.procedural.effect-artwork@1 poses packed by image.sprite-atlas@1",
      audio: "audio.oscillator@1 tones shaped by audio.adsr@1 and summed by audio.mix@1",
      recipeSource: RECIPE_SOURCE,
    },
    kits,
  };
  const descriptorBytes = Buffer.from(`${canonicalJson(descriptor)}\n`);
  await writeFile(path.join(root, FEEDBACK_KITS_DESCRIPTOR_FILE), descriptorBytes);
  selected.push({ key: FEEDBACK_KITS_DESCRIPTOR_KEY, variant: "default", asset: (await storeAssetObject(root, { bytes: descriptorBytes, kind: "descriptor", mediaType: "application/json" })).asset });

  const width = rows[0]!.width, height = rows.reduce((sum, row) => sum + row.height + 4, 0);
  const sheet = new Uint8Array(width * height * 4);
  for (let i = 0; i < sheet.length; i += 4) sheet.set([60, 60, 72, 255], i);
  let y = 0;
  for (const row of rows) { sheet.set(row.pixels, y * width * 4); y += row.height + 4; }
  await writeFile(path.join(root, "review", "sheet.png"), encodeRgbaPng(width, height, sheet));

  log("export png-wav-v1 package (asset.bundle@6)");
  const bundleDir = path.join(root, "bundle");
  await exportAssetBundle(root, bundleDir, {
    parameters: { profile: PNG_WAV_BUNDLE_PROFILE, assets: selected.map(({ key, variant }) => ({ key, variant })) },
    inputs: { assets: selected.map(({ asset }) => asset) },
  });
  log(`pack ${FEEDBACK_KITS_RELEASE}.tar`);
  const packed = await packAssetBundle(bundleDir);
  const tarPath = path.join(root, `${FEEDBACK_KITS_RELEASE}.tar`);
  await writeFile(tarPath, packed.tar);
  await writeFile(`${tarPath}.sha256`, `${packed.sha256}  ${path.basename(tarPath)}\n`);
  const exportRef = JSON.parse(canonicalJson(packed.ref)) as Json;
  const exportRefPath = path.join(root, ASSET_BUNDLE_REF_FILE);
  await writeFile(exportRefPath, `${canonicalJson(packed.ref)}\n`);
  const lineage = {
    recipe: { source: RECIPE_SOURCE, sha256: sha256Bytes(await readFile(path.join(REPOSITORY_ROOT, RECIPE_SOURCE))) },
    provenance: descriptor.provenance, release: FEEDBACK_KITS_RELEASE, tar: { sha256: packed.sha256, byteLength: packed.tar.byteLength },
    entries: Object.fromEntries(selected.map(({ key, variant, asset }) => [`${key}/${variant}`, asset])),
  };
  await writeFile(path.join(root, "lineage.json"), `${JSON.stringify(lineage, null, 2)}\n`);
  return { bundleDir, tar: tarPath, tarSha256: packed.sha256, tarByteLength: packed.tar.byteLength, descriptor, exportRef, exportRefPath, lineage };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") {
    console.error("Usage: bun scripts/build-feedback-kits.ts --out <directory>");
    process.exit(2);
  }
  try {
    const result = await buildFeedbackKits({ outDir: args[1]!, log: (line) => console.error(`[feedback-kits] ${line}`) });
    console.log(JSON.stringify({ bundle: result.bundleDir, tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength, exportRef: result.exportRef }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}
