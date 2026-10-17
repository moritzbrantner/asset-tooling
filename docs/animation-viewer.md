# Rigged source animation viewer

First slice of [#111](https://github.com/moritzbrantner/asset-tooling/issues/111) under Decisions 1.2.1 and 2.1.1 of the [Decision Atlas](decisions/atlas.md): a Pages route for inspecting a pinned rigged catalog source and its asset-owned animation clips. It replaces the auto-rotating static preview for these sources. This route shows the **original source only**. The synchronized source-versus-processed comparison of the Ranger is its own route, described in [Ranger comparison](#ranger-comparison). Appearance swapping is the later workbench slice (#127).

The viewer is presentation and evidence. It never decides asset identity, animation math or approval. It uses the shared 3d-lab renderer (`@moritzbrantner/three-d-renderer`, `./inspection-character` export, commit-pinned as a git dev dependency in `package.json`) for pin verification, parsing, skinning and clip sampling. That export is inspection-only: it verifies the source's SHA-256 and byte length before parsing and never carries production-import provenance. The viewer bundles the renderer, three.js and the renderer's WASM pose module into `viewer/`, so it needs no CDN. It adds no glTF or skin implementation of its own.

## Route and eligible assets

- Route: `viewer/?asset=<catalog source id>` in the built Pages site (`dist/pages/viewer/index.html`), including on the deployed site at `https://moritzbrantner.github.io/asset-tooling/viewer/?asset=…`.
- Eligible sources are catalog `mesh` sources whose media type is `model/gltf-binary` or `model/gltf+json`, which carry both `skinning` and `animation` tags, and which pin `sha256` and `byteLength`. Today these are `khronos.riggedfigure-glb` and `khronos.simpleskin-embedded-gltf`.
- Each eligible asset page links to its viewer as **Inspect animation**. The gallery and other asset pages are unchanged.
- The page loads the source from its catalog URL and checks the fetched bytes' SHA-256 and byte length against the catalog pin **before** rendering. A mismatch never renders.

## Controls

All controls are operable by keyboard, with visible labels and focus.

- **Clip:** a labelled select listing every clip by name, or `Clip N` for an unnamed clip, together with its duration. The first clip is selected by default.
- **Play / Pause:** a single toggle button. Playback loops the selected clip.
- **Time:** a labelled numeric input in seconds (step 0.001) and a range slider over `[0, duration]`, kept in sync. Entering a time pauses playback and shows exactly that time: the renderer is seeked to it, and the displayed time equals the input. Out-of-range input clamps to `[0, duration]`, and the clamped value is displayed.
- **Rest pose:** a toggle that pauses playback and shows the bind pose without the clip applied. Turning it off restores the previous clip time.
- **Camera presets:** buttons **Front**, **Side**, **Back** and **Gameplay**. Gameplay is a farther, elevated three-quarter view at approximate game distance. All presets frame the asset's bounds.
- **Orbit and zoom:** drag to orbit and use the wheel to zoom. Keyboard equivalents are the arrow keys to orbit and `+`/`-` to zoom while the canvas has focus. The canvas is focusable and labelled.

The page URL keeps `asset`, `clip` (index), `t` (seconds, when paused) and `view` (preset), updated with `history.replaceState`. Reloading restores the same paused frame, clip and preset. Playback runs in a `requestAnimationFrame` loop, not in per-frame DOM re-rendering. The time display updates at most once per animation frame.

## Information shown

- The displayed artifact is always identified: catalog id, title, `Original source`, the short SHA-256 and the license/attribution.
- Clip name and duration, the current time, and the model bounds in metres from the renderer's root object.
- Full provenance (catalog entry and URL) sits inside a collapsed `<details>`.
- A note links to the [Ranger comparison](#ranger-comparison).

## Failures

Each failure shows a `role="alert"` message, renders no model, and offers a **Retry** button where retrying makes sense:

- unknown or ineligible `asset` id;
- network failure or HTTP error;
- hash or length mismatch, which is never rendered;
- renderer parse failure;
- a source with no animation clips. This one is reported as unsupported for this viewer, and the rest pose is not shown either.

Navigating to another asset, or reloading, disposes the previous renderer asset and instance and cancels any in-flight load. A late response from a previous asset can never replace the current one.

## Layout

At widths of 900px and above, the canvas sits beside a control panel. At narrow phone widths (390px), the controls stack below the canvas. The page has no horizontal scrolling at either width. The page follows the existing Pages theme and supports light and dark color schemes.

## Evidence

- Real Chromium (Playwright) tests against the built Pages site cover:
  - selecting a clip;
  - play and pause, checking that the time advances only while playing;
  - exact seek: the canvas pixels differ between distinct times of an animated clip and are identical when the same time is re-entered;
  - the rest pose;
  - the camera presets;
  - keyboard-only operation;
  - URL restore after reload;
  - repeated navigation between the two eligible assets without errors;
  - each failure case;
  - normal and narrow layouts.

  Network sources are served from local copies of the pinned files in tests, and hash checks still apply.
- Screenshots of the normal and narrow layouts accompany the PR.
- The ordinary gate (`bun run check`) still passes, and the Pages build produces the viewer.

## Ranger comparison

Route: `compare/ranger/` (`dist/pages/compare/ranger/index.html`). It follows the owner answers on #111 from 2026-10-17 (Q1 = A, Q2 = A). Four views share one clip, one time and one camera, so poses can be compared directly:

1. **Original source, rest pose:** the canonical Universal Base Characters body and the Male_Ranger outfit `.gltf` files with every referenced buffer and texture, exactly as promoted in #109, including the two [declared substitutions](humanoid-sources.md#declared-substitution). The source ships no clips, so this view always shows the rest pose, and its caption says so. Two checkboxes show or hide the body and the outfit.
2. **Source motion:** the mannequin of the clip's library (UAL1 or UAL2 GLB) playing the selected clip under its source name, before retargeting.
3. **Processed:** the `humanoid.ranger.male/default` entry of the pinned [`humanoid-ranger-male-v6`](humanoid-ranger.md) release, playing the same clip. The clip list is that bundle's `humanoid-clips` attachment.
4. **Primitive-built archer:** the `archer` OBJ of the [medieval character kit](medieval-character-kit.md) (scale 0.001), as the static debug fallback it replaces.

Every view uses the same camera framing (a human-sized volume centred 0.9 m up), the same presets (Front, Side, Back, Gameplay), and the same orbit and zoom from any view. Controls are Clip, Play/Pause, Rest pose (views 2 and 3 show their rest pose), the numeric time and the slider. The URL keeps `clip` (by name), `t` (when paused) and `view`. Each caption identifies its artifact: catalog ids and short SHA-256s for the source and library, the release tag, tar SHA-256 and entry for the bundle, and the OBJ SHA-256 for the archer.

**Verification:** the renderer's inspection-only entry checks the pin of every source document and resource before parsing (3d-lab `aad5d85`). The page checks every bundle file it reads against the manifest SHA-256 and checks the archer OBJ against its pin. A mismatch shows an alert and renders nothing.

**Data:** `scripts/build-catalog-pages.ts` writes `data.json` and the pinned files with `writeRangerComparisonData` (`src/ranger-comparison.ts`). It copies the hydrated canonical members after checking each against its catalog pin. It also unpacks the release tar after checking it against `RANGER_COMPARISON_BUNDLE` (tar SHA-256 and manifest AssetRef), and it writes the archer OBJ. An ordinary build without hydrated payloads or `ASSET_TOOLING_RANGER_BUNDLE_TAR` skips the data, and the page then reports that it has none. The Pages workflow hydrates only these members, downloads the pinned release and sets `ASSET_TOOLING_REQUIRE_RANGER_COMPARISON=1`, so a missing or mismatched input fails the build. The page loads about 79 MB, mostly the source's 4096 px textures.

**Evidence:** `test/browser/ranger-comparison.spec.ts` (real Chromium; it skips when the build has no data) checks the four identified views and the 19 clips, and that one clip and time move the source-motion and processed views while the source and archer stay unchanged. It also checks the UAL2 mannequin for a UAL2 clip, presets across views, URL restore after a reload, play and pause, and normal and narrow layouts without horizontal scrolling. `test/ranger-comparison.test.ts` covers the unavailable, required and wrong-tar cases. Matching poses are presentation, not visual approval. The owner judges #108 and #110 here.

Skeleton/socket debug views, wireframe and material views, and approval workflow are follow-ups under #111 and #127.
