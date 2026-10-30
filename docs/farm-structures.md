# Toy-like farm structures

This is the build recipe for My Farm's Farmhouse and Silo ([#353](https://github.com/moritzbrantner/asset-tooling/issues/353), consumer [my-farm#234](https://github.com/moritzbrantner/my-farm/issues/234), my-farm Atlas Decision 1.2.2: colourful, toy-like 3D). The owner answers of 2026-10-22 on my-farm#234 are:

- **Source:** a reproducible procedural Blender recipe in asset-tooling, [`adapters/blender/farm_structures.py`](../adapters/blender/farm_structures.py). It uses no imported meshes, no third-party assets and no textures.
- **Look:** bright toy. Rounded, chunky shapes, a saturated red and white farmhouse with a dark roof, and a pale silo with a dome.
- **Footprint:** generous. The visuals may be up to about 40 % bigger than the gameplay footprint, even if they overlap their neighbours. Gameplay occupancy, picking and pathfinding stay unchanged in My Farm.
- **Release:** one rolling release, `farm-structures` (Atlas Decision 7.1.5), never a numbered one.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-farm-structures.ts --out <directory>
```

[`scripts/build-farm-structures.ts`](../scripts/build-farm-structures.ts) runs `external.blender.script@1` once per structure and checks each GLB through `scene.import.gltf@2` with no validator exceptions. It writes:

- `<directory>/bundle/`: a `static-glb-png-v1` package (`asset.bundle@1`) of self-contained GLBs, the profile My Farm already stages for its crops;
- `<directory>/farm-structures.tar` and `.sha256`: the packed package;
- `<directory>/farm-structures.descriptor.json`: the measured descriptor;
- `<directory>/export.ref.json` and `lineage.json`.

The build takes about ten seconds and needs no network, no LFS payloads and no GPU. A rebuild packs the same tar bytes. Snap Blender can only read and write under `$HOME`, so set `TMPDIR` to a directory there.

`farm_structures.build(part, collection, location)` also runs in a live Blender session, for example through the Blender MCP, to look at the structures or lay out a review scene.

## Structures

| Key / variant | Triangles | Visual W × D × H (m) | Gameplay footprint |
| --- | --- | --- | --- |
| `farmhouse.mesh` / `toy` | 8,424 | 2.307 × 2.390 × 2.185 | 2 × 2 tiles |
| `silo.mesh` / `toy` | 5,232 | 1.760 × 1.760 × 2.740 | 2 × 2 tiles |

The numbers are from the build of 2026-10-24; the descriptor carries the measured values of each build.

- **`farmhouse`:** a red house, 1.7 m wide and 1.8 m deep, with 1 m walls, on a pale stone plinth. White corner posts, eave trims and bargeboards frame it. The ridge of its dark slate gable roof runs front to back, so its front gable faces the camera with a red door, two windows and a round attic window. A white chimney stands on the back half of the right slope. Each long side has two windows, the back one. A stone step stands before the door.
- **`silo`:** a pale cream silo, 1.48 m across, on a stone ring. Three pale blue-grey hoops and a wider rim band circle it. A pale grey dome tops it with a red cap and a vent knob. A red hatch with a white frame faces the front, and a dark ladder runs up its front right.

## Look and materials

- Every shape is a beveled box or a lathe of a rounded profile, so edges catch the light like a toy.
- Plain colours only, one `farm-<name>` material per colour: `red`, `white`, `roof`, `glass`, `door`, `stone`, `cream`, `hoop`, `dome`, `dark`. There are no textures and no vertex colours.
- Each structure is one mesh node, `farm.<part>.mesh`, under an empty root `farm.<part>`.
- **Determinism:** there is no randomness; the geometry is built in a fixed order.

## Conventions

- **Units and axes:** metres, one My Farm tile is 1 m, +Y up, right-handed. The front (the farmhouse door, the silo hatch) faces +Z. My Farm's default camera looks from (+X, +Y, +Z), so it sees the front and the right side.
- **Origin:** the centre of the gameplay footprint on the ground (y = 0). My Farm places a structure at `footprintCenter(tile, footprint)`, so the GLB needs no offset. My Farm's structure base plate is 0.08 m high, so a consumer may lift the GLB by that much or let it stand through the plate.

## Descriptor `farm-structures-descriptor-v1`

The descriptor is canonical JSON next to the tar, and [`schemas/farm-structures-descriptor-v1.schema.json`](../schemas/farm-structures-descriptor-v1.schema.json) is its schema.

| Field | Meaning |
| --- | --- |
| `schema`, `units`, `tile`, `up`, `facing`, `handedness`, `origin` | `"farm-structures-descriptor-v1"`, `"metre"`, `1`, `"+Y"`, `"+Z"`, `"right"`, `"footprint-ground-center"` |
| `maxVisualScale` | `1.4`: the owner's allowance for a visual larger than the footprint |
| `assets[]` | Each has `key`, `variant`, `role`, `triangles`, `gameplayFootprint` (tiles), the measured `visual` size and `bounds`, and the recipe's `structure` observations (wall size, eaves and ridge heights; silo radius, body and dome tops). |

## Consumer use

My Farm stages its crops by building asset-tooling at a pinned commit (`scripts/build-farm-art.sh`) and copying package GLBs into `apps/web/public/farm-art`. The structures fit the same path: add `bun scripts/build-farm-structures.ts --out .artifacts/farm-structures` to that build, read `.artifacts/farm-structures/bundle/manifest.json` and stage the `farmhouse.mesh` and `silo.mesh` entries of variant `toy`. Alternatively, download the rolling `farm-structures` release and verify it with `bun scripts/pack-asset-bundle.ts --verify farm-structures.tar --ref export.ref.json` ([asset-bundles.md](asset-bundles.md#release-distribution-and-consumer-pinning)). CI publishes it when a change to its recipe merges ([Publishing a rolling release](../README.md#publishing-a-rolling-release)).

## Tests

`test/blender/kits/farm-structures.test.ts` runs in the hosted `blender-script` job. It checks:

- the tar and the package verify, and each entry is a self-contained GLB;
- the descriptor conforms to the schema;
- each structure stands on y = 0, centred on its footprint, at least 80 % of the footprint and at most 1.4 times it;
- the silo is the taller landmark, the farmhouse walls are saturated red and its roof is dark;
- an independent rebuild packs the same tar.

Without `BLENDER_TESTS=1` and `ASSET_TOOLING_BLENDER` it skips.

## Not covered here

- the owner's visual acceptance in the real My Farm Pages Farm (my-farm#234);
- publishing the `farm-structures` release;
- the My Farm side: staging the GLBs and replacing its code-drawn `FarmHouse` and `Silo` in `apps/web/src/components/farmScene/assets.tsx` (my-farm#234 follow-up).
