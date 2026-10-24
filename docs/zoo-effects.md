# Zoo particle flipbooks

This is the first usable slice of [#136](https://github.com/moritzbrantner/asset-tooling/issues/136): baked particle flipbooks and burst presets for Zoo's keeper effects ([zoo#86](https://github.com/moritzbrantner/zoo/issues/86); owner answer of 2026-10-24: real particles, off under reduced motion).

- **Renderer:** the effects are played by 3d-lab's `frame.effects.bursts` ([3d-lab#161](https://github.com/moritzbrantner/3d-lab/pull/161), `docs/contracts/browser-renderer.md`, "Seeded bursts" and "Flipbook input from asset tooling"). The renderer owns particle motion and sampling. This recipe supplies the atlas and a `BurstPreset` that passes through unchanged.
- **Source:** the frames in [`src/zoo-effect-flipbooks.ts`](../src/zoo-effect-flipbooks.ts), drawn by the shared deterministic 2D rasterizer [`src/effect-flipbook-raster.ts`](../src/effect-flipbook-raster.ts) (also used by the [ARPG combat flipbooks](combat-effects.md)). It draws flat-colour circles, ellipses and leaf lenses, each with a darker rim, supersampled 4×4 per pixel. There is no randomness, no third-party art, no model, no Blender and no GPU.
- **Release:** one rolling release, `zoo-effects` (Atlas Decision 7.1.5), never a numbered one.

## Build

```sh
bun scripts/build-zoo-effects.ts --out <directory>
```

The build takes about a second. It writes:

- `<directory>/bundle/`: a `static-glb-png-v1` package (`asset.bundle@1`) of the three atlas PNGs;
- `<directory>/zoo-effects.tar` and `.sha256`: the packed package, about 36 KB;
- `<directory>/zoo-effects.descriptor.json`: the atlas layouts and burst presets;
- `<directory>/export.ref.json` and `lineage.json`;
- `<directory>/<kind>.png`: the bare atlases;
- `<directory>/review/<kind>.png`: each atlas at 2× on a checkerboard, on grass green and on dark, with the cell borders marked.

A rebuild packs the same tar bytes.

## Effects

Every atlas is 256×256: 4×4 cells of 64 px holding 16 frames, row-major from the top-left. Pixels are straight-alpha sRGB. The `linear` filter is assumed, and each cell is transparent at least 2 px in from its border, so the renderer's half-texel inset never shows a neighbouring frame. Fully transparent texels keep the effect's rim colour in RGB, so linear filtering never leaves a dark fringe. Frame `k` shows normalized time `(k + 0.5) / 16`. Each particle plays the atlas once over its `lifetime`.

| Key / variant | Look | Scale (m) | `standard` preset | `subtle` preset |
| --- | --- | --- | --- | --- |
| `dust.flipbook` / `toy` | Cream blobs that swell, thin out and fade by the last frame | 0.35 | 10 particles, 0.7 s, speed 0.25–0.6 m/s up, spread 1.3 rad, gravity −0.3, end scale 1.8 | 5 particles, 0.6 s, end scale 1.5 |
| `leaf.flipbook` / `toy` | A two-tone green leaf that turns once and flips to its lighter back; stays opaque | 0.18 | 6 particles, 1.2 s, speed 0.6–1.1 m/s, spread 0.9 rad, gravity −1.2, `fadeOut` | 3 particles, 1.0 s |
| `splash.flipbook` / `toy` | A stretched blue drop that rounds out, then breaks into three droplets and fades | 0.12 | 14 particles, 0.6 s, speed 1.2–2.0 m/s, spread 0.5 rad, gravity −6, end scale 0.6 | 7 particles, 0.5 s |

All presets point up (`direction: [0, 1, 0]`). Times are in seconds of the consumer's cosmetic clock; distances are in metres, where one Zoo tile is 1 m. *Scale* is the recommended world quad size for the renderer's `scale`. The palette follows Zoo's `park-scene.ts` (path and soil tones, pond water) and the `zoo-scenery` leaf greens.

## Descriptor `zoo-effects-descriptor-v1`

[`schemas/zoo-effects-descriptor-v1.schema.json`](../schemas/zoo-effects-descriptor-v1.schema.json) is the schema. Each `effects[]` entry has:

- `key`, `variant` and `role`;
- `atlas`: `width`, `height`, `columns`, `rows`, `frameCount`, `filter`, `cell`, `colorSpace`, `alpha`, `rowOrder` and `transparentRgb`;
- `png`: `sha256` and `byteLength`;
- `scale`;
- `presets.standard` and `presets.subtle`: complete `BurstPreset`s, with every optional field written out.

## Consumer use

Zoo downloads the rolling `zoo-effects` release. It pins the release by the tar's SHA-256 and verifies it at build time with `bun scripts/pack-asset-bundle.ts --verify zoo-effects.tar --ref export.ref.json` ([asset-bundles.md](asset-bundles.md#release-distribution-and-consumer-pinning)). Per effect it then:

1. decodes the PNG to top-row-first RGBA bytes;
2. declares a `RendererEffectAtlas` with the descriptor's `width`, `height`, `columns`, `rows`, `frameCount` and `filter`, and a `resourceKey` that names the file, for example `zoo-effects:<png.sha256>`;
3. for each cue, submits a burst made of the chosen preset plus `id`, `atlas`, `origin`, `startTime`, a cosmetic `seed`, `scale` and an optional `color`/`opacity`.

The seed never comes from or advances game RNG. **Off / reduced motion:** submit no bursts, or set `effects.enabled: false`, which also releases the atlas textures. The `subtle` presets are the lighter setting. Publishing the release is a separate, explicit step.

## Tests

`test/zoo-effects.test.ts` runs in the ordinary `bun test` gate. It needs no Blender. It checks:

- every preset is inside the bounds of 3d-lab's `compileBurst`, and out-of-bounds presets are rejected;
- each atlas is a power of two with whole cells and 8–16 frames;
- every cell border is transparent with the declared hidden RGB;
- every frame but the last is visible and near the cell centre;
- dust and splash fade out by the last frame, and the leaf never disappears;
- the tar and the package verify, and the descriptor conforms to the schema;
- every packaged PNG decodes to exactly the baked pixels;
- an independent rebuild packs the same tar.

## Not covered here

- The owner's visual acceptance in the real Zoo park (zoo#86), and the Zoo side: pinning the release and choosing the cues.
- Publishing the `zoo-effects` release.
- The rest of #136: UI reward-feedback ingredients, a Raid Defense or My Farm cue, source-versus-baked comparisons through the owning evaluator, and more ingredients (sparks, impact marks, smoke).
