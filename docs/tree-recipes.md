# Offline branching tree recipes

`asset-tooling/recipes/trees` supplies the first bounded #133 tree-family slice. It invokes Blender Extensions' Sapling Tree Gen 0.3.7 through the existing pinned `external.blender.script@1` backend. Sapling owns recursive stems, native branch hierarchy, taper, leaves and UV construction; Blender owns mesh conversion and GLB export. The packaged `adapters/blender/tree.py` validates controls, invokes the accepted source and selects native components. No geometry kernel, extension installation, wind renderer or alternative cache is added.

```ts
import { createTreeAssetSpec, readTreeRecipeSource, TREE_PRESETS } from "asset-tooling/recipes/trees";

const source = await readTreeRecipeSource();
const spec = createTreeAssetSpec({
  assetId: "scenery.broadleaf",
  parameters: { ...TREE_PRESETS.broadleaf, height: 8, primaryBranches: 24 },
  scriptSha256: source.sha256,
  blenderVersion: source.blenderVersion,
});
```

Materialize `source.bytes` as `tree.py`, the verified add-on archive as `sapling.zip` and the spec in an explicit workspace. Invoke ordinary `generateAsset(...)`/`verifyAsset(...)` or the public CLI. `scriptPath`, `saplingPath` and `outputPath` are optional portable relative paths. Source reads are package-relative; generation never discovers an installed Sapling version or downloads resources.

## Explicit source acquisition

