# ARPG combat flipbooks

Baked particle flipbooks and burst presets for arpg's combat feedback ([#362](https://github.com/moritzbrantner/asset-tooling/issues/362), arpg#67 67b, part of [#136](https://github.com/moritzbrantner/asset-tooling/issues/136)). They replace the procedural placeholder atlases in arpg's `web/src/combat-vfx.js`.

- **Renderer:** 3d-lab's `frame.effects` ([3d-lab#161](https://github.com/moritzbrantner/3d-lab/pull/161), `docs/contracts/browser-renderer.md`): seeded `bursts` for the sparks and dust, and single flipbook `instances` for the weapon trail. The renderer owns motion and sampling. Each `BurstPreset` passes through unchanged.
- **Source:** the frames in [`src/combat-effect-flipbooks.ts`](../src/combat-effect-flipbooks.ts), drawn by the deterministic 2D rasterizer [`src/effect-flipbook-raster.ts`](../src/effect-flipbook-raster.ts), which the [Zoo flipbooks](zoo-effects.md) also use. The frames are flat-colour lines, circles and lenses, supersampled 4×4 per pixel. There is no randomness, no third-party art, no model, no Blender and no GPU.
- **Release:** one rolling release, `combat-effects` (Atlas Decision 7.1.5), never a numbered one.

## Build

```sh
bun scripts/build-combat-effects.ts --out <directory>
```

The build takes about a second. It writes:

- `<directory>/bundle/`: a `static-glb-png-v1` package (`asset.bundle@1`) of the four atlas PNGs;
- `<directory>/combat-effects.tar` and `.sha256`: the packed package, about 46 KB;
- `<directory>/combat-effects.descriptor.json`: the atlas layouts and presets;
- `<directory>/export.ref.json` and `lineage.json`;
- `<directory>/<name>.png`: the bare atlases (`spark`, `block-spark`, `impact-dust`, `trail`);
- `<directory>/review/<name>.png`: each atlas at 2× on a checkerboard, on arpg's stone floor and on its near-black scene background, with the cell borders marked.

A rebuild packs the same tar bytes.

## Effects

Every atlas is 256×256: 4×4 cells of 64 px holding 16 frames, row-major from the top-left. Pixels are straight-alpha sRGB. The `linear` filter is assumed, and each cell is transparent at least 2 px in from its border. Fully transparent texels keep the effect's outermost colour in RGB, so linear filtering never leaves a dark fringe. Frame `k` shows normalized time `(k + 0.5) / 16`. Every effect fades out by its last frame.

The effects differ by **shape** as well as hue, and no texel's darkest channel reaches 240, so no frame flashes white under a reduced-flash palette.

| Key / variant | arpg use | Look | Scale (m) | `standard` | `subtle` | `heavy` |
| --- | --- | --- | --- | --- | --- | --- |
| `spark.flipbook` / `arpg` | a hit on flesh or a crate | Warm radial embers: an amber flash whose six orange streaks fly outward, shorten and fade | 0.16 | 10 particles, 0.28 s, speed 1.6–3 m/s, spread 1.1 rad, gravity −6, end scale 0.4 | 5 particles, 0.24 s | — |
| `block-spark.flipbook` / `arpg` | a shield block; `heavy` for a guard break | A cool steel-blue four-point glint with shorter diagonals and four chips, turning slightly as it shrinks | 0.22 | 8 particles, 0.3 s, speed 1.2–2.4 m/s, spread 0.9 rad, gravity −4, end scale 0.5 | 4 particles, 0.26 s | 18 particles, 0.45 s, speed 1.6–3.4 m/s, spread 1.4 rad, gravity −5 |
| `impact-dust.flipbook` / `arpg` | an arrow hitting a wall or floor, an obstructed strike | A low grey-brown puff of flattened blobs that spreads sideways and thins | 0.3 | 6 particles, 0.5 s, speed 0.3–0.8 m/s, spread 1.2 rad, gravity −0.4, end scale 1.8 | 3 particles, 0.45 s, end scale 1.6 | — |
| `trail.flipbook` / `arpg` | a weapon-swing streak | A soft horizontal streak, brighter toward its leading (+u) end, that thins and fades | 0.5 | 5 instances, 0.22 s each, 0.025 s apart | 3 instances, 0.18 s each, 0.03 s apart | — |

