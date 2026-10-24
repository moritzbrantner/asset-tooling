// The CC0 combat sound set (#297, docs/combat-sounds.md): recipe and catalog provenance, the pure trim/fade/gain
// arithmetic, and (with hydrated LFS members and FFmpeg) the real build, its bundle and its game-audio manifest.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { verifyAssetBundleTar } from "../src/asset-bundle-pack.js";
import { readAssetBundleAsset, verifyAssetBundle, AUDIO_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { decodePcmWav } from "../src/audio.js";
import {
  COMBAT_SOUND_CUES, COMBAT_SOUND_PEAK_TARGET, COMBAT_SOUND_SAMPLE_RATE, COMBAT_SOUND_SOURCES, ONSET_DIVISOR,
  fadeFrames, msToFrames, normaliseGain, peakOf, trimWindow,
} from "../src/combat-sounds.ts";
import { buildCombatSounds, DESCRIPTOR_KEY, SOUND_MANIFEST_KEY, COMBAT_SOUNDS_VARIANT } from "../scripts/build-combat-sounds.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const readJson = async (file: string) => JSON.parse(await readFile(path.join(root, file), "utf8"));
const sources: { sources: any[] } = await readJson("catalog/sources.json");
const storage: { entries: { sourceId: string; path: string }[] } = await readJson("catalog/storage.json");
const records = new Map(sources.sources.map((record) => [record.id, record]));

/** The JSON Schema subset the descriptor schema uses. */
function conforms(schema: any, value: any, rootSchema: any, at = "$"): string[] {
  if (schema.$ref) return conforms(rootSchema.$defs[schema.$ref.split("/").pop()], value, rootSchema, at);
  const errors: string[] = [];
  for (const part of schema.allOf ?? []) errors.push(...conforms(part, value, rootSchema, at));
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) return [...errors, `${at} is not ${schema.const}`];
  if (schema.enum && !schema.enum.includes(value)) return [...errors, `${at} is not one of ${schema.enum}`];
  const type = schema.type;
  if (type === "number" || type === "integer") { if (typeof value !== "number" || (type === "integer" && !Number.isInteger(value))) errors.push(`${at} is not a ${type}`); }
  else if (type === "boolean") { if (typeof value !== "boolean") errors.push(`${at} is not a boolean`); }
  else if (type === "string") { if (typeof value !== "string" || (schema.pattern && !new RegExp(schema.pattern).test(value))) errors.push(`${at} is not a matching string`); }
  else if (type === "array") {
    if (!Array.isArray(value)) return [...errors, `${at} is not an array`];
    if (schema.items) value.forEach((item, index) => errors.push(...conforms(schema.items, item, rootSchema, `${at}[${index}]`)));
  }
  if (type === "object" || schema.required || schema.properties) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [...errors, `${at} is not an object`];
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${at}.${key} is missing`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...conforms(schema.properties[key], item, rootSchema, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key} is not allowed`);
    }
  }
  return errors;
}

test("the recipe covers #297's cue list with CC0, pinned, LFS-stored catalog members", () => {
  const kinds = COMBAT_SOUND_CUES.map((cue) => cue.kind), clipIds = COMBAT_SOUND_CUES.flatMap((cue) => cue.clips.map((clip) => clip.id));
  assert.equal(new Set(kinds).size, kinds.length);
  assert.equal(new Set(clipIds).size, clipIds.length);
  assert.equal(kinds.length, 22);
  assert.equal(clipIds.length, 35);
  const variants = Object.fromEntries(COMBAT_SOUND_CUES.map((cue) => [cue.kind, cue.clips.length]));
  assert.deepEqual(variants, {
    "combat.swing": 3, "combat.hit": 3, "combat.hit.defeated": 2, "combat.blocked": 3, "combat.guardBroken": 2, "combat.obstructed": 2,
    "combat.whiff": 1, "combat.hurt": 3, "combat.defeat": 1, "combat.arrowRelease": 1, "combat.arrowLanded": 2, "combat.arrowBlocked": 1,
    "combat.counterOpen": 1, "combat.counterUsed": 1, "world.pickedUp.gold": 2, "world.opened": 1, "world.refused": 1,
    "encounter.start": 1, "encounter.clear": 1, "ui.click": 1, "ui.confirm": 1, "ui.back": 1,
  });
  const stored = new Set(storage.entries.map((entry) => entry.sourceId));
  for (const source of COMBAT_SOUND_SOURCES) {
    const record = records.get(source.id);
    assert.ok(record, `${source.id} is registered`);
    assert.equal(record.license.spdx, "CC0-1.0");
    assert.ok(["kenney", "opengameart"].includes(record.provider));
    assert.match(record.source.sha256, /^[0-9a-f]{64}$/, `${source.id} is pinned`);
    assert.ok(stored.has(source.id), `${source.id} has a canonical storage entry`);
    if (source.archive) {
      assert.deepEqual(record.archiveMember, { archive: source.archive, path: source.path });
      assert.match(records.get(source.archive).source.sha256, /^[0-9a-f]{64}$/, `${source.archive} is pinned`);
    }
  }
  for (const cue of COMBAT_SOUND_CUES) for (const clip of cue.clips) for (const layer of clip.layers) {
    assert.ok(COMBAT_SOUND_SOURCES.some((source) => source.id === layer.source), `${clip.id} layer ${layer.source} is a recipe source`);
    assert.ok(records.get(layer.source).tags.includes(cue.tag), `${layer.source} carries ${cue.tag}`);
  }
});

