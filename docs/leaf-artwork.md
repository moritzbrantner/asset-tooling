# Standalone leaf alpha artwork

`asset-tooling/recipes/leaf-artwork` composes two existing circle SDF coverages into a vertical lens, then applies an existing top-to-bottom color gradient. It supplies a standalone canonical image and a separately callable opaque grayscale mask, without a model, network, Blender run, atlas or game random stream. The recipe adds no distance-field, image or geometry kernel. PNG encoding and optional GLB material finishing use the existing processors.

```ts
import {
  LEAF_ARTWORK_PRESETS, executeLeafArtworkRecipe, executePreservedLeafArtworkRecipe,
} from "asset-tooling/recipes/leaf-artwork";

const accepted = await executeLeafArtworkRecipe(absoluteAssetRoot, LEAF_ARTWORK_PRESETS.broad);
const autumn = await executePreservedLeafArtworkRecipe(absoluteAssetRoot, {
  ...LEAF_ARTWORK_PRESETS.broad, low: [240, 176, 51], high: [120, 49, 14],
}, { mask: accepted.maskStep });
```

The deeply frozen rounded, slender and broad presets vary circle radius/separation at a fixed 64×64 canvas. These are static original leaf ingredients, not species identification, grass geometry or authoritative seasonal/growth state mapping.

## Controls and pixels

Version 1 requires exactly `schemaVersion`, `width`, `height`, `radius`, `offset`, `softness`, `low` and `high`. Dimensions are integers 9–256, radius 1–128, circle-center offset 0–radius−1 and softness 1–16. RGB endpoints contain three bytes each. Unknown controls and unsupported bounds fail before generated writes. The standalone `image.procedural.mask.leaf@1` operation takes the five geometry controls; `image.mask.color-gradient@1` accepts one saved canonical opaque grayscale image (1–256 per axis, at most 400,000 encoded bytes) and the two RGB endpoints. Each operation has its own public build-identity and execution functions in the same module.

Circle centers are `(floor(width/2) ± offset, floor(height/2))`. Larger separation narrows the lens; larger radius extends it. Centers must fit in the canvas. Conservative coverage bounds require `radius−offset+softness` within both horizontal center margins and `radius+softness` within both vertical center margins, leaving the outermost texels transparent. Bounds include the existing integer distance approximation; no duplicated first/last pixel or analytic floating-distance contract is claimed.

The existing SDF kernel quantizes floor Euclidean distance into UNORM8; levels and inversion produce each circle's coverage. Existing mask multiplication combines those coverages with UNORM8 rounding, and channel extraction stores alpha as opaque grayscale. At the independent half-softness fixture each circle has coverage 126, so their overlap is `round(126²/255) = 62`. Offset zero still multiplies two identical soft coverages; it does not collapse into a different circle algorithm.

The color gradient interpolates sRGB byte endpoints across the full image, from `low` at the top to `high` at the bottom. It does not linearize RGB or infer color from coverage. Applying the saved mask copies coverage into straight alpha without multiplying RGB, including fully transparent texels; boundary RGB therefore retains the gradient color rather than becoming black. The mask's canonical transport is the existing sRGB RGBA8 document, while metadata explicitly declares linear data sampling, coverage and UNORM8 semantics. It is not a color texture. This slice does not supply editable SVG, alpha-coverage mipmaps, compressed textures or animation frames.

## Explicit preservation and provenance

Mask identity includes only geometry controls and the current implementation/tool identity. Palette edits preserve the complete mask AssetRef, including metadata; the color build references that original immutable mask. Both output stages use the existing object store and operation contracts, with independently recorded producer identities. No second cache or mutable component database is introduced.

`maskStep` contains the original build, AssetRef and complete observations. A preserved execution verifies the current build, producer metadata/observations, encoded dimensions, actual content hash/length and opaque grayscale semantics before generating color. Stale shape/tool controls, missing/corrupt objects or falsified evidence fail without writes. Recoloring executes one operation, reuses one and generates zero mask pixels. The full recipe remains the independent shape-and-color replay path; preservation is explicit, never inferred from a warm cache. Changing geometry requires regenerating its mask. There is no stochastic seed to lock or reseed for this deterministic composition.

## Output and inspection examples

Run `bun examples/leaf-artwork/build.ts` with the configured FFmpeg codec. It emits six summer/autumn color PNGs and three masks under ignored `.artifacts/leaf-artwork`, records editable recipes and full source/build AssetRefs, compares all six recipes and nine PNGs against a cold object store, and exports/verifies only those nine PNGs through `asset.bundle@1`. A package can be read without the original object store. The example requires no 3D generation or renderer; standalone PNGs do not require the atlas pipeline.

For optional native vegetation inspection, first run the documented [tree example](tree-recipes.md), then `ASSET_TOOLING_BLENDER=/absolute/path/to/pinned/blender bun examples/leaf-artwork/apply-to-tree.ts`. This explicitly selects the existing broadleaf composed AssetRef and applies three leaf PNGs to its native `tree-foliage` UV0 slot through `scene.material.base-color@1`, with straight-alpha `MASK` cutoff 0.5 and clamp/linear sampling. Original positions, normals, UVs, indices, hierarchy and bark settings are compared exactly; material finishing invokes zero geometry generators. Each derived GLB matches a cold store and is packaged through the existing export contract. Four native source/variant thumbnails replay independently under the same framing/light parameters. Existing Sapling leaf UVs and mesh silhouette may constrain the texture outline; a texture cannot create new leaf geometry or UVs.

`python3 examples/leaf-artwork/review.py` with Pillow assembles actual PNGs at 96/64/32 pixels and any native tree renders. Inspect transparent fringes and shape/palette distinctions. These are offline artifact previews, not Raid Defense/Zoo/My Farm screenshots, visual approval or a seasonal game-state contract. Consumers remain read-only in this loop.

Run `bun test test/leaf-artwork-recipes.test.ts`, then `bun run check`. Independent odd/non-square pixel fixtures, transparent-border and straight-alpha checks, cold/full/preserved/undo paths, invalid controls and corrupted locks exercise the public operations. An isolated execution guard proves preservation does not call the SDF generator. #133 remains open for shrubs/grass/crops/depletion/LODs and consumer acceptance; #135 retains editable vector/frame and broader vocabulary work; #139 retains other component families and workbench lifecycle integration.
