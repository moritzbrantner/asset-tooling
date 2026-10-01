# Static GLB icons and thumbnails

`asset-tooling/recipes/render-derivatives` declares image derivatives of existing self-contained static core-glTF GLB AssetRefs. It uses the existing checked GLTF import policy and `external.blender.script@1` backend. Blender remains authoritative for geometry, PBR materials, camera projection, lighting and pixels. This recipe adds neither a renderer nor another mesh representation.

```ts
import {
  prepareRenderDerivativeRecipe, readRenderDerivativeRecipeSource,
  RENDER_DERIVATIVE_PRESETS,
} from "asset-tooling/recipes/render-derivatives";

const authoring = await readRenderDerivativeRecipeSource();
const prepared = await prepareRenderDerivativeRecipe(absoluteObjectStoreRoot, {
  assetId: "example.item-icon", source: existingGlbAssetRef,
  parameters: { ...RENDER_DERIVATIVE_PRESETS.icon, width: 128, height: 128 },
  scriptSha256: authoring.sha256, blenderVersion: authoring.blenderVersion,
});
// In an explicit spec workspace, reconcile authoring.bytes as render_static_glb.py,
// prepared.sourceBytes as source.glb, and prepared.spec as asset.json.
// Call the existing generateAsset / verifyAsset APIs on that asset.json.
```

Preparation verifies source content and validates it through the existing static glTF Transform/Khronos boundary without rewriting it. Version 1 supports exactly one source scene, embedded core PBR resources and either its meshes or explicitly selected uniquely named mesh nodes. Named selection is by original glTF node name; hierarchy groups, duplicate names and absent nodes are diagnosed. Blender's glTF import extension hook binds those original nodes to imported objects, preserving selection when Blender truncates or disambiguates long/multibyte object names. Source cameras/lights do not control the derivative. Skins, animations, morphs, extensions and external resources are rejected by the existing static policy. Import/package other supported sources through their existing operations first; this renderer never acquires dependencies.

`prepared.source` retains the original AssetRef; sourceBytes are exactly the verified input, and sourceSummary/resources record the existing validator's inventory. Copy those bytes into the declared workspace input. The generated receipt records their pin, script identity, all parameters, Blender build/executable/Python/runner identity, environment and output hash. Store a deliberate PNG derivative as an ordinary image AssetRef with source/receipt lineage; the example demonstrates this. A source, camera, light or sampling edit changes its spec/cache identity. Dependencies are checked before ordinary generation-cache reuse, and verify always replays Blender independently of that cache.

## Controls and coordinate contract

The packaged renderer enforces the same exact fields, types and ranges when a spec is authored directly; invalid controls fail before importing Blender or reading the source. Direct specs also receive source closure, static/core-profile and resource-budget checks before scene import. This uses Blender’s own header-only GLB/JSON parser and header-only PNG/JPEG dimension inspection; it rejects all external/data resource URIs, unsupported extensions, skins, clips and morphs. Ordinary recipe preparation additionally runs the existing Khronos validator.

All original version-1 controls are required. An optional shared orthographic frame is additive; omitting it retains the existing independent auto-fit behavior. The immutable icon, thumbnail and perspective presets supply defaults; replace nested arrays/objects to edit them.

- Dimensions: integer width/height in 1–1024; sample budget 1–64; integer Cycles seed 0–2,147,483,647. Source transport is at most 64 MiB, 4096 nodes and one million source or selected instantiated triangles. Before validator scans or glTF Transform decoding, raw accessor declarations are limited to three million elements per accessor, one million distinct source POSITION vertices, and 64 MiB combined decoded storage (conservatively reserving four bytes per scalar component). This includes unused and sparse accessors. Before Blender starts, every embedded texture must have known positive dimensions no greater than 4096 per axis, and all imported textures together must fit 16,777,216 decoded pixels (64 MiB of nominal RGBA8 pixel storage; this is not a bound on total Blender memory). Unselected-node textures count because Blender imports the entire source.
- Selection: `{ type: "scene" }` or `{ type: "nodes", names: [...] }`, with 1–64 distinct names. Node-name order is canonicalized; filename order has no selection meaning.
- Camera: a finite nonzero viewDirection from target **toward camera**, expressed in glTF right-handed Y-up axes, plus projection `{ type: "orthographic" }` or `{ type: "perspective", horizontalFovDegrees: 10..100 }`. Directions parallel to Y-up and degenerate projected bounds fail deliberately.
- Framing: padding in 0–0.4 as a fraction of each image axis. The target is the selected world-axis-aligned bounding-box center. Projected bounding-box corners fit within the padded image; conservative empty space is intentional. Orthographic horizontal span accounts for image aspect ratio. Perspective distance fits every corner at its own depth. Pixel aspect is one, with clipping planes derived from source extent.
- Lighting: finite nonzero lightDirection in the same glTF axes; lightEnergy in 1–10,000 **reference watts for a one-meter source diagonal**, and lightSize in 0.01–10 as a multiplier of that diagonal. Lamp distance is twice the diagonal; actual power scales with its square so tiny catalog sources do not receive a meter-scale lamp. WorldColor contains linear RGB in 0–1, worldStrength is 0–2, and background explicitly selects transparent or opaque.
- Color/sampling: version 1 fixes Cycles CPU, no adaptive sampling or denoiser, Standard view transform, neutral look, gamma one, exposure in -4..4, and baked straight-alpha sRGB RGBA8 PNG. GPU rendering and additional tone policies are unsupported here.

