# Posed sprites and a portrait

Run from a checkout with the pinned Blender configured:

```bash
git lfs pull --include="assets/canonical/zoo.zebra-glb/**,assets/canonical/zoo.giraffe-glb/**,assets/canonical/quaternius.universal-animation-library-standard.animationlibrary-godot-standard-glb/**"
bun scripts/build-zoo-animals.ts --out .artifacts/zoo-animals
bun examples/posed-sprites/build.ts
```

- **Zebra walk.** The source is the released expressive zebra (`zoo.animal.zebra` / `expressive`, #589), read from the Zoo build's lineage. Four declared directions (camera toward +X/−Z/+Z/−X, named east/north/south/west, with a 0.35 elevation component) times eight evenly spaced `walk` times give 32 transparent 128 × 128 PNGs. They share one world frame (target `[0, 0.95, 0]`, 2.5 m span, ground pivot `[0, 0, 0]`), so the zebra keeps its scale and ground point in every frame. The Zoo animals face +X, so east is head-on and south shows the left flank. The existing sprite-atlas operation packs the frames with their projected pivots.
- **Portrait.** The canonical Quaternius mannequin at `Idle_Loop` 1 s, rendered with the `portrait` preset and a declared bust frame with `overflow: "crop"`.

Every render goes through the ordinary spec/receipt boundary and is verified by replay. Outputs, receipts and the atlas are disposable under `.artifacts/posed-sprites/`. This is a producer comparison camera, not a game-camera approval, and no consumer repository is changed.
