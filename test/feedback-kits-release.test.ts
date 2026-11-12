// The feedback-kits release (#144, docs/feedback-kits.md): four coordinated kits packaged as one png-wav-v1 bundle
// with a schema-conforming descriptor, cues that start at once, never clip and match their declared length, atlas
// frames that tile their declared time, and an independent rebuild that packs the same tar. The png-wav-v1 profile
// itself admits only PNG, canonical WAV and JSON, is not interchangeable with audio-wav-v1, and rejects tampering.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { verifyAssetBundleTar } from "../src/asset-bundle-pack.js";
import {
  AUDIO_BUNDLE_PROFILE, PNG_WAV_BUNDLE_PROFILE, exportAssetBundle, parsePngWavBundleManifest, readAssetBundleAsset, verifyAssetBundle,
} from "../src/asset-bundle.js";
import { storeAssetObject } from "../src/asset-store.js";
import { FEEDBACK_KIT_PRESETS, normalizeFeedbackKitRecipe } from "../src/feedback-kits.ts";
import { encodeRgba8Image } from "../src/image-rgba8.js";
import {
  FEEDBACK_KITS_DESCRIPTOR_KEY, FEEDBACK_KITS_DESCRIPTOR_SCHEMA, FEEDBACK_KITS_RELEASE, FEEDBACK_KIT_RELEASE_KITS, buildFeedbackKits,
} from "../scripts/build-feedback-kits.ts";
import { conforms, decodePng } from "./effect-flipbook-helpers.ts";

const schemaUrl = new URL("../schemas/feedback-kits-descriptor-v1.schema.json", import.meta.url);

/** Independent canonical WAV reader: 44-byte header followed by signed 16-bit little-endian mono samples. */
function pcm(bytes: Buffer) {
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.deepEqual([bytes.readUInt16LE(20), bytes.readUInt16LE(22), bytes.readUInt32LE(24), bytes.readUInt16LE(34)], [1, 1, 48000, 16]);
  return Int16Array.from({ length: (bytes.length - 44) / 2 }, (_, i) => bytes.readInt16LE(44 + i * 2));
}

test("the impact and puzzle presets validate and reuse the existing ring artwork", () => {
  for (const preset of [FEEDBACK_KIT_PRESETS.impact, FEEDBACK_KIT_PRESETS.puzzleSolved]) {
    const recipe = normalizeFeedbackKitRecipe(structuredClone(preset));
    assert.ok(recipe.variants.strong.visual.frames.every((frame) => frame.artwork.shape === "ring"));
    const amplitude = (v: typeof recipe.variants.strong) => v.tones.reduce((sum, tone) => sum + tone.amplitude, 0);
    assert.ok(amplitude(recipe.variants.subtle) < amplitude(recipe.variants.strong), `${recipe.kit} subtle cue is quieter`);
  }
  assert.deepEqual(FEEDBACK_KIT_RELEASE_KITS.map(({ preset }) => preset.kit), ["ui.reward-pulse", "farm.harvest-pop", "combat.shield-impact", "puzzle.solved"]);
});

