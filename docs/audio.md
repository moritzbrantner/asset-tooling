# Audio operations

`asset-tooling` treats audio as an offline build artifact. It owns canonical audio bytes, content identity, operation contracts, deterministic processing semantics, provenance, and workflow projection. It does not own playback, device I/O, a DAW, music/speech application semantics, or real-time scheduling.

## Canonical audio v1

The canonical representation is deliberately boring:

- media type: `audio/wav`;
- container: RIFF/WAVE with one canonical 44-byte PCM header;
- codec: signed 16-bit little-endian PCM (`pcm-s16le`);
- channel layouts: mono or stereo;
- sample rate: explicit integer in `8000..192000` Hz;
- duration: exact `frameCount / sampleRate`, represented as an integer numerator and denominator rather than a rounded wall-clock value.

The published `schemas/audio-asset-v1.schema.json` constrains the content-addressed `AssetRef`. Runtime validation additionally verifies cross-field equalities and requires the stored WAV bytes to re-encode byte-for-byte into the canonical layout.

Canonical metadata has two closed sections:

- `audio`: codec, sample rate, channels/layout, frame count, and exact rational duration;
- `provenance`: the producing operation identity and ordered source input SHA-256 values.

Raw catalog/source files remain separate identities. Normalization always creates or reuses a derived content-addressed object rather than relabeling source bytes as canonical.

## Supported input normalization

`audio.normalize@1` currently accepts uncompressed RIFF/WAVE PCM format 1 with:

- 8-bit unsigned PCM or 16-bit signed little-endian PCM;
- mono or stereo channels;
- explicit sample rates in the canonical range.

It rejects compressed WAV codecs, malformed RIFF/chunk lengths, duplicate `fmt`/`data` chunks, inconsistent byte rate/block alignment, unsupported channel counts, or incomplete frames.

Optional target sample rate and channel count are explicit operation parameters. Resampling and channel conversion therefore never depend on decoder defaults.

## Deterministic synthesis

`audio.synthesize@1` is the deterministic reference generator for audio. It is sample-index driven and supports:

- `silence`;
- `square`;
- `saw`;
- seeded `noise` using the repository's explicit SplitMix64 integer PRNG family.

Every output-affecting value is explicit: waveform, sample rate, channel count, frame count, amplitude, frequency where applicable, and seed for noise. No wall-clock time, audio device, locale, or host state participates.

The initial vocabulary intentionally excludes sine/triangle oscillators because a portable exact transcendental implementation has not yet been established. Adding them requires an explicit algorithm whose output bytes can be replayed across supported environments rather than relying on ambient `Math.sin` behavior as an unstated contract.

## Deterministic transforms

The first transform family is intentionally small and independently composable:

- `audio.trim@1` — half-open frame range `[startFrame, endFrame)`;
- `audio.resample@1` — fixed integer/rational linear interpolation with an explicit output sample rate;
- `audio.channels@1` — mono→stereo duplicates the source sample; stereo→mono averages left/right with deterministic signed integer rounding;
- `audio.gain@1` — rational gain `numerator / denominator`, rounded deterministically and saturated to signed 16-bit range;
- `audio.fade@1` — frame-index linear fade-in/fade-out with exact frame counts.

Operations use frame/sample indices inside the durable contract. User interfaces may expose seconds, but conversion to frame indices must happen explicitly before dispatch with documented rounding.

## Offline mixing

`audio.mix@1` accepts 1–32 already-canonical audio assets. All inputs must have identical sample rate and channel count; callers normalize them first rather than relying on hidden mix-time conversion.

Each ordered input has explicit:

- start frame;
- rational gain numerator/denominator.

Input order is retained in provenance and observations. Per-track gain is deterministically rounded before summation; overlapping tracks are accumulated and saturated once at the final signed-16 output sample. The operation is offline and frame-index based—there is no runtime scheduling model.

## Content identity and repeated work

All outputs flow through the existing `.asset-tooling/objects/v1` content-addressed store. Repeating a deterministic operation produces the same canonical bytes and therefore resolves to the same `AssetRef`; the object store reuses an existing verified object instead of writing duplicate bytes.

