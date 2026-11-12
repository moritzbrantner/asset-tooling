# Terrain workbench

The second procedural slice of the asset workbench ([#127](https://github.com/moritzbrantner/asset-tooling/issues/127)), after the [texture workbench](texture-workbench.md), lives in the Pages site at `workbench/terrain/` and is linked from the gallery. It gives direct controls over **one** recipe from [`asset-tooling/recipes/terrain-patches`](terrain-patches.md) and builds the same 2×2 patch grid as `examples/terrain-patches/build.ts`. It adds the workbench's lock, reseed and keep controls for the terrain components from [#139](https://github.com/moritzbrantner/asset-tooling/issues/139).

## What it does

- **The recipe's own component build.** A Web Worker runs `buildTerrainPatchFiles` from `src/terrain-patch-recipes.ts` for each patch and passes the previous successful build as `previous`. Only components whose key changed execute. The status line shows how many components executed and were reused, and how many height samples were evaluated. Moving a paint shape evaluates none.
- **Exact inputs with units.** Recipe id, height seed, origin, sample spacing and samples per patch, height range and precision, noise, and shaping (noise, island or terrace, with the fields for that kind). Each detail layer has its own id, seed, density, spacing, slope, height, exclusion, paint mask, scale and variants. Edits, exclusions and paint masks are edited as JSON, in metres. Number inputs step with the arrow keys and there are no sliders. *Add detail layer* and *Remove* change the layer list.
- **Validation next to the control.** The form runs the recipe's own `normalizeTerrainPatchRecipe`, so messages and bounds are the operation's. A message about a shape goes to its JSON box, and one about a pair to the pair's first input. An invalid edit shows its message and keeps the last valid recipe and result.
- **Seeds: lock and reseed.** The workbench works in recipe schema 2, where the height and every detail layer have their own seed. A schema 1 recipe is converted on load by giving every layer the recipe seed, which keeps every component key and byte. Each seed has *Lock* and *Reseed*. *Reseed unlocked seeds* (R) reseeds all seeds that are not locked. Loading a preset keeps locked seeds.
- **Keep components.** The *Components* table lists height, exclusion, each paint mask, each detail layer and the detail assembly. For each one it shows whether the last build executed or reused it, whether it differs from the accepted baseline, and a *Keep* box. Kept components go to the build as `preserve`. An edit that would change one is refused by the build itself (`terrain component 'height' cannot be preserved: its inputs changed`): the row turns red, the last result stays (dimmed), and nothing can be accepted until you undo or release the component. Releasing it builds the waiting recipe.
- **Latest result wins.** At most one build runs and one waits, and a result for an older request is dropped. Cancel (Escape) stops the running build. The next build then starts cold, because the cancelled worker's previous build is gone.
- **Undo/redo** over valid recipes (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y outside text fields). Presets are the example hillside, the recipe's `flat`, `rolling`, `island` and `terrace` presets, and presets saved in this browser.
- **Preview.** The four patches are stitched on their shared edges, with +X to the right and +Z down, and a faint line on the seams. Views are shaded height, slope, exclusion and each paint mask (keys 1…), with detail instances as dots per layer (D). The legend gives each layer's instance count.
- **Accepted baseline.** *Accept as baseline* records the recipe and every component's output hashes over the four patches in this browser's local storage, and shows that build next to the current one. A component whose bytes differ is listed as changed, so a changed output never keeps the earlier acceptance. *Reset to accepted* restores that recipe. This is a review aid, not game approval: a game adopts terrain only in its own issue or PR (Decision 7.1.6).
- **URL state.** The recipe, view and detail overlay live in the query string, so a reload or a shared link restores them. Locks and kept components stay in the page session. Leaving the page with edits that were neither accepted nor exported asks first.
- **Export.** *Download recipe.json* saves the normalized recipe, which is the editable source. *Download preview PNG* saves the current view. The canonical patch files come from the CLI:

```sh
bun examples/terrain-patches/build.ts .artifacts/terrain-workbench recipe.json
```

## Browser and CLI identities

The worker bundle maps `node:crypto` to a small synchronous SHA-256 (`src/browser/node-crypto-shim.ts`), and `node:zlib` to pako (`src/browser/node-zlib-shim.ts`). Component keys hash only canonical recipe inputs, so they equal the keys in the CLI's `manifest.json`. `mesh.glb` and `detail.json` don't involve compression, so their hashes match too. PNGs are the exception. pako's deflate can produce different compressed bytes from the runtime's native zlib (the example's `height.png` differs by one byte), so a PNG's hash in the browser is not the CLI's. Its decoded samples are identical. The workbench therefore compares builds only with other browser builds, and the CLI writes the canonical PNGs.

## Not in this slice

Approval states beyond the local baseline, the workflow-editor/runner projection, mesh, sprite and effect inspectors, and the rest of #139–#145 (trees, rock outlines, guides, icons, assemblies and effect previews) remain under #127.

`bun test test/terrain-workbench.test.ts` checks that the session builds the CLI grid byte for byte and reruns only the components an edit reaches. It also covers a kept component refusing an edit without losing the previous build, schema 1 to 2 conversion, the URL round trip, the field each message points to, the browser shims against Node, and the page bundles.
