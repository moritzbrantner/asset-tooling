# Reward-feedback flipbooks

Baked artwork for ui's Pop/Pulse reward feedback ([ui#60](https://github.com/moritzbrantner/ui/issues/60), part of [#136](https://github.com/moritzbrantner/asset-tooling/issues/136)): a sparkle, a ring, a burst and a confetti strip, each in a `subtle` and a `strong` variant.

- **Consumer:** ui's `RewardBurst`, `SuccessPop` and `ProgressPop` (`src/components/patterns/pop-rewards.tsx`), and its Pulse interaction patterns. They're the runtime owner: timing, springs, particle count, distance, delay and lifecycle stay in ui's own recipes. This release supplies artwork only, with no preset of its own.
- **Source:** the frames in [`src/reward-effect-flipbooks.ts`](../src/reward-effect-flipbooks.ts), drawn by the deterministic 2D rasterizer [`src/effect-flipbook-raster.ts`](../src/effect-flipbook-raster.ts) that the [Zoo](zoo-effects.md) and [combat](combat-effects.md) flipbooks also use. The frames are lenses, circles, rings and round-capped lines, supersampled 4×4 per pixel. There is no randomness, no third-party art, no model, no Blender and no GPU.
- **Release:** one rolling release, `reward-effects` (Atlas Decision 7.1.5), never a numbered one.

## Build

```sh
bun scripts/build-reward-effects.ts --out <directory>
```

The build takes about two seconds. It writes:

- `<directory>/bundle/`: a `static-glb-png-v1` package (`asset.bundle@1`) of the eight strip PNGs;
- `<directory>/reward-effects.tar` and `.sha256`: the packed package, about 57 KB;
- `<directory>/reward-effects.descriptor.json`: the strip layouts;
- `<directory>/export.ref.json` and `lineage.json`;
- `<directory>/<role>-<variant>.png`: the bare strips;
- `<directory>/review/<role>-<variant>.png`: each strip at 2×, tinted violet, on a checkerboard, a light page and a dark page, with the cell borders marked.

A rebuild packs the same tar bytes. [`review/reward-effects/strips.jpg`](../review/reward-effects/strips.jpg) shows all eight review boards, top to bottom in the table's order.

## Strips

Every strip is 1024×64: 16 cells of 64 px in **one row**, played left to right. One row lets CSS step through the frames along x. Pixels are straight-alpha sRGB, and **every texel's RGB is white**: the strips are alpha masks, and the colour is whatever the UI tints them with. Each cell is transparent at least 2 px in from its border. Frame `k` shows normalized time `(k + 0.5) / 16`. Each strip plays once: it peaks early, and its last frame is blank, so the effect ends without a cut.

| Key | Look | `subtle` | `strong` | Suggested CSS size (subtle / strong) |
| --- | --- | --- | --- | --- |
| `sparkle.flipbook` | A four-point twinkle with long vertical and horizontal points and short diagonals. It pops in, turns slightly, shrinks and fades. | the star alone | adds a soft halo and two small satellite glints | 24 / 32 px |
| `ring.flipbook` | A ring that expands from the centre, thins and fades. | a thin ring | a wider ring that trails a faint second ring | 28 / 36 px |
| `burst.flipbook` | A central flash with radial rays that fly outward, shorten and fade. | 8 even rays | 12 rays, alternating long and short | 28 / 36 px |
| `confetti.flipbook` | One confetti strip that turns and tumbles about its long axis, its back face drawn lighter, and fades at the end. It stays centred: the consumer moves it. | one tumble | one and a half tumbles, larger | 14 / 18 px |

The 64 px cell is 2× density at the suggested size. The strong variant always covers more than the subtle one. ui could, for example, use `subtle` for its `subtle` level and `strong` for `satisfying` and `celebration`, but that mapping is ui's choice.

### Budgets

- **Download:** about 45 KB for the eight PNGs, 57 KB as a tar.
- **Texture memory:** each strip decodes to 256 KiB of RGBA8, 2 MiB for all eight. A page that only uses the sparkle needs 256 KiB.
- **Particles:** none are emitted here. ui's own recipes cap them (4, 8 and 12 particles today).

## Descriptor `reward-effects-descriptor-v1`

[`schemas/reward-effects-descriptor-v1.schema.json`](../schemas/reward-effects-descriptor-v1.schema.json) is the schema. At the top level:

- `consumer`: `ui Pop/Pulse reward feedback`;
- `tint`: `alpha-mask`;
- `playback`: `{ "loop": false, "frameTime": "(k + 0.5) / frameCount", "lastFrame": "blank" }`;
- `reducedMotion`: `omit`. Under reduced motion or with effects disabled, the consumer draws nothing. ui's `RewardBurst` already does this. No essential state may depend on these strips.

Each entry in `effects` has its `key` and `variant` in the bundle, a `role` (`sparkle`, `ring`, `burst` or `confetti`), a `description`, the `atlas` layout (`width`, `height`, `columns`, `rows`, `frameCount`, `filter`, `cell`, `colorSpace`, `alpha`, `rowOrder` and `transparentRgb`), the PNG's `sha256` and `byteLength`, and `cssSize`.

## Consumer use (ui)

ui must not import asset-tooling to render a button (ui#60). It vendors the strips it wants into its own optional entrypoint, after verifying the tar against its pin with `bun scripts/pack-asset-bundle.ts --verify reward-effects.tar --ref export.ref.json` ([asset-bundles.md](asset-bundles.md#release-distribution-and-consumer-pinning)). One way to draw a strip with a theme token, in CSS:

```css
.reward-sparkle {
  width: 32px;
  height: 32px;
  background-color: var(--primary);
  mask-image: url(sparkle-strong.png);
  mask-size: 1600% 100%;
  animation: reward-strip 480ms steps(16, jump-none) forwards;
}
@keyframes reward-strip {
  from { mask-position: 0% 0; }
  to { mask-position: 100% 0; }
}
```

`steps(16, jump-none)` shows each of the 16 frames once, and `forwards` holds the blank last frame. The duration, delay and movement come from ui's recipe.

CI publishes the release when a change to its recipe merges ([Publishing a rolling release](../README.md#publishing-a-rolling-release)).

## Tests

`test/reward-effects.test.ts` runs in the ordinary `bun test` gate. It needs no Blender. It checks:

- each strip is a power-of-two single row whose texels are all white, with transparent cell borders;
- every frame but the last is visible and centred, each strip peaks early and is blank by its last frame;
- the four roles differ in shape, the strong variant covers more than the subtle one, and the ring grows frame over frame;
- the tar and the package verify, and the descriptor conforms to the schema;
- every packaged PNG decodes to exactly the baked pixels;
- an independent rebuild packs the same tar.

## Not covered here

- Publishing the `reward-effects` release.
- ui's integration, its Storybook demonstration and the owner's visual check in Pop and Pulse ([ui#60](https://github.com/moritzbrantner/ui/issues/60)).
