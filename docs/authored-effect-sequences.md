# Explicit authored effect frame sequences

`asset-tooling/recipes/authored-effect-sequences` composes saved discrete puff/ring poses through the existing static artwork operation and sprite-atlas operation. Each pose carries an explicit index, sample time and duration. This is frame authoring and packing; it evaluates no motion, interpolates no missing pose, and invokes no game random stream. Static SDF/image kernels remain the pixel authority. Flat Stories and 3d-lab retain their animation/cosmetic evaluator boundaries.

```ts
import {
  AUTHORED_EFFECT_SEQUENCE_PRESETS, executeAuthoredEffectSequenceRecipe,
} from "asset-tooling/recipes/authored-effect-sequences";

const result = await executeAuthoredEffectSequenceRecipe(
  absoluteAssetRoot, AUTHORED_EFFECT_SEQUENCE_PRESETS.ring.subtle,
  { signal: abortController.signal },
);
```

The returned `frames` record each original image/mask AssetRef, static producer build, complete observations, semantic ID and explicit frame metadata. `atlas` records the existing atlas build/result, including its original canonical image and `sprite-atlas+json` manifest AssetRefs. Recipe SHA-256 covers authored controls; the underlying builds separately capture implementation/tool identity. A recipe hash alone is not a build or replay receipt.

## Authoring controls and limits

Version 1 accepts exactly `schemaVersion: 1`, `sequence`, `loop: false`, `atlas` and `frames`. Sequence names are portable lowercase tokens up to 112 characters. Supply 2–32 frames, each with exactly `index`, `timeMs`, `durationMs` and an existing [effect artwork](effect-artwork.md) parameter object. Frame indices are contiguous from zero; times start at zero and exactly follow the previous duration. Durations are integer milliseconds, 1–10,000 each, with at most 60,000 total. Times are supplied explicitly, never inferred from names. Gaps, unordered/duplicate indices, implicit times and loops are rejected.

All frames share source canvas dimensions and a source-pixel center/pivot. The existing artwork validator checks each pose's radius, softness, stroke, straight-alpha RGB/opacity and transparent-border bounds. The terminal frame must have opacity zero so a one-shot sequence ends blank even if a renderer holds its last pose. There is no invented loop-seam, interpolation, spring, emission, blend-mode or gameplay-trigger policy. The low-level atlas still supports its previously declared sparse producer samples; this recipe authors a complete continuous one-shot cue.

`atlas` requires `columns` (1–8), `padding` and `extrusion` (0–8 pixels each), and boolean `trim`. The recipe computes conservative full-canvas packing dimensions before generation and rejects anything over 4096 per axis or four megapixels. Packing remains the existing ID-sorted shelf algorithm, with its logical sizes/pivots, trim offsets, alpha-aware visible bounds and edge extrusion. Frame IDs derive from the declared sequence and zero-padded explicit index; repacking preserves them and all source AssetRefs.

All poses/times/budgets validate before writes. An AbortSignal is checked before work and between awaited producer/packing stages. An already running static operation may finish its bounded in-process work and store valid immutable intermediate objects before cancellation is observed. Cancellation returns no completed sequence; previously accepted content-addressed outputs remain intact. There is no mutable sequence index, second cache or scheduler.

## Controlled fixtures and actual output

Frozen ring and puff presets supply strong, subtle and off variants, with six explicitly authored poses each. Rings use a non-square 64×48 canvas and 420ms schedule; puffs use 64×64 and 600ms. Subtle scales only the declared per-pose opacities; off keeps every pose fully transparent. These are optional visual ingredients, not a replacement for essential feedback or a claim of reduced-motion integration in a game/UI.

Run `bun examples/authored-effect-sequences/build.ts` with the configured FFmpeg codec, then `python3 examples/authored-effect-sequences/review.py` with Pillow. The example cold-replays all six sequences and 42 PNG conversions. Ignored output includes original canonical bytes, standalone source frames, atlas PNGs, original atlas manifests, editable normalized recipes and complete producer evidence. Pillow independently checks all PNG pixels and reconstructs each packed frame into its original logical canvas, comparing alpha and visible RGB exactly. Hidden RGB under alpha zero may be discarded by the existing trimming contract.

The review sheet compares source and packed reconstructions at every explicit time. Lossless animated WebP inspection files play the declared schedule once; they are disposable Pillow previews, not runtime assets or provenance-bearing generator outputs. Both the sheet and previews reconcile identical bytes on repeat. The public recipe requires no codec, Blender, model or network; PNG encoding and Pillow inspection are explicit optional example steps.

Delivery retains the original atlas manifest as a required companion to its encoded PNG. The PNG's producer records its canonical source hash. Use the existing bundle exporter's [sprite atlas PNG profile](asset-bundles.md#sprite-atlas-png-profile) to carry that pair and its original pinned canonical resource closure. `bun examples/atlas-bundle/build.ts` proves all six pairs still verify/load after deleting an independent source store. The static `static-glb-png-v1` profile continues to accept only its original GLB/PNG transports. Runtime playback and actual product integration remain with their owners.

Run `bun test test/authored-effect-sequences.test.ts test/effect-artwork-recipes.test.ts test/sprite-atlas-operations.test.ts`, then `bun run check`. Independent cardinal/non-square fixtures, exact times, cold/repacked/retimed/edited/undo results, transparent terminal/off frames, pre-write rejection and isolated cancellation-before-packing checks exercise the existing public seams. Issues #135/#136 remain open for evaluator-sampled animation, owner-validated runtime presets, distribution and actual UI/Farm/Raid Defense acceptance. Consumer repositories remain read-only.