test("the build packages every kit as a verified png-wav-v1 tar and replays to the same bytes", { timeout: 120_000 }, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "feedback-kits-"));
  const replayDir = await mkdtemp(path.join(os.tmpdir(), "feedback-kits-replay-"));
  try {
    const built = await buildFeedbackKits({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: PNG_WAV_BUNDLE_PROFILE });
    assert.equal(manifest.profile, PNG_WAV_BUNDLE_PROFILE);
    const descriptor = JSON.parse((await readAssetBundleAsset(built.bundleDir, manifest, FEEDBACK_KITS_DESCRIPTOR_KEY, "default")).toString("utf8"));
    const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
    assert.equal(descriptor.schema, FEEDBACK_KITS_DESCRIPTOR_SCHEMA);
    assert.deepEqual(conforms(schema, descriptor, schema), []);
    assert.equal(descriptor.kits.length, 4);
    // 4 kits × 2 intensities × (atlas, still, cue), one recipe per kit, and the descriptor.
    assert.equal(manifest.assets.length, 4 * 2 * 3 + 4 + 1);

    for (const kit of descriptor.kits) {
      const recipe = JSON.parse((await readAssetBundleAsset(built.bundleDir, manifest, kit.recipe.key, "default")).toString("utf8"));
      assert.equal(recipe.kit, kit.kit);
      for (const intensity of ["strong", "subtle"]) {
        const v = kit.variants[intensity], label = `${kit.kit}/${intensity}`;
        const samples = pcm(await readAssetBundleAsset(built.bundleDir, manifest, v.audio.key, intensity));
        assert.equal(samples.length, v.audio.frameCount, `${label} cue length`);
        assert.equal(samples.length, v.audio.durationMs * 48, `${label} 48 frames per ms`);
        const peak = samples.reduce((max, s) => Math.max(max, Math.abs(s)), 0);
        assert.ok(peak > 0 && peak < 32767, `${label} cue is audible and unclipped (${peak})`);
        assert.ok(samples.slice(0, 48).some((s) => s !== 0), `${label} cue starts within 1 ms`);
        assert.ok(v.endMs <= 3000 && v.endMs >= v.audio.onsetMs + v.audio.durationMs && v.endMs >= v.visual.onsetMs + v.visual.durationMs);

        const atlas = decodePng(await readAssetBundleAsset(built.bundleDir, manifest, v.visual.key, intensity));
        assert.deepEqual([atlas.width, atlas.height], [v.visual.png.width, v.visual.png.height]);
        let time = 0;
        for (const frame of v.visual.frames) {
          assert.equal(frame.timeMs, time, `${label} frame ${frame.index} follows the previous one`);
          time += frame.durationMs;
          assert.ok(frame.rect.x + frame.rect.width <= atlas.width && frame.rect.y + frame.rect.height <= atlas.height);
        }
        assert.equal(time, v.visual.durationMs);
        assert.equal(v.visual.frames.at(-1).empty, true, `${label} ends blank`);
        const still = decodePng(await readAssetBundleAsset(built.bundleDir, manifest, v.reducedMotion.key, intensity));
        let opaque = 0;
        for (let i = 3; i < still.pixels.length; i += 4) if (still.pixels[i]! > 0) opaque += 1;
        assert.ok(opaque > 0, `${label} reduced-motion still is visible`);
      }
    }
    assert.equal(built.lineage.release, FEEDBACK_KITS_RELEASE);
    assert.ok(built.tarByteLength < 512 * 1024, `the whole release stays small (${built.tarByteLength} bytes)`);

    const replay = await buildFeedbackKits({ outDir: replayDir });
    assert.equal(replay.tarSha256, built.tarSha256, "an independent rebuild packs the same tar");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(replayDir, { recursive: true, force: true });
  }
});

test("png-wav-v1 admits PNG, WAV and JSON only, needs its own verification profile and rejects tampered bytes", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "png-wav-bundle-"));
  try {
    const built = await buildFeedbackKits({ outDir: root });
    const manifest = parsePngWavBundleManifest(await readFile(path.join(built.bundleDir, "manifest.json")));
    assert.deepEqual([...new Set(manifest.assets.map((entry) => entry.path.split(".").pop()))].sort(), ["json", "png", "wav"]);
    await assert.rejects(verifyAssetBundle(built.bundleDir, built.exportRef, { profile: AUDIO_BUNDLE_PROFILE }), /explicitly selected verification profile/);
    await assert.rejects(verifyAssetBundle(built.bundleDir, built.exportRef), /explicitly selected verification profile/);

    const rgba = (await storeAssetObject(root, {
      bytes: encodeRgba8Image({ width: 1, height: 1, pixels: new Uint8Array([1, 2, 3, 4]) }), kind: "image", mediaType: "application/vnd.moritzbrantner.rgba8+json",
    })).asset;
    await assert.rejects(exportAssetBundle(root, path.join(root, "rejected"), {
      parameters: { profile: PNG_WAV_BUNDLE_PROFILE, assets: [{ key: "raw", variant: "default" }] }, inputs: { assets: [rgba] },
    }), /incompatible with png-wav-v1/);

    const wav = manifest.assets.find((entry) => entry.path.endsWith(".wav"))!;
    const file = path.join(built.bundleDir, wav.path), bytes = await readFile(file);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(file, bytes);
    await assert.rejects(verifyAssetBundle(built.bundleDir, built.exportRef, { profile: PNG_WAV_BUNDLE_PROFILE }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
