# Kit standard

How to build an asset kit, so a work-loop worker can take one issue and finish one kit without further instructions. The target scale is high graphics at 60 FPS on an RTX 3060 Ti, with about 10 kits in an area.

## One issue, one kit

- **One GitHub issue describes exactly one kit**, built from [the kit issue template](../.github/ISSUE_TEMPLATE/kit.md). A worker takes one issue, on one branch, and opens one PR that ships one rolling release. If an issue describes two kits, split it before starting.
- **A kit doesn't place itself in a game.** Don't change a consumer repository, and don't add the kit to `consumers.json` until a consumer really uses it. Note what a consumer would need on the issue instead. Placement and gameplay belong to the game (mmorpg#683).
- **A new kit can merge once CI passes**, because nothing uses it yet. Review images go in the PR, and the owner reviews them in their own time and asks for replacements (Decision 7.1.4). If the issue's `Review` field says `mockup first`, stop after the mockup and ask.
- **Changing a kit a game already uses is different.** Renaming materials or entries, or moving to an atlas, can break the game. Outpost's wear shader, for example, depends on its material names. Coordinate that with the consumer first.

Ask the owner, using the `needs-decision` label, when:
- the kit needs a source that isn't already catalogued (promoting one is a separate reviewed change)
- no CC0 or original route can reach the look
- it can't meet the limits below
- the issue is ambiguous about the game or style

Never use paid sources or generators, or raw Mixamo (Decisions 6.1.4 and 6.1.7).

## Before building

1. Read the style references ([`docs/style-references/README.md`](style-references/README.md)) and the kit's game style. mmorpg and arpg are humanlike-world; My Farm is cartoony (Decision 3.1.2).
2. Adapt a fitting CC0 source first; author from scratch only when nothing fits (Decision 5.1.7).
3. Pick the closest template:

| Kind of kit | Template | How it's made |
| --- | --- | --- |
| Modular buildings and hard surfaces | [`sandstone.py`](../adapters/blender/sandstone.py), `scripts/build-sandstone-kit.ts` | Hand-editable `.blend` geometry in `assets/authored/`, procedural atlas (Decision 3.1.3) |
| Sculpted natural objects | [`cliff_outcrop.py`](../adapters/blender/cliff_outcrop.py), and the outcrop steps in `scripts/build-crag-kit.ts` | Dense sculpt baked onto a decimated game mesh, then packed into an atlas |
| Trees and foliage | `broadleaf_crown.py`, `conifer_crown.py`, `nature_lod.py` | Trunk plus leaf cards over an opaque core |
| Small scripted props | `settlement_props.py` | Blender recipe using the `Builder` from `outpost.py` |

4. Make a quick mockup first and look at it at the game camera, beside what the game already has. Change the look while it's cheap to change.

## Requirements

### Draw calls and materials

Batched scenery draws once per material, so material count is the limit that matters most.
- At most **one opaque material plus one cut-out material** per kit, unless the issue justifies more.
- Pack the kit's surfaces into a shared atlas. Small flat surfaces such as iron or glass become swatches in it.
- Give every level of a piece the same material name, so a consumer can share it.
- Stay single-sided and opaque where possible. Blended transparency can't be batched.

### Textures

- Encode every texture as KTX2, through `ktx2Assets` in `src/kit-bundle.ts`. Kit builds inherit `--textures full|half`.
- Use power-of-two sizes. 2048 px is the default atlas; go higher only for a large set of baked hero objects.
- Leave a gutter around each atlas cell, so mip levels don't bleed in from neighbours.
- For game-matched surfaces, divide scans by their mean and multiply by the game's palette, as the clients do (`PALETTE` in `cliff_outcrop.py`).

### Geometry and LODs

- Metres, +Y up, right-handed, one documented origin per kind of piece, and modules on a stated grid.
- As a guide: small props up to about 2,000 triangles at full detail, modular pieces up to about 1,000, hero objects up to about 9,000.
- Ship LODs as `lod1`, `lod2` variants in the same frame, with the `lodSelection` and per-piece `lods` descriptor format of the crag and nature kits. A level only exists if it has at most half the triangles of the one before, so a very simple piece may have none.
- Set switch points as distances, not screen-size ratios, which turn small objects into hulls right next to the camera. Keep full detail to at least 60 m and the last level beyond 180 m, at the 60° reference FOV. Derive each level's `minScreenSize` from the piece's own bounding sphere (`CRAG_LOD_DISTANCES` is the example).

