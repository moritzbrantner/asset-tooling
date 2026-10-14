# Rigged source animation viewer

First slice of [#111](https://github.com/moritzbrantner/asset-tooling/issues/111) under Decisions 1.2.1 and 2.1.1 of the [Decision Atlas](decisions/atlas.md): a Pages route for inspecting a pinned rigged catalog source and its asset-owned animation clips. It replaces the auto-rotating static preview for these sources. This slice shows the **original source only**. Synchronized source-versus-processed comparison follows once #110's processed character exists; until then the page says so rather than showing a second copy of the same bytes. Appearance swapping is the later workbench slice (#127).

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
- A note says that the processed comparison arrives with #110.

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

Processed comparison, skeleton/socket debug views, wireframe and material views, and approval workflow are follow-ups under #111 and #127.
