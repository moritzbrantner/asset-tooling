// Build the CC0 combat sound bundle for arpg #67 (asset-tooling #297, docs/combat-sounds.md) from the recipe in
// src/combat-sounds.ts and its Git LFS catalog members:
//   bun scripts/build-combat-sounds.ts --out <directory>
// Needs FFmpeg (audio.decode@1) and the hydrated members under assets/canonical/. Every clip is decoded to 44.1 kHz
// mono, layered (audio.mix@1), trimmed (audio.trim@1), faded (audio.fade@1) and normalised to about −3 dBFS peak
// (audio.gain@1). The clips, the combat-sounds-descriptor-v1 and a game-audio SoundManifest are exported as an
// audio-wav-v1 bundle (asset.bundle@5) and packed to <directory>/combat-sounds.tar (+ .sha256), next to
// export.ref.json, lineage.json and plainly named review copies under <directory>/review/.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AUDIO_BUNDLE_PROFILE, exportAssetBundle } from "../src/asset-bundle.js";
import { ASSET_BUNDLE_REF_FILE, readAssetBundleTar } from "../src/asset-bundle-pack.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { decodePcmWav } from "../src/audio.js";
import { executeAudioDecodeOperation } from "../src/audio-codec-operations.js";
import { executeAudioFadeOperation, executeAudioGainOperation, executeAudioMixOperation, executeAudioTrimOperation } from "../src/audio-operations.js";
import { canonicalJson } from "../src/canonical.js";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { sha256Bytes } from "../src/hash.js";
import type { AssetOperationResult, AssetRef } from "../src/operations.js";
import {
  COMBAT_SOUND_ARCHIVES, COMBAT_SOUND_CUES, COMBAT_SOUND_FILES, COMBAT_SOUND_PEAK_TARGET, COMBAT_SOUND_SAMPLE_RATE, COMBAT_SOUND_SOURCES,
  fadeFrames, loudness, msToFrames, normaliseGain, peakOf, trimWindow, type Clip, type Cue,
} from "../src/combat-sounds.ts";

type Json = Record<string, any>;
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const RECIPE_SOURCE = "src/combat-sounds.ts";

export const COMBAT_SOUNDS_DESCRIPTOR_SCHEMA = "combat-sounds-descriptor-v1";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const COMBAT_SOUNDS_RELEASE = "combat-sounds";
export const COMBAT_SOUNDS_TAR_NAME = "combat-sounds.tar";
export const COMBAT_SOUNDS_VARIANT = "default";
export const DESCRIPTOR_KEY = "combat-sounds.descriptor";
export const SOUND_MANIFEST_KEY = "combat-sounds.sound-manifest";

const output = (result: AssetOperationResult): AssetRef => {
  const ref = result.outputs.output;
  if (!ref || Array.isArray(ref)) throw new Error("audio operation has no single output");
  return ref;
};
const samplesOf = async (root: string, ref: AssetRef) => decodePcmWav(await resolveAssetObject(root, ref)).samples;
const ms = (frames: number) => Math.round((frames * 10_000) / COMBAT_SOUND_SAMPLE_RATE) / 10;

