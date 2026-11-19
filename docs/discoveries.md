# Greyhaven discoveries

Three optional risk/reward discovery sites for Greyhaven ([#764](https://github.com/moritzbrantner/asset-tooling/issues/764), consumer [mmorpg#913](https://github.com/moritzbrantner/mmorpg/issues/913)), built to the [kit standard](kit-standard.md): the **Wolfrun hunter's cache**, the **Greyfang lookout** and the **Eastwater Fen supply cache**. Each site has an environmental clue a player can read from the game camera. It is grounded low fantasy (hunters, bandits and smugglers, no magic), the Redbrand red matching the [Redbrand faction kit](redbrand-kit.md). The kit is a reproducible Blender recipe, [`adapters/blender/discoveries.py`](../adapters/blender/discoveries.py), in one rolling release, `discoveries` (`discoveries.kit.tar`). It is an original procedural kit with no third-party sources. No game places it yet, and it carries no gameplay: discovery, loot, opening a chest and lighting the brazier belong to the game.

The issue suggested reusing redbrand-kit and fortress-kit pieces for the lookout. Neither fits a small watch post: the redbrand kit holds only the faction's figures, and the fortress modules are castle-scale masonry. The lookout's pieces are therefore new, in the Redbrand red with the band's brand on the banner and the shield.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-discoveries.ts [--textures full|half] --out <directory>
```

[`scripts/build-discoveries.ts`](../scripts/build-discoveries.ts) runs the recipe once per piece and level, adds tangents and `COLOR_0`, and encodes the shared atlas to KTX2. It takes about two minutes, and needs KTX-Software's `ktx` CLI but no network, GPU or LFS payloads.

## Pieces

Metres, +Y up, right-handed, facing +Z, origin on the ground at the centre of the footprint. Each key is `discoveries.kit.<piece>`. Pieces with a `node` are two states of one object in the same frame, with the same collision, so a consumer swaps the mesh in place.

| Piece | Site | State | Footprint × height (m) | Triangles (LOD0 / lod1 / lod2) | Collision |
| --- | --- | --- | --- | --- | --- |
| `hunter-lean-to` | hunter's cache | | 2.9 × 1.9 × 1.9 | 595 / 144 / 60 | 3 boxes |
| `hunter-chest` | hunter's cache | `hunter-chest` closed | 0.89 × 0.56 × 0.5 | 184 / 72 / 24 | 1 box |
| `hunter-chest-open` | hunter's cache | `hunter-chest` open | 0.86 × 1.29 × 0.87 | 264 / 88 / 24 | 1 box |
| `skinning-rack` | hunter's cache | | 1.86 × 0.82 × 1.86 | 574 / 160 / 68 | 1 box |
| `fire-ring` | hunter's cache | | 1.13 × 1.1 × 0.16 | 860 / 236 / 116 | none |
| `hunter-clue` | hunter's cache (clue) | | 1.13 × 1.29 × 0.13 | 280 / 83 / 23 | none |
| `lookout-platform` | lookout | | 2.6 × 2.65 × 3.3 | 576 / 152 / 68 | 8 boxes, the deck `walkable` |
| `lookout-ladder` | lookout | | 0.58 × 0.78 × 2.67 | 496 / 72 / 34 | 1 box, `ladder` |
| `signal-brazier` | lookout | `signal-brazier` unlit | 0.67 × 0.67 × 3.6 | 346 / 169 / 59 | 1 box |
| `signal-brazier-lit` | lookout | `signal-brazier` lit | 0.67 × 0.67 × 4.0 | 906 / 249 / 99 | 1 box |
| `lookout-banner` | lookout (clue) | | 0.92 × 0.13 × 3.5 | 402 / 109 / 47 | 1 box |
| `weapon-rack` | lookout | | 1.74 × 1.03 × 2.2 | 424 / 162 / 68 | 1 box |
| `fen-punt` | fen cache | | 1.18 × 4.04 × 0.54 | 292 / 116 / 52 | 1 box |
| `supply-crates` | fen cache | `supply-crates` closed | 1.63 × 0.67 × 1.17 | 228 / 96 / 36 | 3 boxes |
| `supply-crates-open` | fen cache | `supply-crates` open | 2.0 × 1.07 × 1.18 | 480 / 188 / 48 | 3 boxes |
| `fen-marker` | fen cache (clue) | | 0.56 × 0.13 × 2.15 | 66 / 25 / 11 | 1 box |

- **Wolfrun hunter's cache:** a lean-to of two forked uprights and a ridge pole, its rafters raked back to the ground under stitched hides; a plank chest bound with iron and lashed shut with rope, which open has its rope cut and lying slack, its lid back on the hinge and a rolled pelt and a pouch inside; a skinning rack with a deer hide laced into a propped pole frame; a cold fire ring of sooted stones round charred logs and ash. **The clue** is a snapped hunting bow with its string loose and a torn quiver with its arrows spilled, one of them broken.
- **Greyfang lookout:** a rough plank deck at 2.25 m (`DECK_TOP`) on four poles, X-braced, with rails on three sides and the ladder side (+Z) open, a strip of red cloth tied to a rail post; a lashed pole ladder whose top rests on the deck edge; a signal brazier, an iron basket on a stout pole, cold with charred logs or lit with glowing coals and flames. The lit state names a `light` for the consumer's point light: `[0, 3.55, 0]` in its frame, linear colour `[1, 0.55, 0.2]`. A weapon rack on the deck holds spears and axes, with a red shield against it. **The clue** is a tall pole with a tattered Redbrand banner, the band's brand dark in its middle and its foot torn into rags. The site expects to stand on a rock shelf, such as a [crag kit](crag-kit.md) or [limestone rocks](limestone-rocks.md) piece.
- **Eastwater Fen supply cache:** a flat-bottomed punt of broad planks with raked ends, swamped stern-first. Its frame's y = 0 is the water level, and its hull runs `draft` (0.49 m) under it. Three oilcloth-wrapped crates on a mud bank, tied with rope; open, the top crate is unwrapped, its oilcloth thrown back and its lid leaning against the stack, showing small casks and a bundle. **The clue** is a pole in the mud with a strip of red cloth knotted near its top. The reeds that hide the punt are the [marsh plants](greyhaven-marsh-plants.md)' `reeds-stand` and `reeds-edge`.
- **Collision:** structures carry axis-aligned `collisionProxies` boxes (`{ name, tag, center, size }`, tag `solid` unless noted) in their frame, as the [settlement props](settlement-props.md) do. The lean-to's box covers only its low back, so a character can step under the eave to the chest. The fire ring and the clue are walk-through dressing with `collision: "none"`. Posts and poles run `bury` (0.3 m) below y = 0 for uneven ground.
- **Sites:** the descriptor's `sites` lays out each site as `items` (`key`, `position`, `yaw` about +Y) and names its `clue`. These are the review layouts, not placements: the game places the pieces (mmorpg#683).
- **Levels** end at 60 m and 180 m at the descriptor's 60° reference field of view for a piece up to 1 m across, and further out for larger pieces, in proportion to the widest side (`scaledLodDistances`). `lod1` drops lashings, laces, fletching and other small dressing and thins the poles; `lod2` keeps the silhouettes. The descriptor (the `discoveries-descriptor` attachment on the first piece) has `lodSelection` and per-piece `lods`, in the format of the [nature bundle](greyhaven-nature-bundle.md#levels-of-detail).

**Materials and textures:** one opaque material, `discoveries`, on a 1024 px KTX2 atlas of colour, normal, ORM and emission. Its cells are planks, pole wood, rope, hide, oilcloth, Redbrand cloth, iron, fieldstone, charcoal, waterlogged wood, flame and embers. Only the flame and embers emit, so the lit brazier glows without a second material. Cloth and hides are two-sided geometry, not a cut-out. The kit costs 1 material, 1 draw call per piece, 5.6 MB of texture memory and a 1.8 MB download.

## Edit

The tables at the top of the recipe set the atlas layout (`CELLS`) and each cell's metres per repeat (`TILE`), the Redbrand red (`PALETTE`), pole sides per level (`SIDES`), the chest, ladder, punt and crate dimensions, the brazier's light and the site layouts (`SITES`). Each texture is a short `paint_*` function, and each piece a function in its site's section. To see a change, run the recipe in a live Blender in its own scene: exec `kit_common.py` and `discoveries.py` into two namespaces, call `use_common(common_namespace)`, then `build(piece, collection, level, location, yaw)`. Don't call `generate` there, since it clears the scene.

## Review

Game-camera review images of each assembled site, and the three two-state pieces side by side, are in [`review/discoveries/`](../review/discoveries/). They are rendered by [`scripts/review-discoveries.py`](../scripts/review-discoveries.py) on stand-in ground, water and reed cards that don't ship:

```sh
<blender 5.2.2> -b --factory-startup -P scripts/review-discoveries.py -- --out review/discoveries
```
