# Saved exclusion masks for cosmetic detail

`instances.filter.exclusion-mask@1` filters an existing immutable instance set against an explicitly calibrated saved mask. It keeps the original IDs, array order and full XYZ micro-unit coordinates. Excluded candidates are not replaced. Editing a mask cannot reroll unrelated rocks or trees, and filtering after height projection preserves the existing Y coordinates.

```ts
import {
  executeInstanceExclusionMaskOperation,
  createInstanceExclusionMaskOperationBuildIdentity,
} from "asset-tooling/operations/instances/masks";

const invocation = {
  inputs: { source: acceptedInstances, mask: savedExclusionMask },
  parameters: {
    maxCoverage: 127,
    maskBounds: { widthMicro: 12_000_000, depthMicro: 8_000_000 },
  },
};
const build = await createInstanceExclusionMaskOperationBuildIdentity(absoluteAssetRoot, invocation);
const filtered = await executeInstanceExclusionMaskOperation(absoluteAssetRoot, invocation);
```

The operation is also listed and re-exported through the existing `asset-tooling/operations/instances` catalog. The narrow `/masks` subpath provides the strictly typed filter without importing the legacy scatter implementation.

## Coordinate and coverage contract

Inputs use the existing `instance-set` and canonical RGBA8 image formats and original AssetRefs. The mask must be opaque grayscale: RGB bytes agree and alpha is 255. Its bytes represent linear UNORM8 exclusion coverage, not sRGB color. Coverage at or below the integer `maxCoverage` threshold (0–255, inclusive) keeps a candidate. Black permits detail; white excludes it unless the threshold is 255. Filtering tests instance roots, not complete mesh footprints.

`maskBounds` is mandatory and must exactly equal the source set's `widthMicro` and `depthMicro`. Coordinates use the existing right-handed Y-up, 1e−6-unit protocol. For each horizontal axis, the footprint starts at `−floor(span/2)` and ends at that minimum plus `span−1`. Image columns increase with world X; rows increase with world Z. Unsupported offsets or implicit stretching fail closed.

Sampling reuses the existing height-projection nearest-endpoint helper. For a coordinate `p`, minimum `min`, span `s` and image dimension `n`, the index is `round((p−min)*(n−1)/(s−1))`, using integer arithmetic and midpoint ties toward the larger index. A one-sample image or one-micro-unit span samples index zero. This handles negative coordinates, odd/non-square domains and exact endpoints without floating-point drift.

The filter accepts at most 4096 source instances, a 2 MiB encoded instance set and an 8 MiB encoded mask. Masks are bounded to 4096 per axis and 1,048,576 pixels. Input hashes/lengths, source bounds, image structure and channels are verified before derived writes. Both build identity and execution perform these checks. Output metadata retains the original source/mask hashes and calibration; build identity includes the complete input refs and implementation/tool fingerprint. The existing content-addressed store reconciles identical outputs. No additional cache, random stream or scatter generator is introduced.

## Actual scenery example

First run the [existing rock example](rock-recipes.md) to supply its original `angular` master, then run:

```bash
ASSET_TOOLING_BLENDER=/absolute/path/to/pinned/blender bun examples/instance-exclusion/build.ts
python3 examples/instance-exclusion/review.py
```

The normal-Git [recipe](../examples/instance-exclusion/recipe.json) saves two independently authored 9×7 exclusion masks over a 12×8-unit footprint. The existing minimum-distance scatter operation creates 48 candidates once. A vertical path leaves 37 candidates; a localized west-side edit leaves 32, preserving all retained IDs and XYZ positions. Both filters match independent integer sampling and cold-store replay.

The example explicitly loads the original rock AssetRef, links its mesh data into the selected native placements, and adds a flat review plane. It generates zero source rocks. This private authoring script uses the existing hash-pinned Blender backend and renderer; it supplies no public placement or terrain kernel. The review plane has a half-unit border to hold native camera framing constant and a nearest-sampled guide whose UVs map footprint endpoints to texel centers. Native GLB translations match saved micro-unit positions within 1e−6 units, and the two renders have identical observed bounds/framing. Both assemblies and both renders independently replay exactly on the local pinned backend.

Ignored `.artifacts/instance-exclusion` contains masks, candidate/selected sets, complete original AssetRefs, native outputs, receipts and the actual review sheet. Two selected GLBs export through the existing `asset.bundle@1` profile and verify from the package. The sheet overlays all original candidates on the saved masks and shows both rendered fields. These are offline cosmetic previews, not game screenshots or approval of navigation, collision or gameplay space.

Run `bun test test/instance-mask-operations.test.ts test/scatter-operations.test.ts`, then `bun run check`. Independent non-square grids cover midpoint sampling, inclusive thresholds, retained negative Y coordinates, empty/full results, localized edits, cold replay, undo, idempotence, invalid calibration/channels/budgets and tampered objects. Existing scatter and height-projection fixtures preserve their previous bytes and observations.

Issues #134 and #140 remain open for density/slope/height controls, coordinate-derived chunk identities, adjacent chunk/world-origin seams, composition previews and consumer acceptance. #139 retains broader component-lock/workbench lifecycle work. This operation preserves an explicitly accepted candidate set; it does not define how a chunk generator creates stable candidates.
