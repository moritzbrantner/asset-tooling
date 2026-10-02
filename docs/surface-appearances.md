# Surface appearance families

`asset-tooling/recipes/surface-appearances` maps stable state IDs to appearances of one [tileable surface](surface-textures.md). It is the surface family slice of #141, using the same pattern as the [tree appearance family](tree-appearances.md): one declared base, explicit shared components and state-specific changes. It adds no cache, generator or simulation state.

```ts
import {SURFACE_APPEARANCE_PRESETS, executeSurfaceAppearanceFamily, executeSurfaceAppearanceState} from "asset-tooling/recipes/surface-appearances";

const family = await executeSurfaceAppearanceFamily(root, SURFACE_APPEARANCE_PRESETS.soilMoisture);
// Rebuild one edited state against the accepted shared steps: only its color and roughness operations run.
const wet = await executeSurfaceAppearanceState(root, editedFamily, "wet", {shared: family.shared});
```

## Contract

A family has exactly `schemaVersion: 1`, `id` (portable lowercase token), `base` (a complete surface texture recipe) and 1–8 `states`. Each state has exactly `id`, `low`, `high`, `roughnessMin` and `roughnessMax`. State IDs are unique and the result orders them by ID, so declaration order never changes identities.

Invariants are explicit (`SURFACE_APPEARANCE_INVARIANTS`): height and normal are shared, and only color and roughness vary. A state cannot carry height, seed, grid, furrow or normal-strength fields; changing the relief means changing `base`, which changes every state. The base and each state are validated by the surface recipe's own validator before any object is written.

The family builds the base height and normal once. Every state then runs through `executePreservedSurfaceTextureRecipe` with those steps as locks. The locks' build identity, metadata and bytes are verified, and only the color and roughness ramps execute (two operations per state, with four reused at the default two-scale settings). Pass `shared` (the `shared` steps of an accepted family result) to skip the height/normal stage entirely. Stale locks, for example after a base seed or normal-strength edit, and corrupt objects fail closed. An AbortSignal is checked between stages.

## Preset and example

`SURFACE_APPEARANCE_PRESETS.soilMoisture` (`soil.moisture`) derives `dry`, `damp` and `wet` from the `soil-fine` relief. Wetter states are darker and less rough. These are cosmetic appearances. The game decides when soil is wet, and switching appearance changes no collision, saved state or simulation RNG.

Run `bun examples/surface-appearances/build.ts` with the configured FFmpeg codec. It cold-replays the family, checks that each single-state rebuild against the accepted shared steps matches the full result, and writes the shared height/normal, per-state color/roughness PNGs and `family.json` to the ignored `.artifacts/surface-appearances/`.

Run `bun test test/surface-appearance-recipes.test.ts`, then `bun run check`. Tests check every pixel against an independent ramp reference computed from the shared height. They also cover pre-write rejection, ID ordering, add/reorder/edit/undo identity, stale and corrupt locks, cancellation, and a generator spy that proves no noise runs for a locked single-state edit.

#141 stays open for prop intact/damaged/repaired families, packaging selected states, workbench comparison and consumer-camera/game acceptance.
