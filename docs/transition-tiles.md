# Grass/soil corner transition tiles

`asset-tooling/recipes/transition-tiles` produces a complete finite two-color 2D family from the existing integer circle SDF, levels, convolution, mask and channel kernels. It generates original opaque artwork, not terrain, a map, fence geometry or game placement decisions.

```ts
import {
  TRANSITION_TILE_PRESET, executeTransitionTileKit,
  readTransitionTileConnection, canConnectTransitionTiles,
} from "asset-tooling/recipes/transition-tiles";

const kit = await executeTransitionTileKit(absoluteSpecDirectory, TRANSITION_TILE_PRESET);
const first = kit.tiles[0]!.image;
const connection = readTransitionTileConnection(first);
const compatible = canConnectTransitionTiles(first, kit.tiles[1]!.image, "east");
```

Recipe v1 requires exactly `schemaVersion: 1`, square `size` in 17..128 pixels, and distinct three-byte `soil` and `grass` sRGB palettes. Colors are shared across the family. There is no ambient seed, stochastic texture, implied world-meter scale or editable vector claim. All tiles occupy one square cell with a top-left origin `[0, 0]`, axes right/down, and pixel pivot `{x: 0, y: 0}` when packed by the example.

## Finite connection contract

Every original sprite `AssetRef.metadata.connection` carries family `grass-soil-corners-v1`, schema version, stable piece ID, corner code, dimensions, units/origin, ordered ports, palette and orientation permissions. The code is four bits in **NW, NE, SE, SW** order; `0` is soil and `1` is grass. IDs are `corners.0000` through `corners.1111`. This is the original ref's metadata, preserved inside the existing atlas format and its bundle resource closure; there is no second asset identity or connection manifest.

North and south ports run left→right; east and west run top→bottom. For example `corners.1000` has north `10`, east `00`, south `00`, west `10`. Opposing ports connect when their ordered two-bit strings, pixel/cell dimensions and complete palettes agree. Do not reverse the south or west strings as if they followed a clockwise perimeter.

All sixteen combinations are supported: uniform tiles, four single-corner patches, four three-corner patches with a soil cutout, four adjacent-corner borders, and two diagonal junction patterns. The junction topology is explicitly the composition of the grass-corner circle coverages; it is cosmetic and does not define traversal or habitat membership. Clockwise quarter-turns 0..3 are supported by `transformTransitionCorners(code, {quarterTurns, mirror: false})`. Mirroring is deliberately unsupported. Pixel rotation uses the established image transform processor. Atlas assembly itself continues to forbid rotated packing.

`readTransitionTileConnection` validates the complete serialized original ref and the family description, including derived ports, dimensions, palette, origin and orientation permissions. This checks declarations; actual pixel integrity still requires the existing object resolver or verified package. `findTransitionTile(originalRefs, code)` admits a bounded selected family, rejects duplicate IDs/incompatible dimensions or palettes, and diagnoses an absent combination. Both APIs can read the original sprite refs from a loaded atlas without access to the producer store.

## Sampling, identity and reconciliation

Each tile samples four corner circle fields at pixel coordinates 0..`size - 1`. Radius is `floor(3 × (size - 1) / 4)` and softness is `max(1, floor((size - 1) / 32))`. The far corners have zero contribution at a shared boundary. Selected corner coverages are combined through the existing rounded complement-mask product and mapped to sRGB palette bytes; alpha is always 255. The recipe uses four bounded SDF fields per tile and linear work in selected tiles × pixel count. It adds no pixel loop or rasterizer.

`image.procedural.transition-tile@1` build identities include the normalized individual controls and current tool implementation fingerprint. Selecting/reordering other pieces or changing atlas packing cannot change a tile's full original ref. A single family execution captures that fingerprint once. The family accepts an optional `corners` selection of 1..16 unique codes, sorted before execution; validation precedes generation and cancellation is observed between operations.

Full execution remains an independent replay. Repeated calls recompute pixels and reuse only content-addressed objects after verifying their bytes. `execution` reports tile operations, pixels generated, objects/bytes written, and verified existing objects; it never reports skipped raster work as cache reuse. Changing a shared palette changes the family. Changing a selection preserves unaffected tile identities. Standard atlas and bundle operations own packing, resource closure and recoverable export.

## Reproducible output and visual evidence

```sh
bun examples/transition-tiles/build.ts
python3 examples/transition-tiles/review.py
bun test test/transition-tile-recipes.test.ts
bun run check
```

The example generates all sixteen original pieces and packs only the twelve needed for an independently authored 4×4 island with an inner soil corner. It also repacks those originals in a narrower atlas. It verifies cold full output/build/ref parity, subset object reuse, unchanged source identities under repacking, the authored connections, and package-only loading after deleting a separate producer store. The selected bundle contains its original atlas, paired PNG, original atlas image, and exactly twelve original sprite resources. Other generated pieces are excluded from the distribution.

The Pillow inspector verifies SHA-256/length pins for declared review inputs, independently reconstructs every PNG sprite and its extrusion against the original canonical pixels, and checks transparent padding. An authored expected port table admits exactly 256 compatible directed boundaries across all sixteen tile pairs; the inspector compares the actual edge pixels and rejects incompatible ports. It shows the complete set and the selected composition at 16, 32 and 65 pixels per tile with bilinear filtering. The inspector removes stale review output on failure. Native pixel tests also compare palette/softness math against a scalar oracle and exercise quarter-turn composition at odd/even sizes.

These are flat two-color foundations. There are no textured ground variants, normal maps, generated mip levels, 3D fence anchors, or consumer gameplay acceptance in this slice. The actual puzzle gallery work remains `puzzle-game-core#15`; Zoo habitat/presentation work remains `zoo#86`. Both remain consumer-owned and read-only in this repository loop. Issue #143 remains open for those acceptance paths and the 3D modular kit.
