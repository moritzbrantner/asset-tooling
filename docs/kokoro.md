# Kokoro-82M speech adapter

`createKokoroAudioModelAdapter` (in `src/model-backends.ts`, published as `asset-tooling/operations/audio/model/kokoro`) is a local, offline text-to-speech adapter for [`audio.model.generate@2`](audio.md#model-backed-audio). It runs `adapters/python/kokoro_tts.py` through the process-adapter protocol. The interpreter comes from a hash-locked Python 3.12 venv. Issue: asset-tooling#30.

## Model and licence evidence

| Field | Value |
|---|---|
| Model | `hexgrad/Kokoro-82M` (Kokoro v1.0) |
| Revision | `f3ff3571791e39611d31c381e3a41a3af07b4987` |
| Weights | `kokoro-v1_0.pth`, 327,212,226 B, SHA-256 `496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4` |
| Default voice | `af_heart`, SHA-256 `0ab5709b8ffab19bfd849cd11d98f75b60af7733253ad0d67b12382a102cb4ff` |
| Licence | Apache-2.0 for the weights, the `kokoro` code and `misaki` |
| Acquisition bundle | `model.zip`, 72 files, 363,333,339 B, SHA-256 `115b504bedbf242d7794bab72deff3abb1ab069ebf7c5c985f19dcc65f47211d` (acquired 2026-10-16, licence status `matched`) |

**Training-data provenance caveat.** Kokoro's model card says its training data includes synthetic audio from closed commercial TTS providers. The owner accepted Kokoro-82M for the initial Seven Councils narration with this caveat in interactive-videos Decision 3.24 (answering Question 3.23). The caveat travels with the licence evidence: keep this section next to the acquisition receipt wherever Kokoro output or its receipt is reviewed or promoted. The voice is chosen by listening review, not by this adapter.

## Acquisition

Acquisition is separate from generation ([model-acquisition.md](model-acquisition.md)). Store the bundle outside the repository, or in a disposable `.artifacts/` directory:

```sh
python scripts/acquire-huggingface-model.py acquire \
  --repo-id hexgrad/Kokoro-82M \
  --revision f3ff3571791e39611d31c381e3a41a3af07b4987 \
  --expected-license apache-2.0 \
  --destination ~/.cache/asset-tooling/models/kokoro-82M-f3ff357
```

Store `model.zip` as the operation's `model` input with kind `model` and mediaType `application/zip`. The adapter passes the process a file with exactly those bytes. The Python side then extracts only `config.json`, `kokoro-v1_0.pth` and `voices/<voice>.pt` and checks each against its pinned SHA-256. The pins cover all 28 English voices at the revision.

## Runtime

`requirements-kokoro.txt` is a fully hash-locked runtime for CPython 3.12 on Linux x86_64. Kokoro needs Python below 3.13. torch is the CPU wheel from the PyTorch CPU index (`https://download.pytorch.org/whl/cpu`), pinned as a direct URL with its hash, so the install needs no extra index. `en_core_web_sm` is pinned by URL and hash, because misaki would otherwise download it at runtime.

```sh
uv venv --python 3.12 ~/.cache/asset-tooling/kokoro-venv
VIRTUAL_ENV=~/.cache/asset-tooling/kokoro-venv uv pip install --require-hashes -r requirements-kokoro.txt
```

To change a pin, edit `requirements-kokoro.in` and regenerate the lock:

```sh
uv pip compile requirements-kokoro.in --python-version 3.12 --python-platform x86_64-manylinux_2_28 \
  --generate-hashes -o requirements-kokoro.txt
```

Keep the venv outside the repository.

## Usage

```ts
import { createKokoroAudioModelAdapter } from "asset-tooling/operations/audio/model/kokoro";
import {
  AUDIO_MODEL_GENERATE_V2_OPERATION,
  createAudioModelGenerateV2OperationBuildIdentity,
  createAudioModelGenerateV2OperationExecutor,
} from "asset-tooling/operations/audio/model";

const adapter = createKokoroAudioModelAdapter({ python: "/home/me/.cache/asset-tooling/kokoro-venv/bin/python", threads: 2 });
const invocation = {
  parameters: {
    modelId: "hexgrad/Kokoro-82M",
    modelRevision: "f3ff3571791e39611d31c381e3a41a3af07b4987",
    prompt: "Arius and Athanasius disputed the homoousios at Nicaea.",
    seed: "325",
    sampleRate: 24000,
    channels: 1,
    adapterParameters: {
      voice: "af_heart",
      lexicon: {
        version: "seven-councils-1",
        entries: { Arius: "ˈɛɹiəs", homoousios: "hˌOmOˈusiəs", Athanasius: "ˌæθənˈAʃəs", Nicaea: "nIsˈiə" },
      },
    },
  },
  inputs: { model: modelZipAssetRef },
};
```

Factory options:

- `python` (default `python3`): one executable, or `[executable, ...launcherArguments]`, for example `["uv", "run", "--frozen", "python"]`.
- `threads` (default `1`): the torch thread count, 1..256. It also sets `OMP_NUM_THREADS` and `MKL_NUM_THREADS`, and it is part of the build identity.

Request rules. Each is checked before the generate process starts:

- `modelId` and `modelRevision` must be exactly the pinned values.
- The `model` input must be an `application/zip` AssetRef whose bytes match its hash.
- `sampleRate` is `24000` and `channels` is `1`.
- `seed` is required, at most 2^64−1, and seeds `torch.manual_seed`.
- `frameCount` must be omitted, because the length comes from synthesis.
- A `conditioning` input is rejected.
- `adapterParameters` is closed: `{ voice, lexicon: { version, entries }, speed? }`.
  - `voice` is a Kokoro v1.0 English voice (`af_*`, `am_*`, `bf_*`, `bm_*`). `b*` voices use misaki's British G2P.
  - `lexicon.version` is a non-empty string.
  - `lexicon.entries` maps single words to non-empty phoneme strings in misaki's phoneme set.
  - `speed` is a finite number above 0 and defaults to 1.

Output is a canonical 24 kHz mono PCM16 WAV. Kokoro's float32 samples are clipped to [-1, 1], scaled by 32767 and rounded half to even. Output that is not 24 kHz mono 16-bit PCM WAV, or that is empty, fails closed. The backend observations record the voice and weights hashes, the lexicon version, the seed, the thread count and the phoneme strings that were synthesized.

## Pronunciation: fail closed, no espeak

The adapter calls misaki's English G2P directly with `fallback=None`; it does not use Kokoro's `KPipeline`. Kokoro on its own silently drops a word it cannot phonemize, or falls back to espeak when espeak is installed. Here the caller's lexicon entries override misaki's dictionaries, including their capitalisation variants. Then every word token must have phonemes. Any out-of-vocabulary token fails the run with an `out-of-vocabulary` diagnostic that names each such token.

Phonemes outside the model vocabulary fail closed, rather than being filtered out. So does a sentence longer than Kokoro's 510-phoneme context, rather than being truncated. The voice, the lexicon entries and the lexicon version are all part of the identity.

misaki's dictionaries do not cover, for example, Arius, homoousios, homoiousios, Athanasius, Hosius, Nicomedia, Bithynia, Sylvester or Nicaea. Those words need lexicon entries.

## Identity and reproducibility

`environmentComponents()` runs `kokoro_tts.py probe`. The probe returns the adapter script hash, the Python version and executable hash, the platform, and the versions of torch, kokoro, misaki, spaCy, en_core_web_sm, transformers, numpy, thinc, num2words and huggingface-hub. It also returns the torch CPU backend flags. The adapter appends the thread count. A changed runtime therefore changes the cache key.

Generation runs with the process adapter's forced offline variables (`HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `HF_HUB_DISABLE_TELEMETRY=1`). The script refuses an explicit opt-out. It never calls a Hugging Face or spaCy download path, and loads weights and voices with `torch.load(..., weights_only=True)`.

The adapter is labelled **`approximate`**. Kokoro's iSTFTNet decoder draws from `torch.rand`/`randn`. A fixed seed and thread count gave byte-identical output on one machine. That is not evidence of exact replay across machines, CPU kernels or thread counts, so the label is never upgraded.

## Local acceptance

`test/kokoro-local-model.test.ts` runs the real model when these variables are set. It is reported as skipped otherwise.

| Variable | Meaning |
|---|---|
| `ASSET_TOOLING_KOKORO_PYTHON` | interpreter of the hash-locked venv |
| `ASSET_TOOLING_KOKORO_MODEL_ZIP` | the acquired `model.zip` |
| `ASSET_TOOLING_KOKORO_THREADS` | optional torch thread count (default 1) |
| `ASSET_TOOLING_KOKORO_EVIDENCE_DIR` | optional; receives `kokoro-sample.wav` and `kokoro-evidence.json` |

```sh
ASSET_TOOLING_KOKORO_PYTHON=~/.cache/asset-tooling/kokoro-venv/bin/python \
ASSET_TOOLING_KOKORO_MODEL_ZIP=~/.cache/asset-tooling/models/kokoro-82M-f3ff357/model.zip \
ASSET_TOOLING_KOKORO_THREADS=2 \
ASSET_TOOLING_KOKORO_EVIDENCE_DIR=.artifacts/kokoro-evidence \
bun test test/kokoro-local-model.test.ts
```

Recorded run, 2026-10-16:
- Machine: WSL2, Linux x86_64, CPython 3.12.15, torch 2.8.0+cpu, threads 2.
- Sentence: "Arius and Athanasius disputed the homoousios at Nicaea.", seed 325, voice `af_heart`.
- Output: 105,000 frames (4.375 s), peak 21,341, RMS 1,514. misaki G2P with the lexicon gave `ˈɛɹiəs ænd ˌæθənˈAʃəs dɪspjˈuTᵻd ðə hˌOmOˈusiəs æt nIsˈiə.`
- Removing the `Arius` entry failed closed and named `Arius`.
- A same-seed, same-thread rerun in a fresh process was byte-identical: SHA-256 `a37f325c3437abc8fa37c271c8b0e8c6d8a68db5cebafc64922c8630b9d90df7`. The label stays `approximate`.
- The test took about 42 s wall time, including three syntheses. The largest process peaked at about 1.36 GB resident memory (`/usr/bin/time -v`).

The listening and intelligibility note on the sample is a human review and is not machine-checked.

## Limits

- The lock covers Linux x86_64 only. Another platform needs its own lock.
- The operation loads the whole model bundle (about 363 MB) into memory before it calls the adapter, as `audio.model.generate@2` does for every model.
- Pronunciation quality is judged by listening. The adapter guarantees only that every word was resolved by misaki or by the caller's lexicon.
