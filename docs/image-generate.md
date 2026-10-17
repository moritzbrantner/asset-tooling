# `image.generate@1`: prompt-level image generation

**Issue:** [#222](https://github.com/moritzbrantner/asset-tooling/issues/222). **Authority:** [Atlas Decisions 4.1.4, 5.1.2 and 5.1.4](decisions/atlas.md). The ComfyUI transport is the one described in [prd-comfyui-provider.md](prd-comfyui-provider.md).

A recipe names a provider, a model profile and prompt-level values. It does not supply a workflow or model file names. `image.stable-diffusion.generate@1` (Diffusers) and `image.comfyui.generate@1` are unchanged.

## Usage

```ts
import { runAssetOperation } from "asset-tooling/operations/store";
import { probeComfyUiServer } from "asset-tooling/operations/image/comfyui";
import {
  createImageGenerateRegistration,
  resolveImageGenerateParameters,
} from "asset-tooling/operations/image/generate";

const endpoint = "http://127.0.0.1:8188";
const registration = createImageGenerateRegistration({
  provider: "comfyui",
  endpoint,
  server: await probeComfyUiServer({ endpoint }),
  modelsDirectory: "/path/to/ComfyUI/models", // contains diffusion_models/, text_encoders/, vae/
});
const parameters = resolveImageGenerateParameters({
  provider: "comfyui",
  model: "flux2-klein-4b",
  prompt: "A painted fantasy game icon of a steel shield.",
  seed: 212,
  width: 1024,
  height: 1024,
});
const run = await runAssetOperation(root, registration, { parameters });
// run.result.outputs.image: image/png AssetRef; run.result.observations: the receipt
```

Always pass the **resolved** parameters. A registration rejects parameters that are not fully resolved.

## Parameters

| Parameter | Rule |
| --- | --- |
| `provider` | required: `comfyui` or `diffusers` |
| `model` | required: `flux2-klein-4b` or `z-image-turbo` |
| `prompt` | required, non-empty |
| `seed` | required, safe integer ≥ 0 |
| `width`, `height` | required, positive multiple of 8, ≤ 2048 |
| `steps` | optional positive integer |
| `sampler`, `scheduler` | optional ComfyUI names (`^[a-z0-9_]+$`) |
| `guidance` (cfg), `shift` | optional finite number > 0 |

`negativePrompt` and unknown fields are rejected. So is any knob that the profile does not support.

## Profiles

`IMAGE_GENERATE_MODEL_PROFILES` pins the diffusion model, text encoder and VAE files for each profile, with name, `models/` subdirectory, sha256, byte length, licence and source revision. These pins match `review/warden-icons/candidates.json` and the table in the PRD. Each profile also pins a template and its defaults.

| Profile | Template | Defaults | Overridable |
| --- | --- | --- | --- |
| `flux2-klein-4b` | `src/image-generate-templates/flux2-klein-4b.api.json` | steps 4, sampler `euler`, guidance 1 | steps, sampler, guidance |
| `z-image-turbo` | `src/image-generate-templates/z-image-turbo.api.json` | steps 8, sampler `res_multistep`, scheduler `simple`, guidance 1, shift 3 | all five |

The templates are repository-owned API-format workflows written for this operation. The #211 review workflows stay review provenance. Each profile declares an injection map: the node and input that receive the prompt, seed, size, each knob and each of the three loader file names. Nothing else in the graph changes.

## Execution and failure

Before every cache lookup (hits included) and again before submission, the run checks four things, in order:

1. The parameters are resolved, and their provider matches the registration's provider.
2. The template bytes match `template.sha256`.
3. Each of the three model files under `<modelsDirectory>/<directory>/<name>` matches its byte length and sha256. A file is hashed again whenever its inode, size or timestamps change.
4. The server still matches the probed identity.

Any mismatch fails before `POST /prompt`, and nothing is stored or cached. After that check, the run uses the shared ComfyUI transport: one submission, ambiguous outcomes reported rather than retried, no redirects and no `/interrupt`. The output must be a PNG of the requested size. `bun run package:check` also fails if a template's bytes drift from its pin.

The receipt records the provider, the model, the resolved parameters, the template path and sha256, all three file pins, the submitted-prompt hash, the prompt and client ids, the ComfyUI version and the output hash. Its `reproducibility` is `"approximate"`.

## Identity

The build identity has two parts:

- **The resolved parameters.** Explicit defaults and omitted defaults therefore share an identity, and a later change to a profile default changes identity.
- **The implementation identity.** It holds the provider, every profile's file pins, the template sha256 and injection map, and, for ComfyUI, the probed server identity and the optional `comfyuiCommit`.

Switching provider, model, template, model file or server therefore always produces a new identity. There is no fallback in either direction.

## Provider status

- **comfyui:** supported for both profiles.
- **diffusers:** `createImageGenerateRegistration({ provider: "diffusers" })` exists, but neither profile lists Diffusers. Resolving or running with `provider: "diffusers"` fails visibly ("not supported for model …") before any network or model access. Diffusers support for FLUX.2 [klein] 4B and Z-Image Turbo is a follow-up issue; it will add `diffusers` to a profile's `providers`, which changes identity.

Workflow-bridge registration (`createAssetOperationWorkflowProviderEntries`) does not offer `image.generate@1` yet.
