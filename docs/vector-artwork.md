# Editable vector artwork and raster derivation

Part of [#135](https://github.com/moritzbrantner/asset-tooling/issues/135). Small original 2D pieces (tiles, rings, bursts/stars, simple tokens/icons) are authored as **editable SVG** and derived into transparent rasters through **one established rasterizer** whose identity is pinned in the build. The rasters are canonical RGBA8 images, so they feed the existing [PNG encoder](operations.md), [sprite atlas](sprite-atlases.md) and [selected bundle](asset-bundles.md) unchanged.

## Vector vocabulary

All four operations live in `asset-tooling/operations/generation/procedural-shapes` and write one canonical `image/svg+xml` `vector-image` with integer canvas size and no randomness:

| Operation | Shape | Geometry parameters |
| --- | --- | --- |
| `vector.procedural.rounded-rect@1` | tile, panel | `x`, `y`, `rectWidth`, `rectHeight`, `cornerRadius`, `fill` |
| `vector.procedural.circle@1` | filled token | `centerX`, `centerY`, `radius`, `fill` |
| `vector.procedural.ring@1` | target, halo | `centerX`, `centerY`, `radius`, `strokeWidth`, `stroke` |
| `vector.procedural.star@1` | star, burst, regular polygon | `centerX`, `centerY`, `points` (3–64), `outerRadius`, `innerRadius`, `rotationDegrees`, `fill`, `stroke` (`none` or colour), `strokeWidth` (0 exactly when `stroke` is `none`), `strokeJoin` (`miter`/`round`) |

Every operation also takes the canvas `width` and `height`. Colours are lowercase `#rrggbb`. Geometry that would leave the canvas, including half the stroke (and a miter join's reach, clipped by the explicit `stroke-miterlimit="4"`), fails instead of clipping. A star starts at the outer vertex pointing up and rotates clockwise; its vertex coordinates are written with at most three decimals, so the bytes are stable. A burst is a star with many points and a shallow inner radius.

Transparent padding belongs to the raster derivation below, not to the SVG.

## Raster derivation: `image.vector.rasterize@1`

`asset-tooling/operations/image/vector` renders one SVG at an explicit `width` × `height` plus `padding` transparent pixels on every side, giving a `(width + 2·padding)` × `(height + 2·padding)` canonical straight-alpha sRGB RGBA8 image.

- **Rasterizer:** [resvg](https://github.com/linebender/resvg) through the `@resvg/resvg-wasm` package (MPL-2.0), with geometric-precision anti-aliasing and system fonts disabled. The WebAssembly build gives the same pixels on every platform. The build identity records the package name, its version and the SHA-256 of its `.wasm` bytes, so a rasterizer change is a new build.
- **Size:** `width`/`height` must keep the SVG's aspect ratio exactly; derive 32, 64 and 128 px from a 64 × 64 source, for example.
- **Alpha:** resvg's premultiplied output is converted to straight alpha. Fully transparent texels are stored as `0,0,0,0`, and anti-aliased edges keep the fill colour, so filtering and atlas extrusion do not pull in a colour fringe.
- **Unsupported features fail with diagnostics.** The rasterizable subset is a root `<svg>` (SVG namespace, unitless integer `width`/`height`, optional `viewBox`) containing `g`, `circle`, `ellipse`, `rect`, `line`, `polyline`, `polygon` and `path`, with geometry, `transform` and plain presentation attributes, and `fill`/`stroke` limited to `none` or a hex colour. Text, fonts, images, gradients, patterns, filters, masks, clip paths, `<use>`, `style`/`class`/CSS, `url(...)` paint, DOCTYPE/entities and stray text are listed together in one error rather than silently flattened. `diagnoseSvgForRasterization(bytes)` returns the same list without rendering.

## Example

```sh
bun examples/vector-artwork/build.ts
```

It authors a puzzle floor tile, a hollow target ring, a 12-point reward burst and an outlined five-point star token as SVG, derives each at 32, 64 and 128 px with 2 px transparent padding, encodes them as PNG and packs the 64 px set into one sprite atlas. Outputs are disposable under `.artifacts/vector-artwork/` (`<id>.svg`, `<id>-<size>.png`, `atlas.png`, `atlas.json`, `evidence.json`). Repeating the example writes no changed files.

The tile, ring, burst and star differ by silhouette (square, hollow, many-pointed, five-pointed outlined), not only by hue. These are inspection fixtures; adoption in a game or UI component, and its approval at gameplay scale, belong to the consumer.
