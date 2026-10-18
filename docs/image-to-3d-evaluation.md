# Image-to-3D evaluation

[#122](https://github.com/moritzbrantner/asset-tooling/issues/122) asks where model-assisted creation produces usable game assets, judged on production acceptance and clean-up cost rather than "a GLB came out". Owner answers of 2026-10-18:

- **Models:** start with TripoSR only (MIT, already local). Stable Fast 3D is added later, once the owner provides a Hugging Face token. TRELLIS.2 needs 16–24 GB of VRAM and cannot run on the local RTX 3060 Ti (8 GB).
- **Workload:** clean renders of existing CC0 kit assets, so every reconstruction has a ground truth.

## Harness

[`examples/image-to-3d-eval/`](../examples/image-to-3d-eval/) holds the harness:

| File | Purpose |
| --- | --- |
| `cases.json` | The five ground-truth cases and their gameplay camera distances. |
| `providers.json` | The providers and their parameters. Stable Fast 3D is listed with status `pending-owner-token`. |
| `render_view.py` | Renders the prepared input view: front-left, 512 px, the asset filling 85 %. RGB over 50 % grey for TripoSR; RGBA for providers that take it. |
| `compare.py` | Aligns the result to the ground truth (24 orientations × 8 yaws, best silhouette IoU on coarse views; height-matched and centred), then measures it and renders the gameplay comparison. |
| `run.ts` | Runs every ready provider through the provider-neutral `mesh.image-to-3d.generate@1` and rebuilds `report.md` from every run so far. |

`compare.py` records:

- silhouette IoU from six views;
- triangle and vertex counts;
- loose parts and non-manifold edges;
- whether the result has UVs, textures or vertex colours;
- a side-by-side render at the case's gameplay distance.

Adding Stable Fast 3D later is a configuration change: set its revision and status in `providers.json`, pass `--bundle stable-fast-3d:source=…,model=…,tokenizer=…`, and the report gains its rows. The TripoSR runs are not repeated.

```sh
PATH=<triposr venv>/bin:$PATH ASSET_TOOLING_BLENDER=<blender> \
  bun examples/image-to-3d-eval/run.ts --kit <greyhaven bundle> --ranger <ranger bundle> --out <dir> --bundle triposr:model=<triposr bundle.zip>
```

The TripoSR bundle has the format of [triposr.md](triposr.md): `tsr/` from the TripoSR source, plus `config.yaml`, `model.ckpt` (Hugging Face revision `5b521936b01fbe1890f6f9baed0254ab6351c04a`) and `dino/config.json`.

The local runtime is Python 3.12 with torch 2.8.0+cu128, transformers 4.35, trimesh 4.0.5, numpy < 2 and scipy < 1.14. torchmcubes is built from source; current compilers reject its `lerp` helper, so that helper is renamed before building.

The adapter now resolves `hf_hub_download` for a bundled local model directory. Current huggingface_hub rejects a path as a repo id, and that broke the bundled-DINO contract.

## Results (TripoSR, 2026-10-18, RTX 3060 Ti, `mcResolution` 256)

| Case | Category | Mean silhouette IoU | Triangles (result vs truth) | Loose parts / non-manifold edges | Surface | Time |
| --- | --- | --- | --- | --- | --- | --- |
| rock | rock | 0.83 | 152,523 vs 342 | 1 / 613 | vertex colours | 16.6 s |
| pine | tree | 0.63 | 107,779 vs 3,947 | 53 / 847 | vertex colours | 21.1 s |
| barrel | container prop | 0.87 | 147,291 vs 824 | 8 / 433 | vertex colours | 20.7 s |
| lantern | decorative prop | 0.34 | 48,337 vs 2,822 | 11 / 153 | vertex colours | 15.4 s |
| shield | equipment item | 0.58 (front 0.89, side 0.31) | 66,489 vs 1,706 | 3 / 165 | vertex colours | 19.6 s |

There is no statue among the free kit assets, so the five categories are rock, tree, container prop, decorative prop and equipment item.

**Findings:**

- **Shape:** compact, convex shapes come back well from a single view. The rock and barrel score 0.83–0.87. Thin or open structures do not: the lantern's chain and bracket, and the shield, whose side and top silhouettes are invented thickness. The pine's branch tiers come back as blobs.
- **Clean-up cost** is high for every case, with no automatic way through:
  - The triangle counts are 20–440 × the kit's counts, so every result needs decimation or retopology. The Blender LOD recipe would have to go far below its 5 % floor.
  - There are many non-manifold edges, and the thin and branchy cases come in loose parts.
  - The results have vertex colours only: no UVs, no textures and no PBR. A game asset needs an unwrap and a bake.
- **Look:** at the gameplay camera, the colours are washed out and the surfaces read as soft, lumpy clay next to the hand-made kit.
- **Hardware and time:** each run takes about 15–21 s on the 8 GB card.

**Recommendation:** TripoSR is not a production source for this kit. None of the five results meets the art baseline without manual rebuilding, so none was sent through the finishing path. At most it is a quick blockout or reference for chunky organic props (rocks, barrels), to be re-authored. Re-run this harness with Stable Fast 3D once the token arrives: it produces textured, remeshed output and should cut the UV and bake clean-up.
