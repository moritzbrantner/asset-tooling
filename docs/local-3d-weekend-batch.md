# Local weekend 3D batches

The weekend batch runner turns a Markdown list of object descriptions into a
sequential local asset-generation run.

It deliberately contains no ChatGPT, fal.ai, or other hosted inference call.
After the local models have been acquired, a batch consumes GPU/CPU time only.
The runner is designed to be started once and left alone.

## Queue

Edit `WEEKEND_MODELS.md`.

Each active job is one checkbox line:

```text
- [ ] raid-defense.town-hall :: fortified medieval town hall with a broad silhouette
```

The left side is a stable asset id. The right side is the object-specific prompt.
Normal Markdown is ignored. Checked entries are not run.

The queue order is the execution order. The runner does not parallelize model
inference, so Stable Diffusion and the selected reconstruction backend do not
compete for GPU memory. `reconstructionBackend` is either `stable-fast-3d` or
`trellis2`; omitted v1 values retain the original `stable-fast-3d` behavior.

## One-time local setup

1. Install Bun 1.4, Python, FFmpeg/FFprobe, a PyTorch build appropriate for the
   machine, and the dependencies for Stable Diffusion plus the reconstruction
   backend you intend to use.
2. Acquire all model/source dependencies **before** generation. Do not put model
   downloads into the weekend loop. Keep the resulting ZIPs under `models/local/`;
   that directory is intentionally git-ignored.
3. Choose a configuration:
   - copy `weekend-3d.config.example.json` for Stable Fast 3D;
   - copy `weekend-3d.trellis2.config.example.json` for TRELLIS.2 and the
     dedicated `WEEKEND_PROPS.md` queue.
4. For Stable Fast 3D, provide the Diffusers pipeline plus pinned SF3D source,
   model/config, and DINOv2 bundles.
5. For TRELLIS.2, provide the Diffusers pipeline plus the exact TRELLIS.2 source,
   TRELLIS.2-4B model snapshot, the explicitly declared legacy sparse decoder,
   and the DINOv3 image-encoder snapshot. TRELLIS.2 v1 also needs its Linux/CUDA
   runtime extensions. DINOv3 is gated and must be acquired only after accepting
   its provider terms.
6. Run the doctor:

```sh
bun run weekend:3d:doctor
```

The doctor verifies the queue, exact model bytes, FFmpeg, Stable Diffusion, only
the selected reconstruction adapter, and its requested accelerator. On its first
successful run it writes the configured output directory's `model-lock.json`,
pinning Stable Diffusion plus only the selected reconstruction backend's bundle
hashes and backend identity.

If you intentionally replace one of those model bundles, inspect the change and
accept the new bytes with:

```sh
bun run weekend:3d -- --doctor --refresh-lock
```

## Friday dry run

Before leaving the machine unattended:

```sh
bun run weekend:3d -- --dry-run
```

This prints every active asset, its deterministic derived seed, and its final
combined prompt without executing inference.

To validate the whole path on one object:

```sh
bun run weekend:3d -- --max-items 1
```

## Weekend run

```sh
bun run weekend:3d
```

For every queue item, the runner executes these stages in order:

1. local Stable Diffusion concept image at 512×512;
2. canonical image decode;
3. deterministic removal of the border-connected near-white background;
4. prepared RGBA PNG;
5. the selected local reconstruction backend:
   - Stable Fast 3D for the lighter textured path; or
   - TRELLIS.2 for the heavier PBR path with base color, metallic, roughness,
     and baked alpha data.

Both paths store the resulting GLB as the same `mesh` stage, so checkpoint/resume
and downstream processing remain backend-independent.

After every stage, its content-addressed `AssetRef` is written to
`build/weekend-3d/state.json`. If the process or computer stops, rerun the same
command. Existing stage objects are hash-verified and reused. A missing or
corrupt stage invalidates that stage and all later stages, not earlier good work.

A failed object is recorded and the batch proceeds to the next object. At the
end, failures cause a non-zero exit code but do not erase successful jobs.

## Outputs

Each completed item is materialized under:

```text
build/weekend-3d/<asset-id>/
  concept.png
  prepared.png
  model.glb
  job.json
```

The continuously updated human-readable summary is:

```text
build/weekend-3d/REPORT.md
```

Generated data stays under the existing ignored `build/` and
`.asset-tooling/` namespaces. Promote a generated asset into the durable
catalog only after reviewing it.

## Useful controls

Run one item:

```sh
bun run weekend:3d -- --only raid-defense.town-hall
```

Run at most five active items:

```sh
bun run weekend:3d -- --max-items 5
```

Use another local configuration:

```sh
bun run weekend:3d -- --config my-weekend.local.json
```

## Reproducibility and cost behavior

The item seed is derived from the asset id and object prompt. The job identity
also binds the prompt framing, selected reconstruction backend, only that
backend's exact model/source hashes and controls, and the asset-tooling source
fingerprint. Switching from Stable Fast 3D to TRELLIS.2 therefore creates a new
job identity rather than silently treating old output as current.

The normal batch path performs no network request. Network/model acquisition is
a separate setup step. This keeps unattended generation independent from API
credits, chat sessions, and token budgets.