`SAPLING_TREE_SOURCE` exposes the exact provider URL, version, SHA-256, byte length and manifest license. The accepted archive is 36,296 bytes with SHA-256 `27a478262e1c86612a9c3daffe7f4dce2802f5bc2294033462e5adc6d9c0080f`. It contains twelve source/preset/manifest files, totaling 139,097 uncompressed bytes. The [official extension](https://extensions.blender.org/add-ons/sapling-tree-gen/) declares GPL-3.0-or-later and credits Andrew Hale, Aaron Buchler and CansecoGPC. This is the generator-source license; the recipe does not automatically assign a license to generated artwork.

Acquire the archive explicitly before generation. For example, in a checkout:

```sh
mkdir -p .artifacts/sapling
curl --fail --location --max-time 30 --max-filesize 36296 \
  "$(bun -e 'import { SAPLING_TREE_SOURCE } from "./src/tree-recipes.ts"; console.log(SAPLING_TREE_SOURCE.download)')" \
  --output .artifacts/sapling/sapling-0.3.7.zip
```

The example and generator independently verify the actual archive length/hash before using it. The existing Blender CI lane acquires this same pinned test input in a separate, bounded step, then exercises offline generation. The ordinary deterministic gate does not download it. The archive remains disposable input under `.artifacts/`; no third-party source code or canonical LFS payload is vendored by this slice.

Generation verifies the declared archive pin before cache lookup. The script checks the accepted bundle's count/size and extraction paths, loads fresh source from a scoped temporary directory, invokes the module without an ambient extension installation, and cleans it up. The bundle contains no bytecode. Receipts retain the script/archive hashes, exact Blender/tool/environment identity, controls, native geometry observations and output identity. `verify` always reruns the backend.

## Controls and geometry contract

Version 1 requires every field; spread a frozen preset to edit it.

| Control | Contract |
| --- | --- |
| `schemaVersion`, `seed` | Version 1; canonical decimal string in 0–2147483647. The isolated generator uses this explicit seed; no game random stream participates. |
| `family`, `canopyShape` | `broadleaf`/`conifer` choose the accepted source's small-maple/small-pine defaults; `rounded`/`conical` select its canopy envelope. |
| `height` | Measured composed-family height in meters, 0.1–100. Native uniform scale preserves relative shape and the ground root. |
| `levels` | 2 or 3 stem levels, including the trunk. |
| `primaryBranches`, `secondaryBranches` | Integer requested densities in 1–32 and 0–8. Level 2 requires zero secondary branches; level 3 requires at least one. Source shape/distribution can emit fewer branches. |
| `branchAngle` | First-level source down-angle in degrees, 10–120. Subsequent-level source defaults remain pinned. |
| `trunkRatio`, `trunkTaper` | Source radius-to-height ratio 0.005–0.08 and taper 0.1–1. Automatic taper and stem splitting are disabled. |
| `foliageDensity`, `leafScale` | Source leaf density integer 1–512 and leaf scale in meters before family normalization, 0.005–1. Broadleaf hexagonal leaves and conifer needle rectangles reuse native UVs. |
| `curveSegments` | Integer source trunk segmentation in 2–6; secondary segmentation and tessellation stay explicitly bounded. |
| `maxTriangles` | Maximum combined native family triangles, integer 128–200000, checked even for a selected component. Exceeding the budget fails rather than silently degrading detail. |
| `component` | `composed`, `trunk`, `branches` or `foliage`; select the native mesh subset while retaining the family's anchor and scale. |

Outputs are self-contained static GLBs in meters with right-handed Y-up coordinates. The trunk root stays at the ground origin; the asset is not horizontally recentered by canopy bounds. Foliage-only bounds naturally float above that shared anchor. Native leaves are detached from the trunk while preserving world placement before applying family scale, preventing inherited double scaling. Geometry extending below the native ground root is rejected. This is asset placement evidence, not a collision or traversal guarantee.

The composed asset contains three named meshes and two shared neutral materials: trunk/branches share `tree-bark`, foliage uses `tree-foliage`. There are no external texture dependencies, armatures, animations or wind attributes. Sapling's temporary native armature supplies acyclic branch-parent/head/tail observations, explicitly marked Blender Z-up and scaled to the output's dimensions; it is removed before export. Component counts and authored geometry hashes are supplemental observations, not a second AssetRef identity.

Selecting a component invokes the same full bounded source family and then exports that subset. All four selections produce matching family geometry hashes. This is component agreement, not incremental branch preservation across foliage-density edits; #139's accepted-component reuse and #141's invariant state families remain follow-ups. Generation may reuse verified ordinary cache entries, while verification still performs a full authoritative replay. The declared reproducibility is approximate; successful local byte comparison records an observed exact replay in that fingerprinted environment.

## Artifact and visual proof

Run `ASSET_TOOLING_BLENDER=/absolute/path/to/pinned/blender bun examples/trees/build.ts /absolute/path/to/verified/sapling.zip`. With no archive argument, the example uses `.artifacts/sapling/sapling-0.3.7.zip` anchored to the checkout. It creates all eight family/component GLBs and independently verifies them, stores the original bytes as existing provenance-bearing AssetRefs, and creates thumbnails through the packaged static-GLB renderer. Stable `assets.json` and `evidence.json` record outputs, source identity and replay evidence. Generated files remain under ignored `.artifacts/trees/`; unchanged runs reconcile identical outputs and receipts.

Run `python examples/trees/review.py .artifacts/trees` with Pillow to assemble the actual component renders. Each thumbnail has independent framing, so the board demonstrates structure rather than comparative component scale. These are offline asset renders, not Raid Defense/Zoo consumer screenshots or aesthetic approval.

Tests inspect actual GLB positions, normal/UV/index coverage, finite geometry, measured height, ground placement, material sharing and static resource closure through the existing glTF importer. They check bounded native splines, one root, acyclic parent references, exact same-stem joins and first-branch proximity to coarse parent-bone chords at an explicit 2%-of-height fixture tolerance. They compare native component hashes with composition, exercise idempotent output and byte replay, and reject missing/corrupt source inputs, unknown directly authored controls and exceeded budgets without replacing an accepted output.

Run `ASSET_TOOLING_BLENDER=/absolute/path/to/blender ASSET_TOOLING_SAPLING_ARCHIVE=/absolute/path/to/sapling.zip bun test test/tree-recipes.test.ts`, then `bun run check`. Without these explicit prerequisites, only the native integration test skips. The public recipe and test are included in the strict TypeScript project; the test uses a narrow typed bridge to the existing legacy core rather than expanding unrelated migration work.

This slice leaves #133 open for shrubs/grass, alpha foliage artwork, Wheat/Corn appearance stages, depletion variants, renderer-specific wind when needed and real consumer acceptance. It modifies no consumer repository or game state.

## Compact broadleaf shrub preset

`TREE_PRESETS.shrub` reuses the same pinned Sapling broadleaf generator and complete `TreeParameters` contract. It sets height 1.1m, twenty primary/four secondary branches, angle 70°, trunk ratio 0.025, foliage density 320, leaf scale 0.16m, four curve segments and a 30,000-triangle combined budget. This is an editable compact single-root broadleaf appearance, not a new family enum, geometry kernel, species model or multistem guarantee. All other controls, component exports, native hierarchy evidence, root/units and validation retain their established meaning. Existing broadleaf/conifer presets and generator implementation remain unchanged.

Run `bun examples/shrubs/build.ts` with the accepted local Sapling archive and declared Blender. Compact/upright/loose appearances vary height/branch angle or branch/leaf density at one seed and palette; compact also exports independently matching trunk/branches/foliage. Each output is statically validated and independently rebuilt. Shared-framing native previews use one 2.2m world span and ground pivot. The existing bundle profile distributes six GLBs and three PNGs and loads every file after cold-store deletion. `python3 examples/shrubs/review.py` checks current source/render pins before presenting actual images. See [example details](../examples/shrubs/README.md). These fixtures establish producer composition and packaging; Raid Defense/Zoo adoption and camera approval remain separate.

The configured native tree test includes this preset in its existing component/hierarchy/finite-geometry/ground/UV/normal/replay checks. The ordinary tree example now derives its work counts from the actual selected outputs rather than assuming two presets. Grass clumps, native wind contracts, LODs and consumer acceptance remain open under #133.
