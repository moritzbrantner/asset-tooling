# Modular fence kit

`asset-tooling/recipes/fence` provides the first 3D connection kit for #143: `end`, `straight`, `corner` and `tee` fence pieces authored through the existing pinned Blender script backend (`adapters/blender/fence.py`). It also provides a small connection contract and a reference layout evaluator for previews and tests. It is not a map editor or placement authority.

```ts
import {FENCE_PRESETS, createFenceAssetSpec, evaluateFenceLayout, fencePortsAfterRotation, readFenceRecipeSource} from "asset-tooling/recipes/fence";

const source = await readFenceRecipeSource();
const spec = createFenceAssetSpec({assetId: "fence.tee", parameters: FENCE_PRESETS.tee,
  scriptSha256: source.sha256, blenderVersion: source.blenderVersion});
fencePortsAfterRotation("corner", 1); // ["north", "west"]
```

## Connection contract

`FENCE_CONNECTION_CONTRACT` declares the rules:

- One piece fills one square cell of `cellSize` meters. The origin is the cell centre at ground level, in meters and right-handed Y-up.
- Directions in glTF coordinates: east is +X, north is -Z, west is -X and south is +Z. Grid cell offsets use the same `(x, z)` axes.
- Ports at rotation 0 (`FENCE_PIECE_PORTS`): end `[east]`, straight `[east, west]`, corner `[east, north]`, tee `[east, north, west]`. A port's anchor is the edge midpoint at ground height (`fencePortAnchor`).
- Rotation is 0–3 counter-clockwise quarter turns about +Y. The pieces are rotationally symmetric, so mirroring is unsupported and never needed.
- Overlap rule: a post stands at the cell centre and each port has `railCount` rails that end flush on the cell edge. Two connected pieces meet rail end to rail end on the shared edge, and no geometry crosses a cell boundary.

`evaluateFenceLayout` takes placements (`id`, `piece`, integer `cell`, `quarterTurns`) and reports connections, mismatches (a port facing a neighbour without the opposite port) and open ends (a port facing an empty cell). It rejects duplicate IDs, doubly occupied cells, fractional cells and invalid rotations. Games and editors keep tile selection, placement legality, collision and traversal. A rendered fence connection does not make anything traversable.

## Controls

Parameters are `schemaVersion: 1`, `piece`, `cellSize` (0.5–8), `postWidth`, `postHeight`, `railCount` (1–3), `railHeight`, `railDepth` and `maxTriangles`. The post must fit half a cell, rails cannot be deeper than the post, and rails may fill at most half the post height. Python and TypeScript reject the same controls before the scene changes. Each piece is built from one post box plus one box per rail: 12 × (1 + ports × railCount) triangles, which must fit `maxTriangles`. Generation declares `randomness: none` and exact reproducibility.

## Example and tests

Run `bun examples/fence-kit/build.ts` with the declared Blender available. It generates and exactly verifies the four preset GLBs, imports them, renders transparent previews with one shared orthographic framing (3.4 m span, ground pivot), checks a 3×2 pen with a tee branch through the evaluator (7 connections, no mismatches or open ends) and packages meshes and previews with the static bundle profile. Repeat runs write zero package bytes. All outputs go to the ignored `.artifacts/fence-kit/`.

`bun test test/fence-kit-recipes.test.ts` checks rotations against an independently authored table and exhaustively evaluates all 1,024 piece/rotation/adjacency pairs. With `ASSET_TOOLING_BLENDER` set, native tests check Python and TypeScript control parity. They also check that every piece's rail end-face corners lie exactly on its declared port edges at independently computed heights and widths, that no geometry reaches a non-port edge, and that exact replay, cache hits and triangle budget rejection work.

Not yet covered: textured variants, other wall styles, atlas/2D kits beyond the grass/soil tiles, and consumer previews in puzzle-game-core#15 and zoo#86.
