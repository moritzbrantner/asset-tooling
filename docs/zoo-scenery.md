# Toy zoo scenery

This is the build recipe for Zoo's scenery outside the park fence ([#357](https://github.com/moritzbrantner/asset-tooling/issues/357), consumer [zoo#59](https://github.com/moritzbrantner/zoo/issues/59) slice S2 and [zoo#86](https://github.com/moritzbrantner/zoo/issues/86)). The owner answer of 2026-10-24 on zoo#59 is:

- **Format:** a small, flat-colour, toy-style set in the [`farm-structures`](farm-structures.md) format, loaded through 3d-lab's existing untextured `three-d-renderer/static-glb` adapter with no 3d-lab change.
- **Source:** a reproducible procedural Blender recipe, [`adapters/blender/zoo_scenery.py`](../adapters/blender/zoo_scenery.py). It uses no imported meshes, no third-party assets and no textures.
- **Release:** one rolling release, `zoo-scenery` (Atlas Decision 7.1.5), never a numbered one.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-zoo-scenery.ts --out <directory>
```

[`scripts/build-zoo-scenery.ts`](../scripts/build-zoo-scenery.ts) runs `external.blender.script@1` once per piece and checks each GLB through `scene.import.gltf@2` with no validator exceptions. It writes:

- `<directory>/bundle/`: a `static-glb-png-v1` package (`asset.bundle@1`) of self-contained GLBs;
- `<directory>/zoo-scenery.tar` and `.sha256`: the packed package;
- `<directory>/zoo-scenery.descriptor.json`: the measured descriptor;
- `<directory>/export.ref.json` and `lineage.json`.

The build takes about fifteen seconds and needs no network, no LFS payloads and no GPU. A rebuild packs the same tar bytes. Snap Blender can only read and write under `$HOME`, so set `TMPDIR` to a directory there.

`zoo_scenery.build(kind, variant, collection, location)` also runs in a live Blender session, for example through the Blender MCP, to look at the pieces or lay out a review scene.

## Pieces

The logical keys are `tree.mesh`, `bush.mesh`, `grass.mesh` and `rock.mesh`. `tree.mesh` and `rock.mesh` have three variants each; the others have one. The acacia, grass tuft and boulder were added for Zoo's habitat dressing ([#359](https://github.com/moritzbrantner/asset-tooling/issues/359)), and the flat slab completes the rounded, angular and flat rock family ([#132](https://github.com/moritzbrantner/asset-tooling/issues/132)).

| Key / variant | Triangles | Visual W × D × H (m) |
| --- | --- | --- |
| `tree.mesh` / `round` | 368 | 0.830 × 0.760 × 1.510 |
| `tree.mesh` / `pine` | 420 | 0.838 × 0.838 × 1.510 |
| `tree.mesh` / `acacia` | 258 | 1.089 × 0.972 × 1.280 |
| `bush.mesh` / `round` | 416 | 0.850 × 0.631 × 0.465 |
| `grass.mesh` / `tuft` | 15 | 0.258 × 0.276 × 0.230 |
| `rock.mesh` / `round` | 148 | 0.717 × 0.521 × 0.320 |
| `rock.mesh` / `boulder` | 68 | 0.743 × 0.544 × 0.500 |
| `rock.mesh` / `flat` | 92 | 0.937 × 0.679 × 0.171 |
| `fence.mesh` / `wood` | 88 | 1.000 × 0.092 × 0.550 |
| `fence.mesh` / `steel` | 208 | 1.000 × 0.062 × 1.000 |
| `fence.mesh` / `boundary` | 160 | 1.000 × 0.212 × 0.600 |
| `fence.mesh` / `post-wood` | 32 | 0.080 × 0.092 × 0.550 |
| `fence.mesh` / `post-steel` | 32 | 0.050 × 0.062 × 1.000 |
| `fence.mesh` / `post-boundary` | 32 | 0.120 × 0.212 × 0.600 |
| `gate.mesh` / `service` | 168 | 0.980 × 0.100 × 0.655 |
| `bench.mesh` / `park` | 156 | 0.720 × 0.290 × 0.400 |
| `sign.mesh` / `education` | 60 | 0.560 × 0.110 × 0.685 |
| `sign.mesh` / `post` | 44 | 0.420 × 0.085 × 0.700 |
| `pond.mesh` / `edge` | 168 | 0.962 × 0.243 × 0.115 |
| `pond.mesh` / `corner` | 84 | 0.233 × 0.255 × 0.110 |
| `pond.mesh` / `reeds` | 53 | 0.286 × 0.254 × 0.396 |

The numbers are from the builds of 2026-10-24 and, for the park pieces, 2026-11-12; the descriptor carries the measured values of each build. The whole tar is about 175 KB.

- **`tree` / `round`:** a tapered brown trunk with a small root flare, 0.8 m tall, under a chunky crown of three leaf balls, the top one lighter.
- **`tree` / `pine`:** a short trunk under three stacked, rounded dark-green cones (the middle one lighter) and a small ball tip.
- **`bush` / `round`:** three overlapping flat-bottomed leaf domes, one lighter, with four red berries.
- **`tree` / `acacia`:** a thin trunk, 0.12 m across at the base, that forks once at 0.75 m into two leaning branches under a flat, umbrella-shaped crown of drier olive green, about 1.1 m across and 0.3 m thick, with a lighter pad on top. The crown overhangs the 1 m tile a little; the trunk stands on it. It replaces Zoo's code-built acacia (trunk 1 m, crown 1.1 m across) in the savanna habitats.
- **`grass` / `tuft`:** five open, three-sided leaf-green spikes, one upright and four leaning outwards. It is the lightest piece because Zoo repeats it the most.
- **`rock` / `round`:** a lumpy grey boulder with a lighter pebble beside it. The lumpiness is a fixed analytic function, not noise.
- **`rock` / `boulder`:** a taller, more angular six-sided grey boulder with a flat top and a lighter chip beside it.
- **`rock` / `flat`:** a low, wide seven-sided slab with a bevelled rim, tilted 5° so it doesn't read as a paving tile, and a thin lighter chip beside it. It is the widest rock and lower than the grass tuft, for stepping stones, pond edges and the ground between boulders.

### Park pieces

The park pieces ([#625](https://github.com/moritzbrantner/asset-tooling/issues/625), consumer [zoo#190](https://github.com/moenarch-games/zoo/issues/190)) replace Zoo's code-built habitat fences, park boundary, service gates, benches, signs and pond edges. Their keys are `fence.mesh`, `gate.mesh`, `bench.mesh`, `sign.mesh` and `pond.mesh`. Zoo still draws its own previews, highlights, badges and glyphs over them.

- **Fence segments** (`wood`, `steel`, `boundary`) span exactly one 1 m tile edge along X, from x = −0.5 to 0.5, centred on the edge. Each one carries **half a post at each end**, so neighbouring segments share one whole post and two segments meeting at a corner close it. Zoo turns them by 90° for east and west edges.
  - `wood`: two warm-brown rails at about 0.2 and 0.42 m, between square posts with pointed caps, 0.55 m tall.
  - `steel`: grey galvanised low, mid and top rails with nine thin vertical bars between them, 1 m tall. The bars are opaque but thin, so the animals stay visible through the fence.
  - `boundary`: the park perimeter, a 0.2 m stone wall with a lighter coping under a hedge-green railing with four balusters, between stone posts with lighter caps, 0.6 m tall.
- **Full posts** (`post-wood`, `post-steel`, `post-boundary`) are the whole post of each fence, for the open end of a run. Two segments already close a turned corner on their own, so these are optional.
- **`gate` / `service`:** a keeper gate that takes one segment's place: two wooden posts under a lintel and a closed leaf of dark planks with two ledges, a diagonal brace and steel hinges, 0.98 m wide and 0.655 m tall.
- **`bench` / `park`:** three seat slats and two back slats in wood on dark metal side frames, 0.72 × 0.29 × 0.4 m, facing +Z.
- **`sign` / `education`:** a plain cream board, about 0.47 × 0.25 m in a dark wooden frame, on two posts under a small top rail at 0.685 m, facing +Z.
- **`sign` / `post`:** a small signpost with a plain yellow 0.42 × 0.24 m board, its top at 0.7 m, facing +Z.
- **`pond` / `edge`:** four rounded rim stones, grey and lighter grey, along one water-tile edge, centred on that edge, at most 0.115 m tall.
- **`pond` / `corner`:** a rim stone and a small pebble, about 0.25 m across, that close an outer corner.
- **`pond` / `reeds`:** five open three-sided reed blades and two cattails on thin stalks, about 0.29 m across and 0.4 m tall, for dressing the water at a seeded, bounded density.

## Look and materials

- The natural pieces are lathes of a rounded profile with 3 to 12 segments, smooth-shaded with sharp edges above 48°, so they read as chunky toy miniatures at the park camera. A lathe may lean (the acacia's branches, the grass and reed blades); any vertex that would dip below the ground is set on it. The fences, gate, bench and signs are flat-shaded blocks, and the pond stones and reeds reuse the lathes.
- Plain colours only, one `zoo-<name>` material per colour: `trunk`, `leaf`, `leaf-light`, `pine`, `pine-light`, `bush`, `bush-light`, `berry`, `rock`, `rock-light`, `acacia`, `acacia-light`, and for the park pieces `wood`, `wood-dark`, `steel`, `iron` (the bench frames), `hedge`, `board`, `sign-yellow`, `reed` and `cattail`; the stone parts reuse `rock` and `rock-light`. The palette follows Zoo's code-built scenery in `apps/web/src/park-scene.ts`, a touch brighter. There are no textures and no vertex colours; every material is opaque and factor-only.
- Each piece is one mesh node, `zoo.<kind>.<variant>.mesh`, under an empty root `zoo.<kind>.<variant>`.
- **Determinism:** there is no randomness; the geometry is built in a fixed order.

## Conventions

- **Units and axes:** metres, one Zoo tile is 1 m, +Y up, right-handed, front +Z. The natural pieces are nearly round, so Zoo may turn and scale them freely. Fence, gate and pond-edge pieces run along X on the tile edge and are turned only by multiples of 90°; benches and signs face +Z. Its default camera looks from yaw −38°, pitch 46°.
- **Origin:** the centre of the 1 × 1 footprint on the ground (y = 0). Zoo's current code-built scenery is placed at the tile point with a per-instance scale of 0.75 to 1.6, which these pieces take as they are.

## Descriptor `zoo-scenery-descriptor-v2`

The descriptor is canonical JSON next to the tar, and [`schemas/zoo-scenery-descriptor-v2.schema.json`](../schemas/zoo-scenery-descriptor-v2.schema.json) is its schema. Version 2 adds the park roles to the `role` enum; the v1 schema stays as published.

| Field | Meaning |
| --- | --- |
| `schema`, `units`, `tile`, `up`, `facing`, `handedness`, `origin` | `"zoo-scenery-descriptor-v2"`, `"metre"`, `1`, `"+Y"`, `"+Z"`, `"right"`, `"footprint-ground-center"` |
| `footprint` | `{ "width": 1, "depth": 1 }`: the tile every piece stands on; only the acacia's crown overhangs it |
| `assets[]` | Each has `key`, `variant`, `role` (`tree`, `bush`, `grass`, `rock`, `fence`, `gate`, `bench`, `sign` or `pond`), `triangles`, the measured `visual` size and `bounds`, and the recipe's `piece` observations. |

## Consumer use

Zoo downloads the rolling `zoo-scenery` release, pins it by the tar's SHA-256 and verifies it at build time with `bun scripts/pack-asset-bundle.ts --verify zoo-scenery.tar --ref export.ref.json` ([asset-bundles.md](asset-bundles.md#release-distribution-and-consumer-pinning)). It then replaces its procedural trees, bushes and rocks outside the fence (`apps/web/src/park-scene.ts::sceneryNodes`) with the package entries, and its code-built fences, gates, benches, signs and pond edges with the park pieces (zoo#190). CI publishes it when a change to its recipe merges ([Publishing a rolling release](../README.md#publishing-a-rolling-release)).

## Review images

`review/zoo-scenery/game.jpg` shows the park pieces from Zoo's default camera (yaw −38°, pitch 46°) beside the existing scenery: a wood habitat with a service gate, a steel habitat, a boundary run, a bench, both signs and a pond with rim stones and reeds. `close.jpg` is a close-up of the gate, the education sign, the bench and the boundary.

## Tests

`test/blender/kits/zoo-scenery.test.ts` runs in the hosted `blender-script` job. It checks:

- the tar and the package verify, and each entry is a self-contained GLB;
- each GLB has no textures, skins, animations or morph targets, and every material is opaque;
- the descriptor conforms to the schema;
- each piece stands on y = 0, centred on its footprint, fits one tile (the acacia within 1.2 m) and has fewer than 1,000 triangles, and each natural piece is at least 0.5 m wide (the grass tuft 0.2 m);
- trees are taller than bushes, bushes taller than the standing rocks and those taller than grass; the grass tuft has the fewest triangles and the acacia a wide, flat crown;
- the rocks have distinct silhouettes: height to width rises from the flat slab through the round rock to the boulder, and the slab is the widest;
- each park piece has its size range and a triangle budget near the round rock's; fence segments and the pond edge span x −0.5 to 0.5, and each full post is as tall as its fence;
- an independent rebuild packs the same tar.

Without `BLENDER_TESTS=1` and `ASSET_TOOLING_BLENDER` it skips.

## Not covered here

- the owner's visual acceptance in the real Zoo park (zoo#59, zoo#190);
- publishing the `zoo-scenery` release;
- the Zoo side: pinning the release and replacing its code-built scenery and park pieces (zoo#59 S2, zoo#190).
