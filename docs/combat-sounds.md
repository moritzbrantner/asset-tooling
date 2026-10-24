# Combat sounds

This is the CC0 audio fixture set of [#297](https://github.com/moritzbrantner/asset-tooling/issues/297), scoped by the owner to the sound list for arpg [#67](https://github.com/moritzbrantner/arpg/issues/67) (67c audio). See the [sound-list comment](https://github.com/moritzbrantner/asset-tooling/issues/297#issuecomment-6384600808) and arpg ADR 0004.

- **Consumers:** the `game-audio` crate's `SoundManifest` and arpg 67c. Playback, mapping 67a cue events onto cue kinds, voice limits and spatialisation all belong to them.
- **Sources:** CC0 only, with no account and nothing paid. Kenney packs come first: Impact Sounds, Interface Sounds, RPG Audio and Music Jingles. Gaps are filled from CC0 OpenGameArt entries: artisticdude's *RPG Sound Pack*, Ogrebane's *Battle Sound Effects* (multi-licensed; used under its CC0 option) and StumpyStrust's *Their Coming* horn. Freesound isn't used, because originals need an account.
- **Storage:** every source file is a catalog member (`catalog/sources.json`, schema version 2 for archive members) promoted to Git LFS under `assets/canonical/<member id>/`. The archives are pinned, but only their members are stored. Each member is tagged `combat-sounds` plus the purpose tags of the cues that use it, such as `sfx.combat.hit` and `sfx.ui.confirm`.
- **Release:** one rolling release, `combat-sounds` (Atlas Decision 7.1.5), never a numbered one. Publishing it is a separate coordinator step.

## Build

```sh
bun scripts/build-combat-sounds.ts --out <directory>
```

It needs FFmpeg and the hydrated members (`git lfs pull --include="assets/canonical/kenney.*,assets/canonical/opengameart.*"`), and takes a few seconds. It writes:

- `<directory>/bundle/`: an [`audio-wav-v1`](asset-bundles.md#audio-wav-profile) package (`asset.bundle@5`) holding the 35 clips, the descriptor and the SoundManifest;
- `<directory>/combat-sounds.tar` and `.sha256`: the packed package, about 1.2 MB;
- `<directory>/combat-sounds.descriptor.json` and `sound-manifest.json`: plain copies of the two packaged JSON files;
- `<directory>/export.ref.json` and `lineage.json`;
- `<directory>/review/<clip id>.wav`: each clip under a readable name, for listening.

A rebuild packs the same tar bytes.

## Processing

Every clip is mono, 44.1 kHz, 16-bit PCM WAV in the [canonical layout](audio.md#canonical-audio-v1). The recipe in [`src/combat-sounds.ts`](../src/combat-sounds.ts) runs these steps:

1. **Decode.** `audio.decode@1` uses FFmpeg (bit-exact flags) to produce 44.1 kHz mono. Stereo is downmixed and 48 kHz is resampled.
2. **Layer.** Two-part clips are combined with `audio.mix@1`, using an explicit frame offset and a rational gain per layer: for example, a heavy punch plus a body fall 160 ms later.
3. **Trim.** The onset is the first sample at or above peak / 32 (about −30 dB). The clip starts 2 ms before it, so the transient is always under 5 ms in. The tail ends 10 ms after the last sample at or above peak / 256 (about −48 dB). A clip that runs past its cue's maximum duration is cut there.
4. **Fade.** A 1 ms fade-in, and a 5 ms fade-out, or 30 ms when the clip was cut.
5. **Normalise.** `audio.gain@1` with gain `round(23197 × 10000 / peak) / 10000` brings the peak to about −3 dBFS.

All the frame arithmetic is integer, and the operations are the deterministic PCM-16 ones from [audio.md](audio.md). Relative loudness between cues is the consumer's to set: the SoundManifest carries a `gain_db` per cue, −6 dB for UI cues, the whiff and the deny sound, and −3 dB for the arrow tick.

## Descriptor `combat-sounds-descriptor-v1`

[`schemas/combat-sounds-descriptor-v1.schema.json`](../schemas/combat-sounds-descriptor-v1.schema.json) is the schema. The descriptor is the bundle entry `combat-sounds.descriptor` / `default`. It has:

- `format`: media type, codec, rate, channels and the peak target;
- `cues[]`: the `kind` (the SoundManifest cue kind), the purpose `tag`, the arpg `event` it stands for, a `sound` description, `bus`, `spatial`, `priority`, `maxVoices`, `cooldownMs`, `gainDb`, `pitchJitter`, the target `durationTargetMs` range from #297, and `clips[]`;
- each clip's `id`, bundle `key` (`sfx.<id>`), `path`, `sha256`, `byteLength`, `frameCount`, `durationMs`, `peakDbfs`, unweighted `rmsDbfs` (not LUFS), and `cut`. It also has the exact `processing` parameters (trim frames, fade frames, gain) and `layers[]`, where each layer gives the catalog source id, title, author, licence, evidence URL, download URL, archive id, archive sha256 and member path, the source sha256, the offset and the gain;
- `archives[]` and `sources[]`: every pinned archive and every source used.

## SoundManifest

The bundle entry `combat-sounds.sound-manifest` / `default` is JSON that game-audio's `SoundManifest::from_json` accepts as is: `clips[]` of `{ id, source: { url } }`, where the URL is the clip's path in the extracted bundle, and `cues[]` with `kind`, `clips`, `bus`, `priority`, `max_voices`, `cooldown_ms`, `gain_db`, `pitch_jitter` and `spatial`. `attenuation` and `variants` are left at the crate's defaults.

## Clips

The 22 cue kinds hold 35 clips. Durations are in ms. *Cut* means the clip reached its cue's maximum. RMS is in dBFS, and every peak is −3 dBFS.

| Cue kind | Clip | ms | RMS | Cut | Source (pack — file) |
| --- | --- | --- | --- | --- | --- |
| `combat.swing` | `combat.swing.1` | 117 | −19.8 | | RPG Sound Pack — swing |
| `combat.swing` | `combat.swing.2` | 90.5 | −18.6 | | RPG Sound Pack — swing2 |
| `combat.swing` | `combat.swing.3` | 98.6 | −17.8 | | RPG Sound Pack — swing3 |
| `combat.hit` | `combat.hit.1` | 293.9 | −17.4 | | Impact Sounds — impactPunch_medium_000 |
| `combat.hit` | `combat.hit.2` | 277.2 | −17.1 | | Impact Sounds — impactPunch_medium_001 |
| `combat.hit` | `combat.hit.3` | 300 | −18.3 | yes | Impact Sounds — impactPunch_medium_002 |
| `combat.hit.defeated` | `combat.hit.defeated.1` | 666.9 | −18.5 | | impactPunch_heavy_000 + impactSoft_heavy_000 (+160 ms) |
| `combat.hit.defeated` | `combat.hit.defeated.2` | 703.6 | −18.9 | | impactPunch_heavy_001 + impactSoft_heavy_002 (+140 ms) |
| `combat.blocked` | `combat.blocked.1` | 268.9 | −20.2 | | Impact Sounds — impactMetal_medium_000 |
| `combat.blocked` | `combat.blocked.2` | 140.5 | −20.1 | | Impact Sounds — impactMetal_medium_001 |
| `combat.blocked` | `combat.blocked.3` | 251.1 | −21.0 | | Impact Sounds — impactMetal_medium_003 |
| `combat.guardBroken` | `combat.guard-broken.1` | 356.4 | −21.8 | | impactMetal_heavy_001 + impactWood_heavy_000 (+20 ms) |
| `combat.guardBroken` | `combat.guard-broken.2` | 330.1 | −21.7 | | impactMetal_heavy_003 + impactWood_heavy_001 (+20 ms) |
| `combat.obstructed` | `combat.obstructed.1` | 250 | −16.9 | yes | Impact Sounds — impactMining_000 |
| `combat.obstructed` | `combat.obstructed.2` | 250 | −17.7 | yes | Impact Sounds — impactMining_001 |
| `combat.whiff` | `combat.whiff.1` | 202.8 | −23.3 | | Battle Sound Effects — swish_2 |
| `combat.hurt` | `combat.hurt.1` | 115.1 | −16.3 | | Impact Sounds — impactSoft_medium_000 |
| `combat.hurt` | `combat.hurt.2` | 180.4 | −16.9 | | Impact Sounds — impactSoft_medium_001 |
| `combat.hurt` | `combat.hurt.3` | 132.3 | −16.1 | | Impact Sounds — impactSoft_medium_002 |
| `combat.defeat` | `combat.defeat.1` | 953.6 | −20.4 | | impactSoft_heavy_001 + Music Jingles jingles_SAX01 (+120 ms) |
| `combat.arrowRelease` | `combat.arrow-release.1` | 303.1 | −24.6 | | Battle Sound Effects — Bow |
| `combat.arrowLanded` | `combat.arrow-landed.1` | 266.6 | −23.8 | | Impact Sounds — impactWood_medium_000 |
| `combat.arrowLanded` | `combat.arrow-landed.2` | 119.5 | −21.2 | | Impact Sounds — impactWood_light_000 |
| `combat.arrowBlocked` | `combat.arrow-blocked.1` | 200 | −21.2 | yes | Impact Sounds — impactMetal_light_001 |
| `combat.counterOpen` | `combat.counter-open.1` | 266.9 | −20.8 | | Interface Sounds — glass_001 |
| `combat.counterUsed` | `combat.counter-used.1` | 363.4 | −17.6 | | impactPunch_heavy_002 + impactMetal_heavy_000 |
| `world.pickedUp.gold` | `world.picked-up-gold.1` | 277.4 | −22.5 | | RPG Sound Pack — coin3 |
| `world.pickedUp.gold` | `world.picked-up-gold.2` | 500 | −18.3 | yes | RPG Sound Pack — coin |
| `world.opened` | `world.opened.1` | 591.7 | −20.1 | | RPG Audio — creak1 |
| `world.refused` | `world.refused.1` | 139.3 | −23.1 | | Interface Sounds — error_008 |
| `encounter.start` | `encounter.start.1` | 1500 | −13.7 | yes | Their Coming (generic horn sound) |
| `encounter.clear` | `encounter.clear.1` | 1369 | −18.0 | | Music Jingles — jingles_STEEL02 |
| `ui.click` | `ui.click.1` | 47.1 | −25.4 | | Interface Sounds — click_001 |
| `ui.confirm` | `ui.confirm.1` | 289.8 | −13.4 | | Interface Sounds — confirmation_001 |
| `ui.back` | `ui.back.1` | 61 | −24.7 | | Interface Sounds — back_001 |

Unprefixed impact files are from Kenney's Impact Sounds.

## Gaps and deviations

- **Bowstring twang:** one variant instead of two. The only account-free CC0 bow release found is Ogrebane's `Bow.wav`, and Kenney has none. Pitch jitter in the manifest varies it.
- **Player hurt:** non-verbal body impacts rather than grunts, an option #297 allows. Kenney has no CC0 grunt.
- **Arrow on shield:** a light metal impact, since no CC0 arrow-on-shield recording was found.
- **Short sources:** the swing (90–117 ms), the UI click (47 ms) and hurt 1 and 3 run under their target minimum, because the source recordings are that short once silence is trimmed.
- **`ui.confirm`:** allowed 300 ms instead of 200 ms, so the two-note chime isn't cut mid-note.
- **Picks without listening:** the defeat sting (a falling sax jingle) and the encounter-clear chime (a rising steel-drum jingle) were picked by measured pitch contour, not by ear. The review WAVs exist so the owner can swap any source by editing the recipe.

## Tests

`bun test test/combat-sounds.test.ts` covers three things:

- The recipe matches the #297 cue list and its variant counts, and every source is CC0, pinned, tagged and stored in LFS.
- The pure trim, fade and gain arithmetic.
- With hydrated members and FFmpeg, a real build. That build checks a byte-identical rebuild and the tar and bundle verification. For every WAV it checks format, peak, onset and maximum length. It also checks the descriptor against its schema, and that the SoundManifest resolves every clip to a bundle file.

The hosted `canonical-storage` job runs the build test with `ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1`.
