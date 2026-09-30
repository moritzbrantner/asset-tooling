# Procedural rock family

`asset-tooling/recipes/rocks` supplies the first bounded #132 slice. The versioned authoring script `adapters/blender/rock.py` runs through the existing `external.blender.script@1` backend. Blender owns icosphere topology, continuous Perlin noise, generated UVs, normals and glTF export; the recipe only shapes and places those vertices. No mesh kernel, model service, acquisition path or alternative cache is introduced.

```ts
import { createRockAssetSpec, readRockRecipeSource, ROCK_PRESETS } from "asset-tooling/recipes/rocks";

const source = await readRockRecipeSource();
const spec = createRockAssetSpec({
  assetId: "scenery.flat-rock",
  parameters: { ...ROCK_PRESETS.flat, width: 1.5 },
  scriptSha256: source.sha256,
  blenderVersion: source.blenderVersion,
});
```

Materialize `source.bytes` as `rock.py` and the spec as `asset.json` in an explicit workspace, then invoke ordinary `asset-tooling generate asset.json` and `asset-tooling verify asset.json`. Optional portable `scriptPath` and `outputPath` let callers select their own declared paths. Source reads are relative to the installed package; generated spec paths are portable and independent of the caller's working directory. The existing backend verifies script hashes and the declared Blender version. `readRockRecipeSource` obtains that version from the unchanged packaged release pin; generation never installs Blender or downloads resources.

Version 1 requires a canonical decimal seed and every geometry control. Width/height/depth are measured GLB bounds in meters, each finite in 0.001–1000. Subdivision levels 1–5 bound the source to 20, 80, 320, 1280 or 5120 triangles. Angularity in 0–1 blends a rounded profile toward fuller angular sides using a monotone signed-coordinate power and selects flat shading at 0.5. Irregularity in 0–0.35 controls radial noise; noise scale in 0.1–16 multiplies the unit-source sampling coordinates. Seed-derived coordinates evaluate Blender's continuous noise without advancing an ambient random stream. Flattening in 0–1 reshapes the lower hemisphere before fitting the measured bounds; it is not a collision/contact-patch solver. Identical dimensions are preserved as shape controls change.

The GLB is a self-contained neutral master with generated UVs and one `rock-surface` material slot. Blender's internal Z-up coordinates export to right-handed Y-up. X/Z bounds center on the origin; minimum Y is zero. No gameplay placement, collision or physical truth is inferred. UVs retain the primitive's spherical charts; flat shading and chart seams may duplicate exported vertices. The topology contract concerns the closed oriented surface after welding coincident attribute-seam vertices. Source vertex/triangle counts and measured output bytes are separate budgets.

Generation receipts record the complete script/parameters/runtime/tool/input/output evidence. Script observations also record the source-geometry hash, coordinate conventions, dimensions and topology policy. The source-geometry hash covers authored positions/topology before export and is not an alternate AssetRef identity. The ordinary generation cache remains disposable; `verify` bypasses it and reruns Blender to compare bytes. Exact replay is scoped to the fingerprinted binary/script/environment and demonstrated rebuild, not inferred from the seed.

`createRockVariantManifest` creates a stable logical variant inventory using existing GLB mesh AssetRefs, sorted IDs and optional existing PBR material AssetRefs assigned to `rock-surface`. Changing this external assignment does not change the neutral master mesh or its generation/cache input. The manifest is a declared slot assignment; it does not rewrite the GLB's embedded neutral material or claim a renderer has applied the replacement. Consumer/packaging adapters own applying the assignment and resolving its texture dependencies. The four exported geometry presets are frozen; spread a preset to edit controls. Material finishing through #131/#124 and packaged integration through #125 remain separate follow-ups.

Run `bun examples/rocks/build.ts` from any directory with the pinned Blender available on PATH or in `ASSET_TOOLING_BLENDER`. It prepares declared script/spec workspaces under ignored `.artifacts/rocks/`, generates and independently verifies rounded/angular/flat/boulder GLBs, stores each as the existing provenance-bearing AssetRef, and records stable `variants.json` plus receipts/verification in `evidence.json`. Repeated example runs reconcile unchanged artifacts. No source, canonical payload or consumer repository is modified.

For offline visual evidence, run `blender --background --factory-startup --python scripts/render-rock-family.py -- .artifacts/rocks`. The renderer imports the actual exported GLBs and uses the same 512px orthographic camera, neutral background and lighting for every variant, including an explicit CPU Cycles configuration. These images demonstrate artifact appearance and relative scale; they are not actual Zoo/second-consumer integration, aesthetic approval or a bit-identical render contract.

Tests validate parameter limits/spec/source identity and stable material-independent mesh references without Blender. With `ASSET_TOOLING_BLENDER` configured, tests decode the actual GLB and check finite positions, measured grounded bounds, UV/normal coverage, indices, closed oriented edges/Euler characteristic, expected triangle budget, cache reuse, unchanged generation, exact replay and script tamper rejection. An unperturbed level-1 asset is compared with an independent pole-oriented icosahedron ellipsoid formula at explicit floating tolerance. Hosted `Validate / blender-script` includes these tests alongside the existing backend/pose suite.

Run `ASSET_TOOLING_BLENDER=/absolute/path/to/blender bun test test/rock-recipes.test.ts`, then `bun run check`. The public spec/manifest module is included in the strict TypeScript project. Remaining #132 acceptance includes broader silhouette/extreme-shape evidence, production material application, consumer-camera use in Zoo and a second game, and optional LOD/collision/package derivatives when needed. This initial recipe does not close the issue.