Observations include output dimensions and logical center pivot (fractional on odd sizes), top-left normalized projected bounds, projection/padding, source bounds in Blender Z-up, selected mesh/material counts, view direction, alpha/color policy and sample/seed controls. Source geometry/origin remains untouched; no universal source-origin rule is imposed on standalone 2D artwork. The default frames each request independently. Shared orthographic requests instead keep a declared world target, physical image width and projected logical pivot, without changing the source geometry or origin.

## Shared framing and declared directions

For a static state or direction set, add a saved frame in glTF **world** right-handed Y-up coordinates:

```ts
const parameters = {
  ...RENDER_DERIVATIVE_PRESETS.icon, width: 256, height: 384,
  framing: {
    type: "shared-orthographic", center: [0, 0.9, 0],
    horizontalSpan: 1.5, pivot: [0, 0, 0],
  },
};
```

`center` is the fixed camera target. `horizontalSpan` is the physical width of the entire image, including padding: it is not independently fitted to each source. World units per pixel are exactly `horizontalSpan / width`; height follows the image aspect ratio. The selected source must fit within the declared padding from every requested direction. A clipped source or a logical pivot outside the image is diagnosed before pixels are exported, preserving the last accepted output/receipt. Expand the declared span or adjust the target explicitly. Span must be finite in 0.000001–100,000; center/pivot coordinates are finite in −100,000–100,000. Perspective shared frames are deliberately unsupported in this static slice.

The renderer projects the supplied world-space `pivot` into top-left source-pixel coordinates through Blender's camera. Fractional pivots are intentional; native camera float precision can introduce small subpixel differences. Source geometry and ground anchors are untouched. Camera depth/clipping accommodates the selected source independently of the shared image width. Lamp placement/power use the common frame extent, so a shorter state does not silently receive a differently scaled light.

`prepareDirectionalRenderDerivativeRecipes(root, { ...ordinaryRenderOptions, parameters, directions })` validates one source and declares 1–16 static renders. Each direction is `{ id, viewDirection }`, with a unique lowercase portable ID (up to 32 characters). Directions are returned in code-unit ID order; reordering them or adding a sibling preserves existing spec identities. A shared orthographic frame is required. Returned entries retain the ordinary preparation fields plus `directionId`; asset IDs append `.<directionId>` to the supplied base ID. Each render belongs in its own explicit workspace. No filename order, animation timing or source-facing convention is inferred: directions still point from the world target toward the camera. The example names camera +Z/+X/−Z/−X views front/right/back/left and explicitly declares their elevation.

Observations add the frame, `gltf-world-y-up` coordinate space, world units per pixel and zero trim offset to the ordinary source bounds/configuration evidence. Store those observations, the returned direction ID and complete original source ref on each PNG AssetRef. If packing an atlas, pass each actual projected pivot to the existing sprite-atlas operation; its source dimensions and trim offsets retain that anchor after packing. The PNGs remain usable independently.

Blender's native render PNG contains Date/RenderTime/Cycles timing metadata even with visible stamps disabled. The packaged authoring script transfers its already baked sRGB RGBA8 pixels through Blender's image API into a fresh byte image before saving. This drops volatile render text without applying another tone transform or inventing a codec. A native-versus-clean PNG comparison on the textured fixture confirmed identical RGBA bytes; tests reject text chunks and exercise partial-alpha edges/material color. Provenance stays in AssetRefs/receipts rather than volatile raster annotations.

The declared reproducibility expectation remains **approximate**. On the tested pinned Blender/CPU setup, the quad fixtures and all six example derivatives exactly replayed after metadata cleanup. That observed byte comparison is evidence for those runs, not a cross-CPU/GPU or arbitrary-material guarantee. The existing verifier reports any changed pixels/observations honestly.

## Actual example and limits

From a Git LFS-hydrated checkout, first run `bun examples/rocks/build.ts`, then `bun examples/render-derivatives/build.ts` with pinned Blender configured. The latter uses the canonical storage resolver for the material-bearing Khronos Avocado fixture and the existing rounded rock AssetRef. It produces six icon/thumbnail/perspective PNGs, receipts/verification evidence and an output-ref inventory under ignored `.artifacts/render-derivatives/`. It also decodes only the two selected icons with the existing FFmpeg operation and reuses `image.sprite-atlas@1` for an optional atlas. Each icon remains independently usable. Codec build identities are recorded; FFmpeg is required only for this example's atlas derivation and inspection tests, not for the Blender render recipe. Outputs reconcile unchanged files on repeat; they are inspection artifacts, not a new distribution package.

`python scripts/render-derivative-review.py` uses Pillow to compose the actual PNGs over a checkerboard for offline review. It does not generate the source derivatives. Focused Blender tests use an independently authored translated quad and near/far geometry to check orthographic/perspective fit, odd-size pivots, selected-only rendering, PNG dimensions/alpha/color, metadata cleanup, cache reuse, unchanged source/output, exact replay on the test runtime and tamper rejection. The ordinary gate covers source policy, configuration and package shape without rendering; the existing pinned Blender lane exercises actual images.

This is the first static derivative slice of #142. Shared static framing, declared direction sets and selected PNG/atlas packaging are demonstrated in `examples/directional-crops/`. Pose/clip/portrait sources, cancellation/lifecycle controls and actual Farm/product acceptance remain follow-ups. Consumer repositories are read-only in this loop, and the Avocado is a canonical technical fixture rather than a newly approved game-art direction.

Meshes whose original materials are provably invisible are excluded from pixel rendering while remaining in source bounds and camera framing. A zero BLEND alpha factor or MASK factor below its cutoff cannot produce a visible fragment, regardless of texture alpha. This prevents Cycles' finite transparent-ray limit from turning dense hidden foliage into black silhouettes. OPAQUE materials, MASK cutoff zero and mixed visible/invisible mesh primitives remain rendered; the renderer does not assume that arbitrary alpha textures are fully transparent.
