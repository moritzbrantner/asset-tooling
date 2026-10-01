# Corn sprites with shared world framing

Run from this checkout with its pinned Blender configured:

```bash
bun examples/corn/build.ts
bun examples/directional-crops/build.ts
python3 examples/directional-crops/review.py
```

The example consumes the existing early / mature-straw / harvested-looking Corn AssetRefs. It generates no source geometry. Four explicitly named views use glTF world right-handed Y-up: front/right/back/left place the camera toward +Z/+X/−Z/−X respectively, with a declared 0.15 Y elevation component. These names describe this recipe's camera convention, not an inferred facing rule for every asset.

All twelve 256 × 384 transparent PNGs share a world target `[0, 0.9, 0]`, a 1.5 m horizontal span and the original ground pivot `[0, 0, 0]`. The small appearance remains physically smaller; each request keeps the same units per pixel and lighting scale. Native projection supplies the source-pixel pivot. The review grid marks that anchor and composites actual renders; it is a producer comparison camera, not a Farm gameplay-camera approval.

Every spec pins the original GLB and renderer source and uses the existing backend/cache/receipt boundary. Direction reordering preserves complete prepared specs. Verification replays all twelve renders independently of cache; repeat generation reports native stages executed/reused separately from decode/replay work. PNG refs retain full source, direction, state, configuration and renderer lineage. Canonical decoded frame refs retain those same original refs and the decoder build identity without changing frame bytes.

The existing sprite-atlas operation trims/extrudes selected frames with their actual logical pivots. Inspection reconstructs every alpha value, visible RGB pixel and pivot from the atlas. Trimming may discard invisible RGB outside the alpha bounds; the original PNG/canonical-frame bytes remain intact in their respective packages. There is no animation frame schedule: these are selectable static directions and appearances.

Two explicit distribution choices use the existing bundle exporter: twelve independent PNGs (`static-glb-png-v1`) or one original atlas/PNG pair with its canonical frame closure (`sprite-atlas-png-v1`). Both compare with independent cold builds and load after deleting the cold producer store. The original PNGs remain usable without the atlas. Canonical frame closure is larger than PNG-only distribution; select the package appropriate to the consumer rather than shipping both by default.

All outputs, receipts, inventories, packages and review captures are disposable under `.artifacts/directional-crops/`. Identical output files and the inspection PNG preserve mtimes. Inspector failures remove stale captures. Consumer repositories remain read-only: actual Crop-state/item/orientation mapping belongs to `moritzbrantner/my-farm#125`. This adds no saved Crop state, growth timing, collision, planting spacing or runtime generation. Wider #142 pose/portrait/lifecycle and product-view acceptance remains open.
