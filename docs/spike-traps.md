# Wooden spike traps

Hand-cut wooden stakes in six static pieces, built to the [kit standard](kit-standard.md): a cluster, a tiling row, a cheval-de-frise, a bed for the floor of a pit, a low studded board and a hanging spiked log. Each stake has bark, an axe-hewn taper and a fire-hardened tip. It is a reproducible Blender recipe, [`adapters/blender/spike_traps.py`](../adapters/blender/spike_traps.py), in one rolling release, `spike-traps` (`spike-traps.kit.tar`). It is an original procedural kit with no third-party sources. No game places it yet, and it carries no gameplay: damage, triggers and placement belong to the game.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-spike-traps.ts [--textures full|half] --out <directory>
```

[`scripts/build-spike-traps.ts`](../scripts/build-spike-traps.ts) runs the recipe once per piece and level, adds tangents and `COLOR_0`, and encodes the shared atlas to KTX2. It needs KTX-Software's `ktx` CLI, but no network, GPU or LFS payloads.

## Pieces

Metres, +Y up, right-handed, origin on the ground at the centre of the footprint, spikes towards +Z where a piece has a front. Each key is `spike-traps.kit.<piece>`. Stake feet run about 0.2 m below `y = 0`, for uneven ground.

| Piece | Footprint × height (m) | Triangles (LOD0 / lod1 / lod2) | Collision |
| --- | --- | --- | --- |
| `stake-cluster` | 1.3 × 1.3 × 1.3 | 705 / 249 / 97 | one box |
| `stake-row` | 2.0 × 1.4 × 1.6 | 811 / 215 / 91 | one box |
| `cheval` | 3.0 × 1.7 × 1.6 | 1,696 / 544 / 208 | one box |
| `pit-bed` | 1.8 × 1.8 × 1.0 | 1,556 / 548 / 212 | one box |
| `spike-board` | 1.0 × 0.7 × 0.3 | 735 / 285 / 57 | none |
| `swing-log` | 1.7 × 0.9 × 3.6 | 1,109 / 381 / 157 | one box, tagged `moving` |

- **`stake-row`** is a 2 m module along X. Its two rails end exactly on the module, so rows line up end to end (`module` in the descriptor).
- **`swing-log`** hangs on two ropes in a V from the empty node `pivot`, 3.6 m above its origin (`pivot` in the descriptor). Rotating the piece about the X axis through that node swings the log along Z.
- **`spike-board`** lies flat and declares `collision: "none"`, so characters can walk onto it.
- **Levels** end at 60 m and 180 m at the descriptor's 60° reference field of view for a piece up to 1 m across, and further out for larger pieces, in proportion to the widest side (`scaledLodDistances`, up to four times): from 60 / 180 m on `spike-board` to 180 / 540 m on `cheval`. The descriptor (the `spike-traps-descriptor` attachment on the first piece) has `lodSelection` and per-piece `lods`, in the format of the [nature bundle](greyhaven-nature-bundle.md#levels-of-detail). Lower levels use fewer sides per stake on the same atlas; lod1 and lod2 drop the rope lashings and branch stubs.

**Materials and textures:** one opaque material, `spike-wood`, on a 2048 px KTX2 atlas (colour, normal and roughness). The kit costs 1 material, 1 draw call per piece, 16 MB of texture memory and a 2.4 MB download.

## Edit

The tables at the top of the recipe set the section counts per level (`SIDES`), the atlas layout (`CELLS`), where bark gives way to hewn wood and char (`BARK_END`, `CHAR_START`) and the colours. Each piece is a short function in the `pieces` section. To see a change, run the recipe in a live Blender (for example through the Blender MCP), in its own scene:

```python
import bpy, runpy
kit = runpy.run_path("adapters/blender/spike_traps.py")
kit["use_common"](runpy.run_path("adapters/blender/kit_common.py"))
kit["build"]("cheval", bpy.context.scene.collection, level=0)
```

Delete the `spike-wood` material first when you change the atlas: it is painted once per session.

Review images are in [`review/spike-traps/`](../review/spike-traps/): `game.jpg` (the 12 m, 0.42 rad, 50° Greyhaven camera, with a 1.8 m figure for scale), `close.jpg` and `overview.jpg`.
