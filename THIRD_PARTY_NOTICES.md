# Third-party notices

## Browser Stable Fast 3D source adaptation

The browser-local Stable Fast 3D inference structure in `src/browser/sf3d-webgpu.ts`
is adapted from `Pixel11211/sf3d-webgpu` at commit
`751e6642761466dbf15ed1e4c53ef6ed4db12b40`.

That source is MIT licensed. A copy of its license is included as
`licenses/sf3d-webgpu-source-MIT.txt`.

Asset-tooling changes include:

- immutable model-revision pinning instead of a moving `main` model URL;
- SHA-256 verification of fresh model downloads and browser-cache hits;
- fail-closed WebGPU-only execution instead of an implicit WASM fallback;
- reuse of asset-tooling's border-connected white-background matte;
- integration into the asset-tooling GitHub Pages/local studio surface.

## Stable Fast 3D browser model artifacts

The browser runtime acquires the files declared by
`src/browser/sf3d-model-manifest.ts` from
`needle-tools/SF3D-webgpu` at immutable revision
`56d2f58d27395b0be9c633671b439b4aac482549`.

Those files are derivative Stable Fast 3D model materials and are governed by
the Stability AI Community License. A copy is included as
`licenses/STABILITY_AI_COMMUNITY_LICENSE.md`.

Required attribution:

> This Stability AI Model is licensed under the Stability AI Community License, Copyright © Stability AI Ltd. All Rights Reserved

The derivative ONNX artifacts were produced by needle-tools by exporting model
components to ONNX, converting the backbone to FP16, and serializing the
runtime grid and color-head data for browser-compatible inference.

**Powered by Stability AI.**

## Zoo animal models

The zebra and giraffe in the `zoo-animals` bundle are the existing low-poly models
of [moenarch-games/zoo](https://github.com/moenarch-games/zoo) at commit
`a357730f56407024b71189ee2d7937d69007ec28`, packaged as authored. They are
MIT licensed ([owner statement](https://github.com/moritzbrantner/asset-tooling/issues/128#issuecomment-6719424007)).
The notice is `licenses/zoo-animals-MIT.txt` (`Copyright (c) 2026 moritzbrantner`)
and travels with the bundle.
