# Static effect ingredients

`asset-tooling/recipes/effect-artwork` generates a soft puff or ring as a standalone canonical RGBA8 `AssetRef`, plus its opaque grayscale alpha mask. `image.procedural.effect-artwork@1` composes the existing circle SDF, levels, convolution, channel-combination/extraction and alpha-mask kernels. No particle evaluator, frame sampler or runtime preset is introduced.

```ts
import { EFFECT_ARTWORK_PRESETS, createEffectArtworkBuildIdentity, executeEffectArtwork } from "asset-tooling/recipes/effect-artwork";
const invocation = { parameters: EFFECT_ARTWORK_PRESETS.ring.subtle };
const build = await createEffectArtworkBuildIdentity(absoluteObjectStoreRoot, invocation);
const result = await executeEffectArtwork(absoluteObjectStoreRoot, invocation);
// result.outputs.image and .mask are the existing content-addressed AssetRefs.
```

There are no source inputs, downloads or hidden environment controls. The build identity records the operation, complete parameters, composition algorithm and authored-tool identity. Output metadata retains that implementation/parameter evidence and the logical pivot. Execution always recomputes the pixels; the existing object store reconciles equal bytes. Store reuse is not a verification claim. Cold-store tests compare actual rebuilt bytes and refs independently of existing outputs.

## Controls and pixel contract

All fields are explicit. Unknown/missing fields fail before object writes.

| Field | Meaning and bounds |
| --- | --- |
| `shape` | `puff` or `ring`; ring additionally requires `stroke`, puff rejects it |
| `width`, `height` | Canvas pixels, each 9–256; non-square canvases are supported |
| `centerX`, `centerY` | Integer pixel-coordinate center and logical pivot, top-left origin, X right/Y down |
| `radius` | Integer outer fully covered radius, 1–128 pixels |
| `softness` | Integer transition distance, 1–64 pixels; outside coverage falls to zero at `radius + softness` |
| `color` | Three sRGB code-value bytes, 0–255; RGB is constant even in fully transparent pixels |
| `opacity` | Peak straight alpha as UNORM8, 0–255 |
| `stroke` | Ring only: integer solid-band thickness, 1–`radius - 1`; inner radius is `radius - stroke` |

`radius + softness` must fit between the center and all four outer pixel rows/columns. The outer border is therefore transparent. A ring's inner radius must be at least `softness`, so its center is transparent. Its inner transition runs from zero coverage at `inner radius - softness` to full coverage at `inner radius`.

The existing SDF measures floored integer Euclidean distance, encodes its zero boundary as 128 and rounds signed distance to UNORM8. Outer levels map 128–255, followed by the existing one-pixel `-1 / 1 + 255` convolution to invert coverage. Inner levels map 1–128. Existing alpha-mask multiplication rounds each UNORM8 stage separately. This quantization is intentional: half of a four-pixel outer transition at opacity 200 is alpha 99, not an unquantized floating-point 100. Independent non-square cardinal fixtures pin the exact samples. Straight-alpha RGB remains unattenuated, avoiding a premultiplied fringe when decoded correctly.

The mask repeats final alpha in RGB with opaque alpha. Its `sampling: data` and `channelColorSpace: linear` metadata distinguish those scalar bytes from sRGB color sampling; the canonical RGBA8 container retains its existing sRGB/straight-alpha transport contract. A mask includes the declared opacity, so it can directly reproduce final coverage.

The 256×256 cap bounds each output to 262,144 raw pixel bytes; a recipe produces two images and uses a fixed number of bounded in-memory transforms. Symmetric static artwork has no randomness, so there is no ineffective seed field.

## Example and variants

```bash
bun examples/effect-artwork/build.ts
python3 examples/effect-artwork/review.py
```

The example writes six standalone PNGs (puff/ring × subtle/strong/off), one PNG atlas, its existing sprite-atlas manifest and operation evidence under ignored `.artifacts/effect-artwork/`. PNG derivation uses the existing explicit FFmpeg codec identity. Artwork, encoder and atlas stages are each replayed and compared by their output content hashes. Repeating the example preserves unchanged files. The review board shows actual PNG pixels against light, dark and checkerboard backgrounds.

Presets use 64×64 canvases and immutable explicit colors/geometry. Subtle opacity is 96; strong is 255; off is zero. The atlas has stable logical IDs/pivots, existing transparent trim/edge extrusion and source lineage. Each ingredient is usable without the atlas. These six variants are static artwork, not animation frames: they have no fabricated frame times, durations or loop metadata.

Consumers retain admission, time origin, opacity/size curves, blending, lifetime, cancellation, coalescing and resource disposal. An off setting should suppress cosmetic admission; its transparent image is an inspectable export alternative. Reduced-motion presentation can select a static ingredient or omit the cue using the owning UI/game policy. Essential state must remain visible independently of cosmetics.

## Remaining #136 work

Owner-specific validated presets, fixed-time burst baking, source-versus-baked comparison, leaves/sparks/marks, real UI reward and Raid Defense/Farm acceptance remain open. The evaluator belongs to the existing UI motion provider or shared renderer (3d-lab#85). Flat Stories artwork/export remains producer-owned (flat-stories#48 / #137). Static ingredients do not prove motion lifecycle, cancellation or consumer integration. Consumer repositories are read-only in this loop.
