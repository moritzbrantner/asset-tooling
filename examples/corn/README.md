# Authored Corn appearances

This bounded second Crop slice produces early, mature and harvested-looking static
Corn GLBs through the existing offline Blender script backend. `stage` selects
producer geometry; a consumer maps its authoritative Crop state to these IDs.
The recipe introduces no saved growth state, inventory item, simulation random
stream, collision choice or wind playback.

Run from a checkout with the pinned Blender installation (see `adapters/blender`):

```sh
ASSET_TOOLING_BLENDER=/path/to/blender bun examples/corn/build.ts
python3 examples/corn/review.py
```

Outputs and receipts remain disposable under `.artifacts/corn`. The script uses
the native authoring functions already used by Wheat: materials, swept Bezier
leaves, ordered UV spheres, joining and the Blender glTF exporter. Corn declares
that complete local Python file as a second hash-pinned input; generation never
loads it from an ambient import path. Native cones form the stalk, ear core and
small tassel. The ear has eight columns and bounded explicit kernel rows.
Bounds, stage controls, seed, resolution and a
combined triangle budget are explicit. Each self-contained GLB uses meters,
right-handed Y-up, an identity root transform and a ground anchor at `[0,0,0]`
within a declared 1.1 × 1.1 meter footprint. This footprint is a producer envelope,
not a collision or planting-spacing contract. Current presets use 322 / 3,194 /
28 triangles for early / mature / harvested respectively.

Use `asset-tooling/recipes/corn` to read the packaged Python source, validate
controls and declare a hash-pinned spec using both the Corn script SHA-256 and
the returned authoring-source SHA-256. Write both returned source byte arrays
to their declared spec-relative paths. Generation and verification use the
existing backend. Independent rebuilds compare actual output bytes; the declared
approximate expectation does not claim cross-environment byte reproducibility.
The native UV-sphere operation varies polygon enumeration between processes;
ordering its existing BMesh faces before joining makes the local replay stable
without changing their vertices, loops or UVs.

The example also creates two mature leaf palettes using existing gradient, PNG
codec and named glTF material operations. Both retain every mesh attribute and
index, node transform, stem/grain/tassel material setting and the original
mature source ref. The example records the complete operation build identities and accepted
refs. Editing leaf artwork invokes zero Corn geometry generators. Cold material
replay matches, and the early/harvested refs stay independent of that edit.

Five hash-pinned native icons are rendered and replayed. Each icon auto-fits its
own source bounds; the review board therefore compares appearance, not physical
height or a gameplay camera. The selected distribution contains early,
mature-straw and harvested GLBs with their PNG icons through the existing static
bundle profile. Verification and reading succeed after the cold producer store
is removed; the package retains the original complete AssetRefs. Repetition
reconciles byte-identical files and writes no package bytes.

Shrubs, grass, shared stem geometry across differing crop stages, consumer
state mapping and real consumer-camera acceptance remain outside this slice.
Consumer repositories stay read-only in this producer loop.

Both Crop examples share one execution and inspection runner. The Wheat
authoring refactor retains all three original stage GLB byte hashes and leaves
its published controls, source-reader shape and spec inputs compatible.
