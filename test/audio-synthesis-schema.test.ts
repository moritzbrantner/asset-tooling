import assert from "node:assert/strict";
import test from "node:test";

import { AUDIO_SYNTHESIZE_OPERATION } from "../src/audio-operations.js";

test("audio.synthesize authoring schema encodes waveform-specific fields", () => {
  const schema = AUDIO_SYNTHESIZE_OPERATION.parameterSchema;
  assert.deepEqual(schema.required, ["waveform", "sampleRate", "channels", "frameCount"]);
  assert.equal(schema.oneOf.length, 4);

  const byWaveform = Object.fromEntries(
    schema.oneOf.map((variant) => [variant.properties.waveform.const, variant]),
  );

  assert.deepEqual(byWaveform.silence.not, {
    anyOf: [{ required: ["frequencyHz"] }, { required: ["seed"] }],
  });
  assert.deepEqual(byWaveform.square.required, ["frequencyHz"]);
  assert.deepEqual(byWaveform.square.not, { required: ["seed"] });
  assert.deepEqual(byWaveform.saw.required, ["frequencyHz"]);
  assert.deepEqual(byWaveform.saw.not, { required: ["seed"] });
  assert.deepEqual(byWaveform.noise.required, ["seed"]);
  assert.deepEqual(byWaveform.noise.not, { required: ["frequencyHz"] });
});
