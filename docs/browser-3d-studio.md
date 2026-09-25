# Browser 3D studio

Asset-tooling ships one browser-local image-to-3D surface that is used both by
GitHub Pages and by local development. It is not a hosted inference client.

## Run locally

From a checkout with Bun 1.4.2:

```sh
bun run studio
```

This builds the same static Pages artifact that is deployed by CI and serves it
at:

```text
http://127.0.0.1:4173/generate/
```

No Python environment, local model ZIP, CUDA installation, or application server
is needed for this browser path.

## GitHub Pages

The deployed route is:

```text
https://moritzbrantner.github.io/asset-tooling/generate/
```

GitHub Pages only serves static files. The source image, intermediate tensors,
generated mesh, and exported GLB stay in the browser.

## Explicit model acquisition

The browser page does not hide a model download behind the Generate action.

1. Choose **Prepare model**.
2. The page checks for WebGPU and `shader-f16`.
3. It acquires the six browser SF3D artifacts from the exact
   `needle-tools/SF3D-webgpu` revision declared in
   `src/browser/sf3d-model-manifest.ts`.
4. Every fresh artifact is checked against its expected byte length and SHA-256.
5. Cache Storage is acceleration only. A cache hit is read and SHA-256 verified
   again before use; a mismatching entry is deleted and reacquired.
6. Only after the model is prepared does **Generate GLB** become available.

The current artifact set is 1,730,100,305 bytes (about 1.61 GiB). A browser can
decline to persist entries because of storage quota; that affects reuse, not the
correctness of the current run.

The ONNX Runtime and Three.js browser modules are version-pinned in the generated
page. The SF3D inference session requests only the WebGPU execution provider.
There is no silent CPU, WASM, remote API, or server fallback.

## Image preparation

Images with meaningful alpha preserve that alpha.

For fully opaque images, the browser reuses asset-tooling's
`borderWhiteToAlphaRgba8` implementation with the same 224/250 thresholds used
by the local Stable Diffusion → SF3D batch. It removes only the border-connected
near-white background and preserves enclosed bright details.

This deliberately does not pretend that arbitrary scene segmentation is solved.
For photographs with a non-white background, prepare a cutout first.

## Output

SF3D runs tokenizer → backbone → decoder → marching tetrahedra → vertex-color
sampling in the browser. The final mesh is exported as binary glTF and can be
previewed and downloaded without uploading it.

The browser artifact uses vertex color plus fixed metallic/roughness defaults
from the ONNX browser conversion. It is a useful direct reconstruction output,
not a replacement for the later production normalization, LOD, collision, or
material-validation stages.

## Runtime split

- **Stable Fast 3D WebGPU**: browser-local and available on GitHub Pages.
- **Stable Fast 3D Python**: existing local backend for the provenance-oriented
  offline pipeline.
- **TRELLIS.2**: remains local Linux/CUDA only and is intentionally absent from
  the static Pages backend list.

The browser runtime is adapted from `Pixel11211/sf3d-webgpu` at the immutable
commit recorded in the browser manifest. Its source is MIT licensed. Browser
model artifacts are derivative Stable Fast 3D materials governed by the
Stability AI Community License. See `THIRD_PARTY_NOTICES.md` and
`licenses/STABILITY_AI_COMMUNITY_LICENSE.md`.
