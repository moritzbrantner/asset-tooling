# Woodland bushes

Dark woodland-edge shrubs for mmorpg ([#532](https://github.com/moritzbrantner/asset-tooling/issues/532)), built to the [kit standard](kit-standard.md). It is one habitat on purpose: plants from other habitats, such as ferns, belong in another area's set. It is a reproducible Blender recipe, [`adapters/blender/woodland_bushes.py`](../adapters/blender/woodland_bushes.py), in one rolling release, `woodland-bushes` (`woodland-bushes.kit.tar`). No game places it yet.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-woodland-bushes.ts [--textures full|half] --out <directory>
```

[`scripts/build-woodland-bushes.ts`](../scripts/build-woodland-bushes.ts) runs the recipe once per piece, imports each GLB through `scene.import.gltf@2`, places it on its footprint, makes `lod1` and `lod2` with [`nature_lod.py`](../adapters/blender/nature_lod.py), encodes the atlas to KTX2 and packs the tar with `lineage.json`, `descriptor.json` and `export.ref.json`. It needs KTX-Software's `ktx` CLI, but no network, LFS payloads or GPU. Snap Blender reads and writes only under `$HOME`, so set `TMPDIR` there.

## Pieces

Metres, +Y up, right-handed, origin at the centre of the footprint on the ground. Each key is `woodland-bushes.kit.<kind>-<1|2>`; the two variants of a kind differ only in shape. The game scales and turns each placement.

| Kind | Width × depth × height (m) | Leaf | Fruit |
| --- | --- | --- | --- |
| `hazel` | 2.9 × 2.7 × 1.7 | broad | none |
| `holly` | 1.9 × 1.9 × 2.1 | spiked, darkest | red berries |
| `bramble` | 2.2 × 2.2 × 1.05 | small | dark red berries |
| `hawthorn` | 3.2 × 2.8 × 2.0 | small, lobed | white blossom |
| `juniper` | 1.4 × 1.4 × 2.4 | needles | none |
| `elder` | 2.6 × 2.6 × 2.1 | long, narrow | none |

Each piece has 660–760 triangles at full detail, with `lod1` at most half of that and `lod2` a 120-triangle opaque hull. Full detail ends at 60 m and `lod1` at 180 m, measured at the descriptor's 60° reference field of view, the same for every size of bush (`WOODLAND_BUSH_LOD_DISTANCES`). The descriptor (the `woodland-bushes-descriptor` attachment on the first piece) has `lodSelection` and per-piece `lods`, in the format of the [nature bundle](greyhaven-nature-bundle.md#levels-of-detail).

**Materials and textures:** one cut-out material, `Leaves_Bush_Woodland`, on a 1024 px KTX2 atlas, and one opaque untextured core, `Leaves_Core_Woodland`. The full kit costs 2 materials, 1.4 MB of texture memory and a 1.5 MB download. The atlas is greyscale and every card's colour comes from `COLOR_0`. Its leaves are generated, because the catalog has only one broadleaf cluster and a fir sprig.

**Collision:** none. These are walk-through foliage, so every piece declares `collision: "none"` and the game decides whether any placement should block.

## Edit

Sizes, leaf shapes, card counts and colours are in the tables at the top of the recipe. `test/blender/kits/woodland-bushes.test.ts` checks the bundle, frames, LODs and cost limit. Review images are in [`review/woodland-bushes/`](../review/woodland-bushes/), from the 12 m, 0.42 rad pitch, 50° Greyhaven camera.