### Collision

Every solid piece carries collision for the game's content build (mmorpg#683). It's a simple shape, not the render mesh:
- `collisionProxies` boxes for buildings and props
- a convex hull for compact rocks
- `collisionMesh`, a closed outward-wound triangle mesh of at most 240 triangles, for concave natural shapes

Walk-through pieces such as grass and flowers declare that they have none. Leave soft aprons and small rubble out of the collision shape, so characters can walk onto them.

### Cost limits

Add an entry to `KIT_BUDGETS` in `scripts/report-kit-costs.ts`, set just above the measured cost. CI refuses to publish a kit over its limit. Check with:

```sh
bun scripts/report-kit-costs.ts --bundle <dir>/bundle --budget <release>
```

### Make it look built

Generated surfaces should follow how the real thing is made. Weird proportions and visible repeats are what make a kit look fake:
- **Masonry:** level courses, blocks about two to three times as long as they are high, and vertical joints that shift from course to course. Keep colour differences between stones small, with no chequer pattern.
- **Roofs:** straight courses that overlap, each piece staggered over the row below. The strong line is the shadow under a course; side joints stay faint.
- **Repeats:** make the repeat at least as large as the module, and ideally as tall as a wall. Put settings such as block sizes and colours in tables at the top of the recipe, so they're easy to adjust.
- **Where things meet the ground:** avoid a hard line. Blend into the terrain's own materials, add a soft base or rubble, and bury the foot below ground level for uneven terrain.
- **Silhouette:** real shapes come from geometry, not texture. A tapered cone with a rock texture still reads as a cone.

## Known traps

- **Decimating a very dense mesh collapses it.** Size a sculpt's grid from the object (`CELL` in `cliff_outcrop.py`), and test the result: bounds can look right while the body is gone, so check enclosed volume.
- **Atlas UVs.** Move faces by whole repeats so neighbours stay continuous, and fail the build when a face doesn't fit its cell. Split long faces at repeat boundaries.
- **Material names in live Blender.** An appended placeholder can take the name of the finished material; rename it first.
- **Determinism.** Seed all randomness (`numpy.random.RandomState`, not Python's global state), and build twice to compare tars.
- **Live Blender is shared.** Work in a new scene, never change or delete other scenes (they may be unsaved), and switch the window back afterwards.

## Wiring it in

1. **Build script:** `scripts/build-<kit>.ts` using `src/kit-bundle.ts` and `runKitCli`.
2. **Release:** add it to `ROLLING_RELEASES` in `scripts/publish-release.ts`, in alphabetical order, with the `blender`, `lfs` and `ktx` flags it needs.
3. **Test:** under `test/blender/kits`, building the kit and checking the bundle, grid, openings, collision, LODs and cost limit. A slow kit, or one needing canonical LFS payloads, gets its own suite in `scripts/ci-plan.ts`.
4. **Docs:** `docs/<kit>.md` and one README line, covering what it contains, its frames, and how to edit it.
5. **Review images:** a game-camera render, one close-up and an overview, as small JPEGs in `review/<kit>/`, shown in the PR. Use the 12 m, 0.42 rad pitch, 50° FOV Greyhaven camera for mmorpg kits. A passing test doesn't prove good-looking art.

Run the kit's test and `bun run check` before opening the PR. CI publishes the rolling release when the PR merges.

## Done means

- [ ] One kit, one release, one PR
- [ ] One opaque plus one cut-out material at most, or the issue says why not
- [ ] All textures KTX2, with an atlas
- [ ] LODs where they save at least half
- [ ] Collision on every solid piece, or declared absent
- [ ] A `KIT_BUDGETS` entry
- [ ] Built twice with identical tars
- [ ] Docs and review images in the PR
- [ ] No consumer repository changed