Operation build identity still records operation version, implementation/tool fingerprint, parameters, and validated input identities. `runAssetOperation(...)` from `asset-tooling/operations/store` uses that identity to reuse a recorded result without re-executing, which matters for model-backed operations such as `audio.model.generate@1` and `@2`. It verifies every input before the lookup and every output object before reuse, and returns the recorded reproducibility label unchanged. Cache presence is never provenance evidence; see [Reusing verified operation results](operations.md#reusing-verified-operation-results).

## Workflow integration

Every audio capability is an ordinary `AssetOperationDescriptor`. The existing `asset.operation` bridge derives workflow-editor port metadata and dispatches through workflow-runner without audio-specific runner behavior.

This keeps responsibilities separate:

- asset-tooling: audio operation/asset semantics and provenance;
- workflow-editor: authoring;
- workflow-runner: generic execution;
- Remotion/video consumers: temporal presentation of already-built audio assets.

## Catalog fixtures

The shared catalog already registers `kenney.ui-audio-v1` as a CC0 candidate. Network acquisition, byte pinning, and Git LFS promotion remain separate reviewed catalog mutations. Deterministic audio unit/operation tests do not silently download that pack or treat an unpinned candidate as trusted fixture evidence.

Issue #25 remains incomplete until a small concrete audio fixture subset or pack is content-pinned and promoted with accepted license evidence.

## Model-backed audio

Model-backed audio belongs to the same high-level provenance architecture as Stable Diffusion and TripoSR: exact local model/config bytes, a provider adapter, explicit request parameters, offline execution after acquisition, and demonstrated—not assumed—reproducibility.

The deterministic PCM operations do not embed a particular text-to-audio model. Provider/model licensing is part of the selection boundary; a convenient non-commercial checkpoint is not suitable as the default reusable foundation for the repository fleet.

`asset-tooling/operations/audio/model` publishes two versions of the provider-neutral `audio.model.generate` operation. Both take an injected adapter `{ id, version, reproducibility, generate }`, a `model` bundle input (resolved from the object store and handed to the adapter as bytes), an optional canonical-audio `conditioning` input, and the parameters `modelId`, `modelRevision`, `prompt`, optional `seed`, `sampleRate`, `channels`, optional `frameCount` and `adapterParameters`. The adapter result must match the requested `sampleRate` and `channels`. The adapter's `exact` or `approximate` reproducibility label is recorded in the build identity and in the observations and is never upgraded.

- `audio.model.generate@1` (`AUDIO_MODEL_GENERATE_OPERATION`, `createAudioModelGenerateOperationBuildIdentity`, `createAudioModelGenerateOperationExecutor`) requires `frameCount` and enforces it exactly. Its adapter shape is closed: an adapter that declares `environmentComponents` is rejected rather than having its runtime silently left out of the identity. The published @1 descriptor and behaviour are unchanged.
- `audio.model.generate@2` (`AUDIO_MODEL_GENERATE_V2_OPERATION`, `createAudioModelGenerateV2OperationBuildIdentity`, `createAudioModelGenerateV2OperationExecutor`) is for adapters such as text-to-speech, where the length is only known after synthesis.
  - `frameCount` is optional. When present it is enforced exactly, as in @1. When absent, the adapter request carries `frameCount: undefined`, the canonical parameters contain no `frameCount`, and the adapter's actual length is recorded in `metadata.audio.frameCount`, `metadata.audio.duration` and `observations.frameCount`. Audio is never padded or truncated.
  - An adapter may declare `environmentComponents()`, sync or async, returning an array of canonical JSON values (for example the Python, torch and phonemizer versions). The build identity then carries `implementation.environment = await captureEnvironment(components)`, as TripoSR does. A changed runtime therefore gives a different build identity and `runAssetOperation` cache key, so the result is a miss instead of being reused across runtime changes; identical components hit. Without `environmentComponents` the identity has no `environment` field.
  - Output provenance records `{ id: "audio.model.generate", version: "2" }`.
  - Each execution probes the environment once and uses that one capture for its identity. Under `runAssetOperation`, the executor compares that identity with the prepared one the cache key came from. If the runtime, tool or adapter identity changed in between, it fails closed before calling the adapter.
- Both factories snapshot the validated adapter when they are created. Mutating the adapter object afterwards, for example adding `environmentComponents` to a v1 adapter, does not change what the executor runs or which identity it records.

The first concrete adapter is the local Kokoro-82M text-to-speech adapter for `audio.model.generate@2`; its model, licence and provenance evidence, hash-locked runtime and fail-closed pronunciation lexicon are in [kokoro.md](kokoro.md).

Generation is offline: the operation never acquires models, and an adapter must only read the declared local bundle. The bundle bytes are loaded into memory; a store path or lazy reader for large bundles is not part of either version yet.