export async function buildCombatSounds({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(path.join(root, "review"), { recursive: true });
  const readJson = async (file: string) => JSON.parse(await readFile(path.join(REPOSITORY_ROOT, file), "utf8"));
  const [providers, sources, storage] = await Promise.all(["providers", "sources", "storage"].map((name) => readJson(`catalog/${name}.json`)));
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const records = new Map<string, Json>(sources.sources.map((record: Json) => [record.id, record]));

  log(`decode ${COMBAT_SOUND_SOURCES.length} catalog sources to ${COMBAT_SOUND_SAMPLE_RATE} Hz mono (audio.decode@1)`);
  const decoded = new Map<string, { source: AssetRef; pcm: AssetRef }>();
  for (const clipSource of COMBAT_SOUND_SOURCES) {
    const source = (await importAssetCatalogStorageSource({ catalog, storage, sourceId: clipSource.id, storageRoot: REPOSITORY_ROOT, objectStoreRoot: root })).asset as AssetRef;
    const pcm = output(await executeAudioDecodeOperation(root, { parameters: { sampleRate: COMBAT_SOUND_SAMPLE_RATE, channels: 1 }, inputs: { source } }));
    decoded.set(clipSource.id, { source, pcm });
  }

  const provenance = (id: string) => {
    const record = records.get(id)!, archive = record.archiveMember ? records.get(record.archiveMember.archive)! : undefined;
    const origin = archive ?? record;
    return {
      sourceId: id, title: record.title, author: origin.metadata.author, license: record.license.spdx, evidenceUrl: record.license.evidenceUrl,
      url: origin.source.url, ...(archive ? { archive: { id: archive.id, sha256: archive.source.sha256, member: record.archiveMember.path } } : {}),
      sha256: record.source.sha256, byteLength: record.source.byteLength,
      ...(origin.metadata.licenseNote ? { licenseNote: origin.metadata.licenseNote } : {}),
    };
  };

  async function buildClip(cue: Cue, clip: Clip) {
    const layers = clip.layers.map((layer) => ({ ...layer, pcm: decoded.get(layer.source)!.pcm }));
    const mixed = layers.length === 1 && !layers[0]!.offsetMs && !layers[0]!.gain ? layers[0]!.pcm : output(await executeAudioMixOperation(root, {
      parameters: { tracks: layers.map((layer) => ({ startFrame: msToFrames(layer.offsetMs ?? 0), gainNumerator: layer.gain?.[0] ?? 1, gainDenominator: layer.gain?.[1] ?? 1 })) },
      inputs: { sources: layers.map((layer) => layer.pcm) },
    }));
    const window = trimWindow(await samplesOf(root, mixed), cue.durationMs[1]);
    const trimmed = output(await executeAudioTrimOperation(root, { parameters: { startFrame: window.startFrame, endFrame: window.endFrame }, inputs: { source: mixed } }));
    const fades = fadeFrames(window.endFrame - window.startFrame, window.cut);
    const faded = output(await executeAudioFadeOperation(root, { parameters: fades, inputs: { source: trimmed } }));
    const gain = normaliseGain(peakOf(await samplesOf(root, faded)));
    const final = output(await executeAudioGainOperation(root, { parameters: gain, inputs: { source: faded } }));
    const bytes = await resolveAssetObject(root, final), samples = decodePcmWav(bytes).samples;
    await writeFile(path.join(root, "review", `${clip.id}.wav`), bytes);
    return {
      asset: final,
      entry: {
        id: clip.id, key: `sfx.${clip.id}`, path: `assets/${final.sha256}.wav`, sha256: final.sha256, byteLength: final.byteLength,
        frameCount: samples.length, durationMs: ms(samples.length), ...loudness(samples), cut: window.cut,
        processing: { trim: { startFrame: window.startFrame, endFrame: window.endFrame }, fade: fades, gain },
        layers: clip.layers.map((layer) => ({ ...provenance(layer.source), offsetMs: layer.offsetMs ?? 0, gain: layer.gain ?? [1, 1] })),
      },
    };
  }

  const clipAssets: { key: string; asset: AssetRef }[] = [];
  const cues: Json[] = [];
  for (const cue of COMBAT_SOUND_CUES) {
    log(`build ${cue.kind} (${cue.clips.length} clip${cue.clips.length === 1 ? "" : "s"})`);
    const clips: Json[] = [];
    for (const clip of cue.clips) {
      const built = await buildClip(cue, clip);
      clipAssets.push({ key: built.entry.key, asset: built.asset });
      clips.push(built.entry);
    }
    cues.push({
      kind: cue.kind, tag: cue.tag, event: cue.event, sound: cue.sound, bus: cue.bus, spatial: cue.spatial, priority: cue.priority,
      maxVoices: cue.maxVoices, cooldownMs: cue.cooldownMs, gainDb: cue.gainDb, pitchJitter: cue.pitchJitter, durationTargetMs: cue.durationMs, clips,
    });
  }

  const usedSources = [...new Set(COMBAT_SOUND_CUES.flatMap((cue) => cue.clips.flatMap((clip) => clip.layers.map((layer) => layer.source))))].sort();
  const descriptor = {
    schema: COMBAT_SOUNDS_DESCRIPTOR_SCHEMA, release: COMBAT_SOUNDS_RELEASE, soundManifest: SOUND_MANIFEST_KEY,
    format: { mediaType: "audio/wav", codec: "pcm-s16le", sampleRate: COMBAT_SOUND_SAMPLE_RATE, channels: 1, peakTarget: COMBAT_SOUND_PEAK_TARGET, peakTargetDbfs: -3 },
    cues,
    archives: [...COMBAT_SOUND_ARCHIVES, ...COMBAT_SOUND_FILES].filter((a) => records.get(a.id)?.source.sha256).map((a) => ({
      id: a.id, title: a.title, author: a.author, url: a.url, evidenceUrl: a.evidenceUrl, license: "CC0-1.0",
      sha256: records.get(a.id)!.source.sha256, byteLength: records.get(a.id)!.source.byteLength,
    })),
    sources: usedSources.map(provenance),
  };
  // Directly loadable by game-audio's SoundManifest::from_json; clip URLs are relative to the extracted bundle.
  const soundManifest = {
    clips: cues.flatMap((cue) => cue.clips.map((clip: Json) => ({ id: clip.id, source: { url: clip.path } }))),
    cues: cues.map((cue) => ({
      kind: cue.kind, clips: cue.clips.map((clip: Json) => clip.id), bus: cue.bus, priority: cue.priority, max_voices: cue.maxVoices,
      cooldown_ms: cue.cooldownMs, gain_db: cue.gainDb, pitch_jitter: cue.pitchJitter, spatial: cue.spatial,
    })),
  };
  const descriptorBytes = Buffer.from(`${canonicalJson(descriptor)}\n`), soundManifestBytes = Buffer.from(`${canonicalJson(soundManifest)}\n`);
  const descriptorAsset = (await storeAssetObject(root, { bytes: descriptorBytes, kind: "descriptor", mediaType: "application/json" })).asset;
  const soundManifestAsset = (await storeAssetObject(root, { bytes: soundManifestBytes, kind: "descriptor", mediaType: "application/json" })).asset;
  await writeFile(path.join(root, "combat-sounds.descriptor.json"), descriptorBytes);
  await writeFile(path.join(root, "sound-manifest.json"), soundManifestBytes);

  log("export audio-wav-v1 bundle (asset.bundle@5)");
  const bundleDir = path.join(root, "bundle");
  const selected = [...clipAssets, { key: DESCRIPTOR_KEY, asset: descriptorAsset }, { key: SOUND_MANIFEST_KEY, asset: soundManifestAsset }];
  await exportAssetBundle(root, bundleDir, {
    parameters: { profile: AUDIO_BUNDLE_PROFILE, assets: selected.map(({ key }) => ({ key, variant: COMBAT_SOUNDS_VARIANT })) },
    inputs: { assets: selected.map(({ asset }) => asset) },
  });
  const tarPath = path.join(root, COMBAT_SOUNDS_TAR_NAME);
  log("pack release tar (scripts/pack-asset-bundle.ts)");
  const pack = Bun.spawnSync(["bun", path.join(REPOSITORY_ROOT, "scripts/pack-asset-bundle.ts"), bundleDir, tarPath], { stdout: "pipe", stderr: "pipe" });
  if (pack.exitCode !== 0) throw new Error(`pack-asset-bundle failed: ${pack.stderr.toString()}`);
  const packed = JSON.parse(pack.stdout.toString());
  const refEntry = readAssetBundleTar(await readFile(tarPath)).find((entry) => entry.path === ASSET_BUNDLE_REF_FILE);
  if (!refEntry) throw new Error(`packed tar has no ${ASSET_BUNDLE_REF_FILE}`);
  const exportRefPath = path.join(root, ASSET_BUNDLE_REF_FILE);
  await writeFile(exportRefPath, refEntry.bytes);
  const lineage = {
    recipe: { source: RECIPE_SOURCE, sha256: sha256Bytes(await readFile(path.join(REPOSITORY_ROOT, RECIPE_SOURCE))) },
    provenance: "CC0 catalog members (Kenney, OpenGameArt) decoded with FFmpeg, then layered, trimmed, faded and normalised with the builtin PCM-16 operations",
    release: COMBAT_SOUNDS_RELEASE, tar: { sha256: packed.sha256 as string, byteLength: packed.byteLength as number },
    descriptor: descriptorAsset, soundManifest: soundManifestAsset,
    clips: Object.fromEntries(clipAssets.map(({ key, asset }) => [key, asset])),
  };
  await writeFile(path.join(root, "lineage.json"), `${JSON.stringify(lineage, null, 2)}\n`);
  return {
    bundleDir, tar: tarPath, tarSha256: packed.sha256 as string, tarByteLength: packed.byteLength as number, descriptor, soundManifest,
    exportRef: JSON.parse(Buffer.from(refEntry.bytes).toString("utf8")) as Json, exportRefPath, lineage,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") {
    console.error("Usage: bun scripts/build-combat-sounds.ts --out <directory>");
    process.exit(2);
  }
  try {
    const result = await buildCombatSounds({ outDir: args[1]!, log: (line) => console.error(`[combat-sounds] ${line}`) });
    console.log(JSON.stringify({ bundle: result.bundleDir, tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength, exportRef: result.exportRef }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}
