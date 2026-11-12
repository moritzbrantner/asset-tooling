# Coordinated feedback kits

`asset-tooling/recipes/feedback-kits` assembles one cosmetic response from existing producers: an [authored effect frame sequence](authored-effect-sequences.md) for the visual and a short synthesized sound built with `audio.oscillator@1`, `audio.adsr@1` and `audio.mix@1`. The result is a content-addressed kit manifest (`application/vnd.moritzbrantner.feedback-kit+json`, kind `feedback-kit`) that references the actual atlas, still frame and canonical WAV AssetRefs. It is not a scheduler, particle engine or event bus.

```ts
import {FEEDBACK_KIT_PRESETS, executeFeedbackKitRecipe} from "asset-tooling/recipes/feedback-kits";

const result = await executeFeedbackKitRecipe(absoluteAssetRoot, FEEDBACK_KIT_PRESETS.uiReward, {signal});
// result.kit: AssetRef of the stored manifest; result.manifest: the same JSON; result.evidence: every producer build.
```

## Recipe v1

A recipe has exactly `schemaVersion: 1`, `kit` (portable lowercase token, at most 64 characters), `concurrency` and `variants`.

- `variants` has exactly `strong` and `subtle`. Each declares `visual` (an authored one-shot sequence), `visualOnsetMs`, `reducedMotionFrameIndex`, `audioOnsetMs` and 1–4 `tones`.
- A tone declares `waveform` (`sine` or `triangle`), integer `frequencyHz` (20–12000), Q15 `amplitude`, `startMs`, `durationMs` and an ADSR envelope in milliseconds plus `sustainLevelQ15`. The envelope must fit inside the tone, and each tone must end within 2000ms.
- Audio is always mono 48 kHz canonical PCM, so milliseconds convert to exactly 48 frames without rounding.
- Clipping policy `amplitude-sum-headroom`: tone amplitudes must sum to at most 32767. Oscillator samples never exceed their amplitude and ADSR only attenuates, so the mix cannot saturate.
- Onsets are 0–1000ms after the time origin `accepted-cosmetic-event`; each variant must finish within 3000ms.
- `reducedMotionFrameIndex` selects a visible authored frame. The manifest exposes its image as the static reduced-motion presentation.
- `concurrency` declares `maxActive` (1–8) and `overflow` (`drop-new` or `replace-oldest`) for repeated events. This is metadata for the consuming runtime, which enforces it.

Everything validates before the first object is written. An AbortSignal is checked between producer stages; a cancelled run returns no kit and leaves previously accepted objects intact.

## Runtime boundary

Visual and audio references are independent, so a consumer can combine any visual intensity (or none) with any audio intensity (or mute) and use the still frame under reduced motion. Disabling every cosmetic must leave essential information to the product UI. Games and UI own event acceptance, scheduling, easing, audio activation and coalescing; the kit carries no executable scripts, timers or gameplay callbacks.

## Presets and example

| Preset | Kit | Visual | Cue | Concurrency |
| --- | --- | --- | --- | --- |
| `uiReward` | `ui.reward-pulse` | the gold ring sequence, 420 ms | a rising two-note sine chime (660 and 990 Hz), 290 ms | 2, `replace-oldest` |
| `harvest` | `farm.harvest-pop` | the pale puff sequence, 600 ms | a triangle pop and a short sine tick, 20 ms after the event, 150 ms | 4, `drop-new` |
| `impact` | `combat.shield-impact` | a fast pale-gold flash ring, 240 ms | a 150 Hz triangle thump under three inharmonic sine partials (1870, 2960 and 4410 Hz) that ring out, 260 ms | 6, `drop-new` |
| `puzzleSolved` | `puzzle.solved` | a slower mint ring that settles out, 520 ms | a rising C-major arpeggio (C6, E6, G6, C7), 600 ms; the subtle cue keeps C6 and C7 | 1, `drop-new` |

The impact and puzzle kits reuse the ring artwork and the oscillator/ADSR/mix chain of the first two. Subtle variants keep every pose and time and scale only the opacities, and use quieter tones (and, for the puzzle, fewer notes). Every strong cue peaks between about −11 and −5 dBFS and every subtle one about 8 dB lower, so none clip; relative loudness between kits is the consumer's mix.

Run `bun examples/feedback-kits/build.ts` with the configured FFmpeg codec. It cold-replays every preset and writes the kit manifest, recipe, WAV cues, atlas PNGs and reduced-motion stills to the ignored `.artifacts/feedback-kits/`. Repeat runs reconcile identical bytes.

## Release `feedback-kits`

