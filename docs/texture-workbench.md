# Texture workbench

The first procedural slice of the asset workbench ([#127](https://github.com/moritzbrantner/asset-tooling/issues/127)) lives in the Pages site at `workbench/texture/`, linked from the gallery. It gives direct controls over **one** tileable surface recipe from [`asset-tooling/recipes/surface-textures`](surface-textures.md), with no workflow graph, world or model download.

## What it does

- **Exact inputs with units.** Seed (decimal, with lock and reseed), width/height in px, coarse and detail grids in cycles per tile, detail weight, height range, optional furrows (axis, count, depth, softness), low/high palette colours as hex with a picker, normal strength and roughness range. Sliders are not used; number inputs step with the arrow keys.
- **Validation next to the control.** The form runs the recipe's own `normalizeSurfaceTextureRecipe`, so messages and bounds are the operation's. An invalid edit shows its message by the field and keeps the last valid recipe and result. The workbench caps previews at 2048 px per axis; build larger tiles with the CLI.
- **Same kernels as the CLI.** A Web Worker runs `src/surface-texture-kernels.ts`, the module the recipe operations themselves call. Each channel's identity is the SHA-256 of its canonical RGBA8 document, the same value as the CLI build's `AssetRef.sha256`.
- **Only affected stages rebuild.** Height is keyed by its operation parameters. Colour, normal and roughness are keyed by their own parameters plus the height. A palette edit recolours the kept height, and the status line lists each stage as executed or reused.
- **Latest result wins.** At most one build runs and one waits. A newer edit replaces the waiting one, and a result for an older request is dropped. Cancel (Escape) stops the running build; the last finished result stays.
- **Undo/redo** over valid recipes (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y, outside text fields). Presets: the recipe's frozen presets and presets saved in this browser. Loading a preset keeps a locked seed.
- **Preview.** Colour, height, normal and roughness channels (keys 1–4), with 1×1 or 3×3 tiling (T) to check seams.
- **Accepted baseline.** *Accept as baseline* records the current recipe and the four channel hashes in this browser's local storage and shows that output next to the current one. Any channel whose bytes differ is listed as changed, so a changed output never keeps the earlier acceptance. *Reset to accepted* restores that recipe. This is a review aid, not game approval: a game adopts a texture only in its own issue or PR (Decision 7.1.6).
- **URL state.** The recipe, channel and tiling live in the query string, so a reload or a shared link restores them. Leaving the page with edits that were neither accepted nor exported asks first.
- **Export.** *Download recipe.json* saves the normalized recipe, which is the editable source. *Download preview PNG* saves the current channel from the canvas. Canonical channel PNGs come from the CLI:

```sh
bun scripts/build-surface-texture.ts recipe.json .artifacts/texture-workbench
```

It runs `executeSurfaceTextureRecipe`, encodes each channel with the existing PNG operation and writes `result.json`. The printed `canonicalSha256` per channel equals the workbench's channel identity.

## Not in this slice

Approval states beyond the local baseline, the workflow-editor/runner projection, mesh, sprite and effect inspectors, and the #139–#145 follow-up controls remain under #127.

`bun test test/texture-workbench.test.ts` checks that workbench channels hash like the CLI recipe and that only stages with changed inputs rebuild. It also covers the URL round trip, undo/redo, the field each message points to, the latest-request gate and the page bundles.