All presets point up (`direction: [0, 1, 0]`) and start every particle at once (`emitDuration: 0`). The spark, block-spark and dust presets are arpg's own tuned placeholder presets. *Scale* is the recommended world quad size. For the guard break arpg may scale the block spark by about 1.2 (0.26 m). The trail's two presets are motionless single-particle presets whose `lifetime` is each instance's `duration`. Its `instances` field gives how many instances to draw along the swing arc and their start offset. The streak fills about 7/8 of its square cell's width and a third of its height, so a uniform scale of 0.5 m draws about 0.44 × 0.16 m, close to the 0.5 × 0.18 m quad arpg draws today.

## Descriptor `combat-effects-descriptor-v1`

[`schemas/combat-effects-descriptor-v1.schema.json`](../schemas/combat-effects-descriptor-v1.schema.json) is the schema. It has the shape of [`zoo-effects-descriptor-v1`](zoo-effects.md#descriptor-zoo-effects-descriptor-v1), with three differences:

- `renderer` is `three-d-renderer frame.effects`;
- `role` is `spark`, `block-spark`, `impact-dust` or `trail`;
- `presets` may hold an optional `heavy` preset, and the trail has an `instances` object (`standard` and `subtle`, each with `segments` and `stagger`).

Bundle keys are lowercase, so the issue's `blockSpark` and `impactDust` ship as `block-spark.flipbook` and `impact-dust.flipbook`.

## Consumer use (arpg)

arpg downloads the rolling `combat-effects` release, pins it by the tar's SHA-256 and verifies it at build time with `bun scripts/pack-asset-bundle.ts --verify combat-effects.tar --ref export.ref.json` ([asset-bundles.md](asset-bundles.md#release-distribution-and-consumer-pinning)). Then, in `web/src/combat-vfx.js`:

1. decode each PNG to top-row-first RGBA bytes, and declare a `RendererEffectAtlas` with the descriptor's `width`, `height`, `columns`, `rows`, `frameCount` and `filter`, and a `resourceKey` such as `combat-effects:<png.sha256>`;
2. map the cues: `hit` → `spark` `standard`; `blocked` → `block-spark` `standard`; `guardBroken` → `block-spark` `heavy`; `obstructed` and `arrowLanded` → `impact-dust` `standard`; `swing` → `trail`, with `instances.standard.segments` instances, each `presets.standard.lifetime` long and `instances.standard.stagger` apart;
3. use the `subtle` presets for the lighter setting;
4. delete `placeholderAtlas` and the in-code `BURST_PRESETS`.

Effects off or reduced motion still submit `enabled: false`. Publishing the release is a separate, explicit step.

## Tests

`test/combat-effects.test.ts` runs in the ordinary `bun test` gate. It needs no Blender. It checks:

- every preset is inside the bounds of 3d-lab's `compileBurst`, `subtle` is lighter and `heavy` is stronger;
- each atlas is a power of two with whole cells;
- every cell border is transparent with the declared hidden RGB;
- every frame but the last is visible and near the cell centre;
- every effect fades out by its last frame;
- no texel is near white;
- the hit and block sparks differ in shape: their masks overlap little after the first frames;
- the trail is elongated and the dust is low and wide;
- the tar and the package verify, and the descriptor conforms to the schema;
- every packaged PNG decodes to exactly the baked pixels;
- an independent rebuild packs the same tar.

## Not covered here

- Publishing the `combat-effects` release.
- The arpg switch-over (pin, decode, map cues, delete the placeholder) and the owner's visual check in the real game.