The four presets ship as one rolling release, `feedback-kits` (Atlas Decision 7.1.5), never a numbered one. CI publishes it when a change to its recipe merges ([Publishing a rolling release](../README.md#publishing-a-rolling-release)).

```sh
bun scripts/build-feedback-kits.ts --out <directory>
```

The build takes about two seconds and needs no FFmpeg, Blender, model, network or third-party source: PNGs are encoded by the deterministic encoder of the effect flipbooks. It writes:

- `<directory>/bundle/`: a [`png-wav-v1`](asset-bundles.md#png-and-wav-profile) package (`asset.bundle@6`);
- `<directory>/feedback-kits.tar` and `.sha256`: the packed package, about 330 KB;
- `<directory>/feedback-kits.descriptor.json`: a plain copy of the packaged descriptor;
- `<directory>/export.ref.json` and `lineage.json`;
- `<directory>/review/`: every cue as `<kit>-<intensity>.wav`, every atlas and still as PNG, and `sheet.png`, which shows each kit and intensity as a row of its authored frames beside its cue's waveform (1 s across). [`review/feedback-kits/sheet.jpg`](../review/feedback-kits/sheet.jpg) is that sheet at 2×, in the table's order, strong above subtle.

A rebuild packs the same tar bytes.

Per kit and intensity the bundle holds `<kit>.visual` (the sprite atlas PNG), `<kit>.still` (the reduced-motion still PNG) and `<kit>.cue` (the WAV), with variant `strong` or `subtle`. Each kit's normalized recipe is `<kit>.recipe` / `default`, and the descriptor is `feedback-kits.descriptor` / `default`.

### Descriptor `feedback-kits-descriptor-v1`

[`schemas/feedback-kits-descriptor-v1.schema.json`](../schemas/feedback-kits-descriptor-v1.schema.json) is the schema. The top level declares `presentation: "cosmetic-only"`, the time unit and origin, the `controls` (two intensities; visual and audio independent; `still` under reduced motion; nothing drawn or played when off), the image and audio formats, and the provenance: original work generated here, with no third-party source.

Each entry of `kits` has the `kit`, the `consumer` it was made for, its `recipe` entry and `recipeSha256`, the pin of the content-addressed kit manifest, the `concurrency` and both `variants`. A variant gives:

- `visual`: the atlas entry, its PNG pin and size, `onsetMs`, `durationMs`, `loop: false` and every frame's `id`, `index`, `timeMs`, `durationMs`, atlas `rect`, `trimOffset`, `sourceSize`, `pivot` and `empty`. The frames tile the duration exactly, and the last one is empty;
- `reducedMotion`: the still entry, its PNG pin and size, and the authored frame it shows;
- `audio`: the cue entry, its WAV pin, `onsetMs`, `durationMs`, `frameCount`, peak and unweighted RMS in dBFS (not LUFS) and its tone count;
- `endMs`: when both have finished.

### Consumer use

A consumer pins `export.ref.json`, verifies the downloaded tar with `bun scripts/pack-asset-bundle.ts --verify feedback-kits.tar --ref export.ref.json` ([asset-bundles.md](asset-bundles.md#release-distribution-and-consumer-pinning)), and vendors only the entries it uses. On its own accepted event it may draw the visual from `visual.onsetMs`, stepping through `frames` by their `timeMs`, and start the cue at `audio.onsetMs`, only after the user has enabled audio. The consumer owns everything else: whether the event was accepted, scheduling, easing and placement, its mixer and audio activation, the overflow policy, and replay protection.

The `consumer` fields name ui#60, my-farm#229, raid-defense#37 and puzzle-game-core#15. My Farm already uses the `farm.harvest-pop` and `ui.reward-pulse` subtle variants, built from this recipe at a pinned commit. The release gives the same pixels and samples a pinned, verified download, although its PNG bytes differ from the example's FFmpeg-encoded ones.

## Tests

Run `bun test test/feedback-kits.test.ts test/feedback-kits-release.test.ts`, then `bun run check`.

- Independent PCM fixtures check exact tone offsets and two-tone mixing. Other tests cover pre-write rejection, idempotent cold replay, sibling-intensity isolation on edit and cancellation.
- The release test builds the release and verifies the tar and the bundle. It checks the descriptor against its schema, and for every kit and intensity it checks that the cue is 48 kHz mono, matches its declared length, starts within 1 ms and doesn't clip. It also checks that the frames tile the duration and end blank, that the still is visible, and that an independent rebuild packs the same tar.
- The profile test checks that `png-wav-v1` holds PNG, WAV and JSON, rejects a canonical RGBA8 image, fails verification under the audio or static profile, and fails on a tampered WAV.

## Not covered here

- The runtime preview with exact time, restart, seed and intensity controls in the Pages gallery.
- Consumer journeys: ui's Pop/Pulse with sound (ui#60), Raid Defense impacts (raid-defense#37) and puzzle completion (puzzle-game-core#15). My Farm's harvest journey shipped in my-farm#229.
- Owner listening and visual review of the impact and puzzle kits. The visuals are deliberately simple rings and puffs, and the cues are synthesized sine and triangle tones, not recordings.

Issue #144 stays open for these.