test("trim keeps under 5 ms before the transient, cuts at the cue maximum and normalises to about −3 dBFS", () => {
  const samples = new Int16Array(msToFrames(600));
  const onset = msToFrames(100);
  samples[msToFrames(40)] = 200; // low noise well under peak / 32 before the transient
  for (let i = onset; i < samples.length; i += 1) samples[i] = Math.round(8000 * Math.exp(-(i - onset) / 6000)) * (i % 2 ? 1 : -1);
  const window = trimWindow(samples, 300);
  assert.equal(window.onsetFrame, onset);
  assert.ok(onset - window.startFrame <= msToFrames(5) && onset - window.startFrame > 0);
  assert.equal(window.endFrame - window.startFrame, msToFrames(300));
  assert.equal(window.cut, true);
  const short = trimWindow(samples, 2000);
  assert.equal(short.cut, false);
  assert.ok(short.endFrame <= samples.length);
  assert.ok(Math.abs(samples[short.endFrame - 1 - msToFrames(10)]!) >= Math.ceil(8000 / 256) || short.endFrame === samples.length);
  assert.deepEqual(fadeFrames(1000, true), { fadeInFrames: 44, fadeOutFrames: 500 });
  assert.deepEqual(fadeFrames(44_100, false), { fadeInFrames: 44, fadeOutFrames: 221 });
  const gain = normaliseGain(8000);
  assert.equal(gain.denominator, 10_000);
  assert.ok(Math.abs(Math.round((8000 * gain.numerator) / gain.denominator) - COMBAT_SOUND_PEAK_TARGET) <= 1);
  assert.throws(() => normaliseGain(10), /too quiet/);
  assert.throws(() => trimWindow(new Int16Array(10), 100), /silent/);
});

const pointers: string[] = [];
for (const source of COMBAT_SOUND_SOURCES) {
  const entry = storage.entries.find((candidate) => candidate.sourceId === source.id)!;
  if ((await readFile(path.join(root, entry.path))).subarray(0, 64).toString().startsWith("version https://git-lfs.github.com/spec/v1")) pointers.push(entry.path);
}
if (process.env.ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE === "1") assert.deepEqual(pointers, []);
const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

test("the build packs a verified, deterministic audio-wav-v1 bundle with a game-audio SoundManifest", {
  skip: pointers.length ? "requires hydrated combat sound members (git lfs pull)" : !ffmpeg ? "requires FFmpeg" : false,
  timeout: 120_000,
}, async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "combat-sounds-")), again = await mkdtemp(path.join(os.tmpdir(), "combat-sounds-"));
  try {
    const result = await buildCombatSounds({ outDir: out });
    assert.equal((await buildCombatSounds({ outDir: again })).tarSha256, result.tarSha256, "rebuilds are byte-identical");
    const checked = await verifyAssetBundleTar(await readFile(result.tar), { sha256: result.tarSha256, ref: result.exportRef });
    assert.equal(checked.manifest.profile, AUDIO_BUNDLE_PROFILE);
    const { manifest } = await verifyAssetBundle(result.bundleDir, result.exportRef, { profile: AUDIO_BUNDLE_PROFILE });

    const descriptor = JSON.parse((await readAssetBundleAsset(result.bundleDir, manifest, DESCRIPTOR_KEY, COMBAT_SOUNDS_VARIANT)).toString("utf8"));
    const schema = await readJson("schemas/combat-sounds-descriptor-v1.schema.json");
    assert.deepEqual(conforms(schema, descriptor, schema), []);
    assert.deepEqual(descriptor, result.descriptor);

    for (const cue of descriptor.cues) for (const clip of cue.clips) {
      const bytes = await readAssetBundleAsset(result.bundleDir, manifest, clip.key, COMBAT_SOUNDS_VARIANT);
      const audio = decodePcmWav(bytes);
      assert.equal(audio.sampleRate, COMBAT_SOUND_SAMPLE_RATE);
      assert.equal(audio.channels, 1);
      assert.equal(audio.sourceBitsPerSample, 16);
      assert.equal(audio.samples.length, clip.frameCount);
      assert.ok(Math.abs(peakOf(audio.samples) - COMBAT_SOUND_PEAK_TARGET) <= 2, `${clip.id} peaks at −3 dBFS`);
      assert.ok(clip.durationMs <= cue.durationTargetMs[1], `${clip.id} fits its cue maximum`);
      let onset = 0;
      while (Math.abs(audio.samples[onset]!) < COMBAT_SOUND_PEAK_TARGET / ONSET_DIVISOR) onset += 1;
      assert.ok(onset < msToFrames(5), `${clip.id} starts within 5 ms of its transient`);
      assert.equal(clip.path, manifest.assets.find((entry) => entry.key === clip.key)!.path);
    }

    const soundManifest = JSON.parse((await readAssetBundleAsset(result.bundleDir, manifest, SOUND_MANIFEST_KEY, COMBAT_SOUNDS_VARIANT)).toString("utf8"));
    assert.deepEqual(Object.keys(soundManifest).sort(), ["clips", "cues"]);
    const clipIds = new Set(soundManifest.clips.map((clip: any) => clip.id));
    const files = new Set(manifest.assets.map((entry) => entry.path));
    for (const clip of soundManifest.clips) assert.ok(files.has(clip.source.url), `${clip.id} URL is a bundle file`);
    for (const cue of soundManifest.cues) {
      assert.deepEqual(Object.keys(cue).sort(), ["bus", "clips", "cooldown_ms", "gain_db", "kind", "max_voices", "pitch_jitter", "priority", "spatial"]);
      assert.ok(cue.clips.length > 0 && cue.clips.every((id: string) => clipIds.has(id)));
    }
  } finally {
    await rm(out, { recursive: true, force: true });
    await rm(again, { recursive: true, force: true });
  }
});
