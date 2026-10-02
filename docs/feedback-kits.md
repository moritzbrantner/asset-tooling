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

`FEEDBACK_KIT_PRESETS.uiReward` (`ui.reward-pulse`) pairs the ring sequence with a rising two-note sine chime. `FEEDBACK_KIT_PRESETS.harvest` (`farm.harvest-pop`) pairs the puff sequence with a triangle pop and a short sine tick 20ms after the event. Subtle variants use the subtle sequences and quieter tones.

Run `bun examples/feedback-kits/build.ts` with the configured FFmpeg codec. It cold-replays both kits and writes the kit manifest, recipe, WAV cues, atlas PNGs and reduced-motion stills to the ignored `.artifacts/feedback-kits/`. Repeat runs reconcile identical bytes.

Run `bun test test/feedback-kits.test.ts`, then `bun run check`. Independent PCM fixtures check exact tone offsets and two-tone mixing, and other tests cover pre-write rejection, idempotent cold replay, sibling-intensity isolation on edit and cancellation.

Not yet covered: bundle packaging of WAV cues, actual UI/Farm/Raid Defense consumer journeys and runtime previews. Issue #144 stays open for those.
