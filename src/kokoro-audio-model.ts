// Package entry for the local Kokoro-82M speech adapter (asset-tooling#30); see docs/kokoro.md.
export {
  createKokoroAudioModelAdapter,
  KOKORO_ENGLISH_VOICES,
  KOKORO_MODEL_ID,
  KOKORO_MODEL_REVISION,
  KOKORO_SAMPLE_RATE,
} from "./model-backends.js";
