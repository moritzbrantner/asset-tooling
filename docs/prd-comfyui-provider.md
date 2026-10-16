# PRD: ComfyUI-backed image generation

**Issue:** [#212](https://github.com/moritzbrantner/asset-tooling/issues/212)  
**Status:** Owner-approved product direction. Offline preflight (#215) and the execution slice `image.comfyui.generate@1` (#219) are implemented; review/approval, export and provider choice remain.  
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

[PR #219](https://github.com/moritzbrantner/asset-tooling/pull/219) adds `src/comfyui-operation.ts`. Per the owner decision of 2026-10-16, the first real run is Stable Diffusion 1.5 on CPU on local WSL. It proves the generic provider boundary, not icon quality ([#211](https://github.com/moritzbrantner/asset-tooling/issues/211)).

- **Operation:** input `workflow` (`workflow` / `application/json`), output `image` (`image` / `image/png`). The workflow is loaded through `loadPreparedComfyUiApiWorkflow`.
- **Parameters (closed):** `provider: "comfyui"`, `checkpoint { name, sha256, byteLength, license }`, `injections { checkpoint, seed, positivePrompt, negativePrompt?, width, height }` and `output { node }`. Each injection names an existing node and an existing literal (non-link) input. Nothing else in the graph changes.
- **Checkpoint:** a declared identity, not an input port. Through the registration's `verifyDependencies` hook, `runAssetOperation` hashes `<checkpointDirectory>/<name>` before every cache lookup, hits included, and fails closed on a missing file or a mismatch. It never downloads anything.
- **Transport:** `GET /system_stats` (fail closed on identity drift), one `POST /prompt` with `{ prompt, client_id }`, polling `GET /history/{prompt_id}`, then exactly one `GET /view`. Redirects are never followed; any 3xx fails. A history record is imported only when `completed` is true, `status_str` is `success` and there is no `execution_error` or `execution_interrupted` message. No resubmission and no `/interrupt`. A timeout after acceptance or a lost `/prompt` response is reported as **ambiguous**; the job may still run on the server.
- **Import and receipt:** the PNG signature and IHDR size must match the injected width × height. The receipt (`observations`) records provider, `reproducibility: "approximate"`, prompt and client ids, workflow and submitted-prompt hashes, ComfyUI version and commit, checkpoint identity and the output file and hash.
- **Reuse:** the build identity covers workflow bytes, injections, checkpoint identity and licence, the server identity from the probe and the commit. A hit does not contact the server, but it still re-verifies the checkpoint.

Not yet exported from `package.json` and not registered in a shared registry; that, cancellation through workflow-runner#8 and provider choice against Diffusers `image.stable-diffusion.generate` remain.

### Checkpoint acquisition (SD 1.5)

`scripts/acquire-huggingface-model.py` downloads a complete repository snapshot (tens of GB for this repository), so the single checkpoint file is acquired as a separate, explicit step and kept outside Git:

```sh
REV=$(curl -s https://huggingface.co/api/models/stable-diffusion-v1-5/stable-diffusion-v1-5/revision/main | jq -r .sha)
# 451f4fe16113bff5a5d2269ed5ad43b0592e9a14 on 2026-10-17; cardData.license: creativeml-openrail-m
curl -fL -o v1-5-pruned-emaonly.safetensors \
  "https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5/resolve/$REV/v1-5-pruned-emaonly.safetensors"
sha256sum v1-5-pruned-emaonly.safetensors
# 6ce0161689b3853acaa03779ec93eafe75a02f4ced659bee03f50797806fa2fa, 4,265,146,304 B (equals the provider's LFS sha256)
mv v1-5-pruned-emaonly.safetensors .artifacts/toolchain/comfy-workspace/ComfyUI/models/checkpoints/
```

The licence is the CreativeML OpenRAIL-M licence declared in the model card at that revision. Review its use restrictions for the intended use. Keep a receipt (repository, revision, file hash and length, licence evidence) next to the file.

### Usage

Start the managed ComfyUI (`bun run tools:setup --profile comfyui --gpu cpu` first) on loopback:

```sh
cd .artifacts/toolchain/comfy-workspace/ComfyUI
.venv/bin/python main.py --cpu --listen 127.0.0.1 --port 8188 --disable-auto-launch
```

```ts
import { runAssetOperation } from "asset-tooling/operations/store";
import { createComfyUiImageGenerateRegistration, probeComfyUiServer } from "./src/comfyui-operation.ts";

const endpoint = "http://127.0.0.1:8188";
const server = await probeComfyUiServer({ endpoint });
const registration = createComfyUiImageGenerateRegistration({
  endpoint,
  server,
  comfyuiCommit: "98cc0bf84b7cb1383654c5b402e7612d875d6d22", // from .artifacts/toolchain/comfyui-install.json
  checkpointDirectory: ".artifacts/toolchain/comfy-workspace/ComfyUI/models/checkpoints",
});
const run = await runAssetOperation(root, registration, {
  inputs: { workflow }, // a stored workflow / application/json AssetRef (API format)
  parameters: {
    provider: "comfyui",
    checkpoint: { name: "v1-5-pruned-emaonly.safetensors", sha256: "6ce01616…", byteLength: 4265146304, license: "creativeml-openrail-m" },
    injections: {
      checkpoint: { node: "4", input: "ckpt_name" },
      seed: { node: "3", input: "seed", value: 212 },
      positivePrompt: { node: "6", input: "text", value: "a painted fantasy game icon of a steel shield" },
      negativePrompt: { node: "7", input: "text", value: "text, watermark, blurry" },
      width: { node: "5", input: "width", value: 512 },
      height: { node: "5", input: "height", value: 512 },
    },
    output: { node: "9" },
  },
});
```

The real-server acceptance is `test/comfyui-local-server.test.ts`. It is skipped unless `ASSET_TOOLING_COMFYUI_URL` and `ASSET_TOOLING_COMFYUI_CHECKPOINT` are set; see its header for the optional pin, licence, size, timeout and evidence variables. On the WSL CPU machine (2026-10-17), the 4-step SD 1.5 fixture took about 23 s at 256×256 and 44 s at 512×512, including model load.

## Further work remaining in #212

The execution slice covers the provider boundary, checkpoint dependency safety, transport except scoped cancellation, and output ingestion except export. Custom-node and input-file identities, review/approval, export, consumer validation and the provider choice are still open.

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
