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
inference, so Stable Diffusion and Stable Fast 3D do not compete for GPU memory.

## One-time local setup

1. Install Bun 1.4, Python, FFmpeg/FFprobe, a PyTorch build appropriate for the
   machine, the Python dependencies required by the existing Stable Diffusion
   and Stable Fast 3D adapters, and the Stable Fast 3D native extensions.
2. Acquire the model/source dependencies **before** generation. Do not put model
   downloads into the weekend loop. Keep the resulting ZIPs under `models/local/`;
   that directory is intentionally git-ignored.
3. Copy `weekend-3d.config.example.json` to `weekend-3d.local.json`.
4. Put the four ZIP bundles at the paths configured there:
   - a complete local Diffusers pipeline;
   - the pinned Stable Fast 3D source containing `sf3d/`;
   - Stable Fast 3D `config.yaml` + `model.safetensors`;
   - the complete local DINOv2 tokenizer model.
5. Run the doctor:

```sh
bun run weekend:3d:doctor
```

The doctor verifies the queue, exact model bytes, FFmpeg, Python adapters and the
requested accelerator. On its first successful run it writes
`build/weekend-3d/model-lock.json`, pinning the exact local model bundle hashes.

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
5. local Stable Fast 3D textured GLB.

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
also binds the prompt framing, exact model hashes, generation controls, and
asset-tooling source fingerprint. Editing any of those starts a new job identity
rather than silently treating old output as current.

The normal batch path performs no network request. Network/model acquisition is
a separate setup step. This keeps unattended generation independent from API
credits, chat sessions, and token budgets.
