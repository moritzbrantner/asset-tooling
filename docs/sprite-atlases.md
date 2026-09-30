# Deterministic sprite atlas assembly

`asset-tooling/operations/image/atlas` provides `image.sprite-atlas@1` over existing canonical straight-alpha sRGB RGBA8 AssetRefs. Generate or decode each selected sprite independently, then pack only that selection. The operation neither acquires resources nor evaluates vector animation.

```ts
import { executeSpriteAtlasOperation } from "asset-tooling/operations/image/atlas";

const result = await executeSpriteAtlasOperation(absoluteStoreRoot, {
  parameters: {
    width: 256, maxHeight: 256, padding: 2, extrusion: 1, trim: true,
    sprites: [
      { id: "target", pivot: { x: 32, y: 32 } },
      { id: "player", pivot: { x: 32, y: 32 } },
    ],
  },
  inputs: { sprites: [targetRgba8Ref, playerRgba8Ref] },
});
// result.outputs.image: canonical RGBA8 AssetRef
// result.outputs.manifest: sprite-atlas JSON AssetRef
// Encode image through the existing image.encode.png@1 operation when needed.
```

Declarations and input refs are paired by array position, then sorted together by code-unit sprite ID for build identity and shelf placement. IDs are unique portable lowercase tokens up to 128 characters. Reordering paired declarations/refs produces the same build identity and output bytes. Changing the selection or atlas width may change rectangles; sprite IDs, source content identities, source dimensions and logical pivots remain intact. The source objects are hash/length-verified before packing on every invocation, including repeated builds. Existing object-store reconciliation reuses identical stored outputs without rewriting them; this operation currently recomputes packing and pixels rather than maintaining another computation cache.

Widths and maximum heights are integers in 1–4096. There are 1–512 selected sprites, at most 16 megapixels of combined source images, and at most 96 MiB per encoded canonical source. Padding and extrusion each accept 0–32 pixels. Each packed cell reserves `padding + extrusion` on every side. The content rectangle excludes both. Extrusion copies the nearest content edge and corner bytes without alpha conversion or color resampling; padding stays transparent black. Atlas width is fixed and its height is the occupied shelf height, bounded by maxHeight. Oversized cells or overflow fail before writing outputs. This is a stable shelf packer, not an optimal bin packer; it does not rotate, rescale or silently allocate another page.

The manifest records top-left pixel coordinates, image reference/dimensions, alpha/color conventions, padding/extrusion and sorted entries. Each entry includes the original source ref (lineage), sourceSize, rect, trimOffset, pivot, empty and `rotated: false`. Pivots are finite pixel positions in the **original logical source**, including fractional positions and boundary coordinates. For a draw operation, place the trimmed rectangle at `trimOffset - pivot` relative to its logical anchor. To restore the logical canvas, allocate sourceSize and copy rect pixels at trimOffset. Do not treat a trimmed rectangle as the logical sprite size.

Trimming retains every pixel whose alpha is greater than zero, including faint edge pixels. Fully transparent outer pixels and their hidden RGB are discarded. With trim disabled, all original bytes remain. A fully transparent trimmed source becomes one zero-filled pixel with `empty: true`, while its logical sourceSize/pivot remain unchanged; skip its draw. Both canonical transport and PNG output are straight-alpha sRGB. Samplers and mip derivation remain consumer/texture-processor responsibilities; this packer does not guarantee arbitrary mip levels are isolated by a one-pixel gutter.

Optional producer-supplied `frame` metadata records a sequence token, integer index (0–1,000,000), timeMs (0–86,400,000), positive durationMs (1–86,400,000) and loop boolean. Within a sequence, indices must be unique, index order must agree with non-overlapping sample intervals, and loop policy must match. Sparse selected indices/time gaps are supported. ID order and filenames have no timing meaning: consumers explicitly select by sequence/index/time. The operation does not fill gaps, infer an omitted loop duration or pretend a sparse selection is a complete playable clip.

## Actual output example

Run `bun examples/sprite-atlas/build.ts` with the existing FFmpeg PNG encoder available. Paths derive from the example module, independent of caller working directory. It composes the existing rounded-rectangle/circle SDF, levels, scalar color-ramp and alpha-mask operations into independently reusable floor/wall/crate/player/target sprites, then packs them. The target uses a ring, the crate a square and the player a filled circle to retain non-color distinctions. Outputs under ignored `.artifacts/sprite-atlas/` include five standalone transparent PNGs, atlas PNG, canonical atlas manifest and operation/codec build evidence. Repeated runs reconcile unchanged files.

`python scripts/render-sprite-atlas.py` uses Pillow only for offline inspection. It reads the actual PNG atlas and generated trim metadata, checks visible-pixel/alpha equality against standalone PNGs, and renders broad/narrow board previews plus a standalone token on light/dark backgrounds. It does not author the canonical assets or establish exact preview-pixel replay. The canonical manifest's image ref names RGBA8; atlas.png is a separately recorded codec derivative in evidence.json. This example is not a distribution package or a replacement for #125's packaging boundary.

This is the atlas slice of #135. Editable SVG raster derivation, the wider artwork vocabulary, a public authored frame producer, consumer package delivery, and actual puzzle/UI integration remain follow-ups. The board is an inspection fixture with no gameplay rules. The existing UI RewardBurst accepts children and keeps motion/accessibility ownership; this slice does not modify it or claim consumer acceptance.
