# PRD: ComfyUI-backed image generation

**Issue:** [#212](https://github.com/moritzbrantner/asset-tooling/issues/212)  
**Status:** Owner-approved product direction. Offline preflight (#215), the execution slice `image.comfyui.generate@1` (#219) and candidate approval with verified export (#223, `asset.bundle@3`) are implemented, and so is the provider choice, through `image.generate@1` (#222, [image-generate.md](image-generate.md)). Preview UI and custom-node identities remain.  
**Authority:** [Decision Atlas 5.1.1](decisions/atlas.md) and [ComfyUI-first architecture](comfyui-first.md). This PRD specifies acceptance; it is not a second decision registry or implementation status tracker.

## User outcome

A project developer supplies an already prepared, license-checked ComfyUI API-format image workflow and declared local inputs/models. Through one versioned asset-tooling operation, they can run it on their chosen local ComfyUI instance, import the exact resulting image bytes, inspect candidate outputs, explicitly approve a chosen master and export a verified, game-ready bundle. The consuming game must not require ComfyUI, an inference model or an agent.

Use ComfyUI for the native media graph, custom nodes, model inference, queue and internal cache. Asset-tooling owns only the **project-facing operation and asset contract**: inputs, pinned implementation identities, provenance, verified imports, review states and exports.

## First end-to-end acceptance

1. **Prepare:** Provide one runnable ComfyUI **API-format prompt graph** (not the UI's canvas/links export), a prepared local checkpoint with recorded source/license/revision and input files. No implicit model installation or network downloads during generation. Setup tooling is handled separately by `bun run tools:setup --profile comfyui` (merged in [#214](https://github.com/moritzbrantner/asset-tooling/pull/214)).
2. **Declare and verify:** Store the exact workflow JSON bytes as a `workflow` / `application/json` `AssetRef`. Validate the byte hash before parsing; retain native graph content and identity. Verify declared model/input dependencies and the external provider's identity before dispatch. A provider choice and its effective versions are explicit; existing internal operations are not silently redirected.
3. **Execute:** Invoke the **whole native graph as one external job** using the ComfyUI local server's supported API, without translating native nodes into our own runner. Handle unavailable server, invalid graphs, queue rejection, execution failures, progress, cancellation, timeouts and ambiguous submissions without blind duplicate retries or global interruption of unrelated jobs.
4. **Import:** Fetch the actual image output bytes, verify file type and dimensions, create a content-addressed image `AssetRef` and record the workflow/inputs/model/provider/job/output identities. A seed is only a generation input, not proof of byte-identical replay. Failed or incomplete runs must not promote outputs or approvals.
5. **Review and export:** Preview actual candidates using the existing asset workbench, approve selected exact bytes, and export using the existing bundle contract. Replacing or rebuilding a candidate cannot inherit approval. An independent consumer verifies the bundle and decodes its PNG without ComfyUI.
6. **Conformance:** The operation is usable through the existing `AssetOperationDescriptor` registry and `workflow-editor`/`workflow-runner` bridge. No new graph interpreter, model loader, queue, gallery, blob store, approval database or runner is introduced.

## First small offline PR slice

The first low-risk implementation adds `loadPreparedComfyUiApiWorkflow` and focused regressions. It has **no server access, subprocess execution, model acquisition or mutable side effects**:

- Verify a stored workflow `AssetRef` through the existing content-addressed object store **before** reading its bytes.
- Decode strict UTF-8 JSON, distinguish a basic ComfyUI API node map from a UI graph, and require each node's `class_type` and `inputs` envelope.
- Reject missing, corrupted, malformed, non-JSON and non-finite-number inputs. Do **not** validate node classes, connection semantics, model names or graph feasibility locally; ComfyUI remains authoritative.
- Return the original JSON text without rewriting or canonicalizing native node contents, together with its exact-byte `AssetRef`.
- Keep this helper internal until the real provider operation and its invocation contract are accepted. It is **not** proof of working model inference.

## Execution slice: `image.comfyui.generate@1`

[PR #219](https://github.com/moritzbrantner/asset-tooling/pull/219) adds `src/comfyui-operation.ts`. Per the owner decision of 2026-10-16, the first real run was Stable Diffusion 1.5 on CPU on local WSL (deprecated since 2026-10-17, Atlas 4.1.4). It proved the generic provider boundary, not icon quality ([#211](https://github.com/moritzbrantner/asset-tooling/issues/211)).

- **Operation:** input `workflow` (`workflow` / `application/json`), output `image` (`image` / `image/png`). The workflow is loaded through `loadPreparedComfyUiApiWorkflow`.
- **Parameters (closed):** `provider: "comfyui"`, `checkpoint { name, sha256, byteLength, license }`, `injections { checkpoint, seed, positivePrompt, negativePrompt?, width, height }` and `output { node }`. Each injection names an existing node and an existing literal (non-link) input. Nothing else in the graph changes.
- **Checkpoint:** a declared identity, not an input port. Through the registration's `verifyDependencies` hook, `runAssetOperation` hashes `<checkpointDirectory>/<name>` before every cache lookup, hits included, and fails closed on a missing file or a mismatch. It never downloads anything.
- **Transport:** `GET /system_stats` (fail closed on identity drift), one `POST /prompt` with `{ prompt, client_id }`, polling `GET /history/{prompt_id}`, then exactly one `GET /view`. Redirects are never followed; any 3xx fails. A history record is imported only when `completed` is true, `status_str` is `success` and there is no `execution_error` or `execution_interrupted` message. No resubmission and no `/interrupt`. A timeout after acceptance or a lost `/prompt` response is reported as **ambiguous**; the job may still run on the server.
- **Import and receipt:** the PNG signature and IHDR size must match the injected width × height. The receipt (`observations`) records provider, `reproducibility: "approximate"`, prompt and client ids, workflow and submitted-prompt hashes, ComfyUI version and commit, checkpoint identity and the output file and hash.
- **Reuse:** the build identity covers workflow bytes, injections, checkpoint identity and licence, the server identity from the probe and the commit. A hit does not contact the server, but it still re-verifies the checkpoint.

Exported as `asset-tooling/operations/image/comfyui` and registrable in the workflow bridge through `createAssetOperationWorkflowProviderEntries` ([#221](https://github.com/moritzbrantner/asset-tooling/issues/221)); see Usage. Approval and export are the next section. Cancellation through workflow-runner#8 remains. The explicit provider choice is `image.generate@1`: prompt-level parameters, a required `provider` and pinned model profiles. It fills a repository-owned template and uses this transport; see [image-generate.md](image-generate.md).

### Supported local image models (Atlas 4.1.4)

FLUX.2 [klein] 4B and Z-Image Turbo are the supported models. Both are Apache-2.0 according to their official Hugging Face model cards (checked 2026-10-17 at the revisions below). Stable Diffusion 1.5 is **deprecated**: generate nothing new with it (see the end of this section).

The operation hashes and injects one file, `checkpoint`. For these split models, that file is the diffusion model: point `checkpointDirectory` at `models/diffusion_models` and bind the injection to `UNETLoader.unet_name`. The text encoder and VAE are literals in the hash-pinned workflow; the operation does not hash them, so the generation driver verifies them against the pins below before it submits anything. The candidates manifest records all three identities. Multi-file pins in this operation remain open (#225). `image.generate@1` already pins and verifies all three files per profile ([image-generate.md](image-generate.md)).

| Role | ComfyUI path under `models/` | Source (repository @ revision, file) | sha256 | Bytes | Licence |
| --- | --- | --- | --- | --- | --- |
| klein diffusion model | `diffusion_models/flux-2-klein-4b-fp8.safetensors` | `black-forest-labs/FLUX.2-klein-4b-fp8` @ `5b4408e59397a4a37ccb46afe426d8ed86379441`, `flux-2-klein-4b-fp8.safetensors` | `97ed34fe0567e436200f2faee3939b88f2b5d99f8af2a4dc16532c4245c0ccb6` | 4,070,624,520 | apache-2.0 |
| klein VAE | `vae/flux2-vae.safetensors` | `Comfy-Org/vae-text-encorder-for-flux-klein-4b` @ `5f526678002e43af5551dadb73ce2e8c91b43afe`, `split_files/vae/flux2-vae.safetensors` | `868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3` | 336,211,292 | apache-2.0 |
| Z-Image diffusion model | `diffusion_models/z_image_turbo_bf16.safetensors` | `Comfy-Org/z_image_turbo` @ `6fc90a3b1b653e935a0d175e260736de25b84df5`, `split_files/diffusion_models/z_image_turbo_bf16.safetensors` (repackaged from `Tongyi-MAI/Z-Image-Turbo` @ `f332072aa78be7aecdf3ee76d5c247082da564a6`) | `2407613050b809ffdff18a4ac99af83ea6b95443ecebdf80e064a79c825574a6` | 12,309,866,400 | apache-2.0 |
| Z-Image VAE | `vae/ae.safetensors` | `Comfy-Org/z_image_turbo` @ `6fc90a3b…4df5`, `split_files/vae/ae.safetensors` | `afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38` | 335,304,388 | apache-2.0 |
| Shared text encoder (Qwen3 4B, fp8 mixed) | `text_encoders/qwen_3_4b_fp8_mixed.safetensors` | `Comfy-Org/z_image_turbo` @ `6fc90a3b…4df5`, `split_files/text_encoders/qwen_3_4b_fp8_mixed.safetensors` | `72450b19758172c5a7273cf7de729d1c17e7f434a104a00167624cba94f68f15` | 5,631,994,051 | apache-2.0 |

Every listed sha256 equals the provider's LFS sha256 at that revision. The Comfy-Org repositories are ComfyUI's official single-file repackagings of the upstream weights, and their model cards also declare apache-2.0. The FP8 klein file and the fp8 text encoder fit an 8 GB GPU. On an RTX 3060 Ti (2026-10-17), one 1024×1024 image took about 9 s with klein (4 steps) and about 24 s with Z-Image Turbo (8 steps, bf16 weights partially offloaded by ComfyUI). Both run on ComfyUI 0.41.0 without custom nodes.

Acquire each file as its own explicit step, not as a repository snapshot, and keep it outside Git:

```sh
M=.artifacts/toolchain/comfy-workspace/ComfyUI/models
curl -fL -o "$M/diffusion_models/flux-2-klein-4b-fp8.safetensors" \
  "https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8/resolve/5b4408e59397a4a37ccb46afe426d8ed86379441/flux-2-klein-4b-fp8.safetensors"
# likewise for every row above: https://huggingface.co/<repository>/resolve/<revision>/<file>
sha256sum "$M"/diffusion_models/*.safetensors "$M"/vae/*.safetensors "$M"/text_encoders/*.safetensors   # compare with the table
```

The prepared workflows and the per-model pins live in `review/warden-icons/` (`workflow.flux2-klein-4b-icon.api.json`, `workflow.z-image-turbo-icon.api.json` and the `models` list of `candidates.json`). Both models are distilled for CFG 1, so they ignore negative prompts; their workflows take no `negativePrompt` injection, and style brief v2 states its exclusions in the positive prompt.

**Warden set (Atlas 4.1.5).** The owner selected FLUX.2 [klein] 4B for the Warden icons and asked for margin-free close-ups. Style brief v3 (`briefs.v3.json`) frames every ability as a tight close-up whose subject fills the square. Manifest schema 3 groups candidates into `sets`: the tight-framed klein set `warden.v3.flux2-klein-tight` is current and shown first on the review page, and the v2 klein/Z-Image comparison and the SD 1.5 run stay there as collapsed, superseded history. Z-Image Turbo remains supported but is not used for this set.

**Deprecated: Stable Diffusion 1.5.** It was the first real run (owner decision of 2026-10-16): `stable-diffusion-v1-5/stable-diffusion-v1-5` @ `451f4fe16113bff5a5d2269ed5ad43b0592e9a14`, `v1-5-pruned-emaonly.safetensors`, sha256 `6ce0161689b3853acaa03779ec93eafe75a02f4ced659bee03f50797806fa2fa`, 4,265,146,304 B, CreativeML OpenRAIL-M. Its Warden candidates and workflow stay in `review/warden-icons/` as history, marked deprecated. The offline provider tests keep their small SD 1.5-shaped fixture graph, which is a protocol fixture and not a model pin.

### Usage

Start the managed ComfyUI (`bun run tools:setup --profile comfyui --gpu nvidia` first; FLUX.2 [klein] and Z-Image Turbo need a GPU in practice) on loopback:

```sh
cd .artifacts/toolchain/comfy-workspace/ComfyUI
.venv/bin/python main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch
```

```ts
import { runAssetOperation } from "asset-tooling/operations/store";
import { createComfyUiImageGenerateRegistration, probeComfyUiServer } from "asset-tooling/operations/image/comfyui";

const endpoint = "http://127.0.0.1:8188";
const server = await probeComfyUiServer({ endpoint });
const registration = createComfyUiImageGenerateRegistration({
  endpoint,
  server,
  comfyuiCommit: "98cc0bf84b7cb1383654c5b402e7612d875d6d22", // from .artifacts/toolchain/comfyui-install.json
  checkpointDirectory: ".artifacts/toolchain/comfy-workspace/ComfyUI/models/diffusion_models",
});
const run = await runAssetOperation(root, registration, {
  inputs: { workflow }, // a stored workflow / application/json AssetRef (API format)
  parameters: {
    provider: "comfyui",
    checkpoint: { name: "flux-2-klein-4b-fp8.safetensors", sha256: "97ed34fe…0ccb6", byteLength: 4070624520, license: "apache-2.0" },
    injections: { // node ids of review/warden-icons/workflow.flux2-klein-4b-icon.api.json
      checkpoint: { node: "1", input: "unet_name" },
      seed: { node: "12", input: "noise_seed", value: 212 },
      positivePrompt: { node: "4", input: "text", value: "A painted fantasy game icon of a steel shield." },
      width: { node: "7", input: "value", value: 1024 },
      height: { node: "8", input: "value", value: 1024 },
    },
    output: { node: "15" },
  },
});
```

The subpath also exports the types `ComfyUiImageGenerateRegistrationOptions` and `ComfyUiServerIdentity`. `endpoint` is required; there is no default and no environment fallback.

#### Workflow bridge

A workflow host registers the operation explicitly. `createAssetOperationWorkflowProviderEntries` takes the same options under `comfyui`, performs no I/O and reads no environment variable:

```ts
import {
  createAssetOperationWorkflowExecutor,
  createAssetOperationWorkflowProviderEntries,
} from "asset-tooling/operations/workflow";

const { templates, registrations } = createAssetOperationWorkflowProviderEntries({
  comfyui: { endpoint, server, comfyuiCommit, checkpointDirectory },
});
// templates: [asset-operation:image.comfyui.generate@1] for the editor palette
const executor = createAssetOperationWorkflowExecutor({ root, registrations: [...otherRegistrations, ...registrations] });
```

Without `comfyui` (no argument, `{}` or `{ comfyui: undefined }`) both lists are empty: the editor does not offer the operation and the executor rejects a node that selects it as not registered. An invalid `comfyui` value (missing or non-loopback endpoint, credentials, missing server identity, unknown field) or an unknown provider key throws instead of registering a partial entry. The bridge entry runs the registration's checkpoint check before executing, so a missing or changed checkpoint still fails before anything is submitted. It does not use the operation result cache; use `runAssetOperation` for cached runs.

The real-server acceptance is `test/comfyui-local-server.test.ts`. It is skipped unless `ASSET_TOOLING_COMFYUI_URL` and `ASSET_TOOLING_COMFYUI_CHECKPOINT` are set; see its header for the optional pin, licence, size, timeout and evidence variables. Its fixture graph is SD 1.5-shaped (`CheckpointLoaderSimple`); for a supported split model, run the Warden workflows as in Usage. On the WSL CPU machine (2026-10-17), the 4-step SD 1.5 fixture took about 23 s at 256×256 and 44 s at 512×512, including model load.

#### Cancellation

Per [Decision 5.1.5](decisions/atlas.md), a run is cancelled through `runAssetOperation(root, registration, invocation, { signal })`; the workflow bridge forwards the runner's `context.signal`. Cancellation only ever touches this operation's own prompt and never calls `POST /interrupt`:

- **Queued:** when `GET /queue` lists the own prompt as pending (its prompt id **and** the submitted `client_id` both match; an entry with another `client_id` is never deleted and is reported as ambiguous), the run sends `POST /queue {"delete": [promptId]}` once and rejects with "cancelled: … deleted from the queue".
- **Running:** the prompt is neither interrupted nor deleted. The run rejects as ambiguous ("may still finish on the server") and names the prompt id.
- **Completion race:** the cancel wins. A history record or `/view` download that completes after the abort is not imported; an output object the run newly stored when the abort arrives is removed again (an object that existed before the run is never removed), and a cache entry written as the abort arrives is removed.
- **During `POST /prompt`:** the run looks up its own `client_id` in `GET /queue`. A pending prompt is deleted; otherwise the run rejects as an ambiguous submission naming the `client_id`. It is never resubmitted.

The abort is observed during in-flight requests and between history polls, not after the poll interval. Every cancellation rejects with `name === "AbortError"` and a message starting with "cancelled". Without a signal the transport behaves as before. Tests: `test/comfyui-cancellation.test.ts` against the queue-modelling fake server.

## Approval and export: `asset.bundle@3` (#223)

Per [Decision 4.1.3](decisions/atlas.md), approval is naming the exact approved sha256 in a bundle export's selection. Every `image.comfyui.generate@1` output is a candidate. The `approved-png-v1` profile of the existing bundle machinery ([Approved PNG profile](asset-bundles.md#approved-png-profile)) exports only selections whose candidate ref and stored bytes match the named sha. It rejects mismatches, regenerated images under an old approval and missing or altered candidates before writing anything. The `schemaVersion: 3` manifest records each approval next to its source ref; a consumer verifies it with `verifyAssetBundle(dir, ref, { profile: "approved-png-v1" })` without the source store or ComfyUI. No approval store, gallery or new packer is added; bundle `@1` and `@2` are unchanged.

The journey is tested against the fake server in `test/comfyui-approval-export.test.ts` and on a real local server in `test/comfyui-approval-local-server.test.ts` (two SD 1.5 candidates, one approved by sha, exported and verified with the store deleted). Previewing candidates in the workbench (#127) and the owner's visual approval of the Warden icons (#211, Decision 4.1.2) remain separate.

## Further work remaining in #212

The execution slice covers the provider boundary, checkpoint dependency safety, transport and output ingestion; #224 adds scoped cancellation (see Cancellation). #223 adds exact-sha approval, export and consumer verification. Custom-node and input-file identities, candidate preview and the provider choice are still open.

| Area | Evidence required |
| --- | --- |
| Provider boundary | A single versioned, typed asset operation with explicit ComfyUI provider selection and no breaking changes to existing operations |
| Dependency safety | Hash-pinned native workflow, checkpoint/custom-node/tool identities, input hashes and verified rights evidence |
| Transport | Real `POST /prompt`, job-scoped completion/history/output retrieval; scoped safe cancellation and ambiguous-submission behavior |
| Output ingestion | Actual PNG bytes, decoder/dimension validation, verified `AssetRef`, truthful run receipt and idempotent export |
| User-facing proof | Real local ComfyUI graph → approved image preview → exported bundle → independent consumer validation |
| Regression proof | Negative offline protocol tests, repeated safe run/export, existing `bun run check` and relevant hosted acceptance |

Local API reference: [ComfyUI server routes](https://docs.comfy.org/development/comfyui-server/comms_routes). MCP may help an agent author a graph but is **not** the runtime transport. External paid/cloud nodes are not an implicit fallback.

## Boundaries and dependencies

- [#211](https://github.com/moritzbrantner/asset-tooling/issues/211) remains the owner of actual four-icon MMORPG Warden visual approval; do not duplicate that product acceptance here.
- [#127](https://github.com/moritzbrantner/asset-tooling/issues/127) remains responsible for inspection and approval UI.
- [workflow-runner #8](https://github.com/moritzbrantner/workflow-runner/issues/8) owns generic external-executor retry, cancellation and timeout semantics; one ComfyUI graph is one external executor invocation.
- Existing Diffusers, procedural generators, 3D processors and published asset contracts remain valid. A future first-party implementation may compete with a pinned ComfyUI reference **one operation at a time** with explicit provider choice, consumer parity evidence and rollback.
- The real local model/checkpoint, approved native workflow and ComfyUI instance remain **integration prerequisites**, not data to synthesize in fixtures. If unavailable, report the missing acceptance evidence rather than marking #212 complete.
