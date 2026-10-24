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

The logical keys are `tree.mesh`, `bush.mesh`, `grass.mesh` and `rock.mesh`. `tree.mesh` has three variants and `rock.mesh` two; the others have one. The acacia, grass tuft and boulder were added for Zoo's habitat dressing ([#359](https://github.com/moritzbrantner/asset-tooling/issues/359)).

| Key / variant | Triangles | Visual W × D × H (m) |
| --- | --- | --- |
| `tree.mesh` / `round` | 368 | 0.830 × 0.760 × 1.510 |
| `tree.mesh` / `pine` | 420 | 0.838 × 0.838 × 1.510 |
| `tree.mesh` / `acacia` | 258 | 1.089 × 0.972 × 1.280 |
| `bush.mesh` / `round` | 416 | 0.850 × 0.631 × 0.465 |
| `grass.mesh` / `tuft` | 15 | 0.258 × 0.276 × 0.230 |
| `rock.mesh` / `round` | 148 | 0.717 × 0.521 × 0.320 |
| `rock.mesh` / `boulder` | 68 | 0.743 × 0.544 × 0.500 |

The numbers are from the build of 2026-10-24; the descriptor carries the measured values of each build. The whole tar is about 70 KB.

- **`tree` / `round`:** a tapered brown trunk with a small root flare, 0.8 m tall, under a chunky crown of three leaf balls, the top one lighter.
- **`tree` / `pine`:** a short trunk under three stacked, rounded dark-green cones (the middle one lighter) and a small ball tip.
- **`bush` / `round`:** three overlapping flat-bottomed leaf domes, one lighter, with four red berries.
- **`tree` / `acacia`:** a thin trunk, 0.12 m across at the base, that forks once at 0.75 m into two leaning branches under a flat, umbrella-shaped crown of drier olive green, about 1.1 m across and 0.3 m thick, with a lighter pad on top. The crown overhangs the 1 m tile a little; the trunk stands on it. It replaces Zoo's code-built acacia (trunk 1 m, crown 1.1 m across) in the savanna habitats.
- **`grass` / `tuft`:** five open, three-sided leaf-green spikes, one upright and four leaning outwards. It is the lightest piece because Zoo repeats it the most.
- **`rock` / `round`:** a lumpy grey boulder with a lighter pebble beside it. The lumpiness is a fixed analytic function, not noise.
- **`rock` / `boulder`:** a taller, more angular six-sided grey boulder with a flat top and a lighter chip beside it.

## Look and materials

- Every shape is a lathe of a rounded profile with 3 to 12 segments, smooth-shaded with sharp edges above 48°, so the pieces read as chunky toy miniatures at the park camera. A lathe may lean (the acacia's branches, the grass blades); any vertex that would dip below the ground is set on it.
- Plain colours only, one `zoo-<name>` material per colour: `trunk`, `leaf`, `leaf-light`, `pine`, `pine-light`, `bush`, `bush-light`, `berry`, `rock`, `rock-light`, `acacia`, `acacia-light`. The palette follows Zoo's code-built scenery in `apps/web/src/park-scene.ts`, a touch brighter. There are no textures and no vertex colours; every material is opaque and factor-only.
- Each piece is one mesh node, `zoo.<kind>.<variant>.mesh`, under an empty root `zoo.<kind>.<variant>`.
- **Determinism:** there is no randomness; the geometry is built in a fixed order.

## Conventions

- **Units and axes:** metres, one Zoo tile is 1 m, +Y up, right-handed, front +Z. The pieces are nearly round, so Zoo may turn and scale them freely; its default camera looks from yaw −38°, pitch 46°.
- **Origin:** the centre of the 1 × 1 footprint on the ground (y = 0). Zoo's current code-built scenery is placed at the tile point with a per-instance scale of 0.75 to 1.6, which these pieces take as they are.

## Descriptor `zoo-scenery-descriptor-v1`

The descriptor is canonical JSON next to the tar, and [`schemas/zoo-scenery-descriptor-v1.schema.json`](../schemas/zoo-scenery-descriptor-v1.schema.json) is its schema.

| Field | Meaning |
| --- | --- |
| `schema`, `units`, `tile`, `up`, `facing`, `handedness`, `origin` | `"zoo-scenery-descriptor-v1"`, `"metre"`, `1`, `"+Y"`, `"+Z"`, `"right"`, `"footprint-ground-center"` |
| `footprint` | `{ "width": 1, "depth": 1 }`: the tile every piece stands on; only the acacia's crown overhangs it |
| `assets[]` | Each has `key`, `variant`, `role` (`tree`, `bush`, `grass` or `rock`), `triangles`, the measured `visual` size and `bounds`, and the recipe's `piece` observations. |

## Consumer use

Zoo downloads the rolling `zoo-scenery` release, pins it by the tar's SHA-256 and verifies it at build time with `bun scripts/pack-asset-bundle.ts --verify zoo-scenery.tar --ref export.ref.json` ([asset-bundles.md](asset-bundles.md#release-distribution-and-consumer-pinning)). It then replaces its procedural trees, bushes and rocks outside the fence (`apps/web/src/park-scene.ts::sceneryNodes`) with the package entries. Publishing the release is a separate, explicit step.

## Tests

`test/zoo-scenery.test.ts` runs in the hosted `blender-script` job. It checks:

- the tar and the package verify, and each entry is a self-contained GLB;
- each GLB has no textures, skins, animations or morph targets, and every material is opaque;
- the descriptor conforms to the schema;
- each piece stands on y = 0, centred on its footprint, fits one tile (the acacia within 1.2 m), is at least 0.5 m wide (the grass tuft 0.2 m) and has fewer than 1,000 triangles;
- trees are taller than bushes, bushes taller than rocks and rocks taller than grass; the grass tuft has the fewest triangles and the acacia a wide, flat crown;
- an independent rebuild packs the same tar.

Without `BLENDER_TESTS=1` and `ASSET_TOOLING_BLENDER` it skips.

## Not covered here

- the owner's visual acceptance in the real Zoo park (zoo#59);
- publishing the `zoo-scenery` release;
- the Zoo side: pinning the release and replacing its code-built scenery (zoo#59 S2).
