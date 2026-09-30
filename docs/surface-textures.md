# Tileable surface recipes

`asset-tooling/recipes/surface-textures` supplies an initial soil/rock slice of #131. It composes the existing periodic bilinear height generator and wrapped normal processor with two missing operations: `image.procedural.height.surface@1` (two-scale height mixture) and `image.scalar.color-ramp@1` (opaque scalar-to-RGB ramp). Each operation is independently callable and exposes its descriptor and build-identity function for workflow registration. No network, model service or Blender is required.

```ts
import { executeSurfaceTextureRecipe, SURFACE_TEXTURE_PRESETS } from "asset-tooling/recipes/surface-textures";

const result = await executeSurfaceTextureRecipe(objectStoreRoot, {
  ...SURFACE_TEXTURE_PRESETS["soil-fine"],
  gridX: 4, gridY: 16, detailWeight: 100,
}, { channels: ["color", "height", "normal", "roughness"] });
```

The absolute object-store root is explicit. Recipes require version 1, repeat sampling, a decimal seed, dimensions, coarse/detail grid counts, detail weight, height range, RGB endpoint palette, normal strength and roughness range. Grids measure cycles per tile axis rather than meters. Each grid is bounded by 256 and its image dimension, dimensions by 4096, byte ranges by 0–255, and normal strength by 1–1024. Height and roughness ranges must be ordered; constant ranges are supported. Unknown fields fail. Reduce grid counts explicitly when requesting a smaller resolution; they are never silently clamped.

Height mixes coarse seed N and detail seed N+1 using an integer weight in 0–255, then remaps the quantized value into the declared height range. Zero detail weight skips the detail generator. Color and roughness interpolate endpoints using the resulting byte scalar. These recipes supply noise-based surface variation; the directional soil preset is not yet a geometrically defined tilled furrow. The rock presets expose smooth/grainy/layered patterns rather than a scanned-rock fidelity claim.

Select any non-empty unique subset of channels. Height is the common dependency; a height-only invocation executes no palette, roughness or normal stage. The result retains the editable normalized recipe/hash, independent channel AssetRefs, component identities and every operation build/observation. Palette edits do not enter height, normal or roughness build parameters. Normal-strength edits change only normal derivation. Repeated and cold-store builds reproduce identical results under the documented built-in algorithms; stored bytes are reconciled rather than overwritten. This slice replays computation on invocation and uses the existing content-addressed store; it does not claim computation-cache hits or add another cache framework.

Color is sRGB. Height and roughness are opaque grayscale UNORM8 scalar **data**; normals are tangent-space XYZ UNORM8 **data**, with **negative Y**, matching `image.normal.from-height@1`. All currently use the existing canonical RGBA8 transport (whose document says sRGB); the recipe's explicit channel semantics require data sampling without an sRGB transfer for scalar/normal channels. Use `texture.orm.pack@1` for the existing linear packed ORM transport and `material.pbr.bundle@1` with `normalYAxis: "negative"`. AO and metallic are not generated or inferred from noise. This recipe does not automatically invent AO/metallic maps or a material bundle. #124 owns texture-set validation and runtime format variants.

Sampling covers `[0,width) × [0,height)`; the first/last texels need not equal. Wrapped derivatives cross the periodic boundary. No mipmap-generation or world-space height/displacement contract is supplied. Repeat-safe consumer sampling/mipmaps and physical height scale remain explicit follow-ups.

Run `bun examples/surface-textures/build.ts` from any working directory to generate all six controlled presets, four channel PNGs per preset and `builds.json` under the repository's ignored `.artifacts/surface-textures/`. PNG encoding uses the existing explicit FFmpeg operation and records its runtime identity; exact PNG replay is scoped to that recorded implementation. Canonical RGBA8 replay does not require FFmpeg. Generated outputs and evidence remain disposable.

Tests cover independent scalar endpoints/interior bytes, the existing pinned periodic-noise fixture, constant scalar/normal references, wrapped normals compared with the center of an independently repeated 3×3 height image, odd/tiny dimensions, invalid/colored/transparent/corrupt input, selected stages, cold-store replay and independent channel invalidation. Run `bun test test/surface-texture-recipes.test.ts test/procedural-textures.test.ts test/material-operations.test.ts`, followed by `bun run check`.

The six presets are editable recipe content, not a core style policy. They provide three soil and three rock variations with fixed seed and changed controls. Tiled inspection is technical/artifact evidence; it is not My Farm camera acceptance. Consumer repositories remain read-only in this loop. My Farm currently renders Field Plot using constant-color materials in `packages/game-scene/src/assets.tsx`; integration belongs to my-farm#125. Remaining #131 scope includes proper tilled geometry, bark/wood/grass/sand/paper recipes, physical/pattern controls as needed, mipmap evidence, actual computation reuse where meaningful and consumer-camera acceptance.
