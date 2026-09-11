import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAudioFade,
  decodePcmWav,
  encodeCanonicalPcm16Wav,
} from "../src/audio.js";

test("WAV parser rejects declared trailing bytes that do not form a complete chunk", () => {
  const canonical = encodeCanonicalPcm16Wav({
    sampleRate: 8_000,
    channels: 1,
    samples: Int16Array.from([100, -100]),
  }).bytes;
  const malformed = Buffer.concat([canonical, Buffer.from([0x7f])]);
  malformed.writeUInt32LE(malformed.length - 8, 4);
  assert.throws(() => decodePcmWav(malformed), /trailing byte/);
});

test("WAV parser rejects an odd chunk whose required padding byte is missing", () => {
  const bytes = Buffer.alloc(21);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(13, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("JUNK", 12, "ascii");
  bytes.writeUInt32LE(1, 16);
  bytes[20] = 0x42;
  assert.throws(() => decodePcmWav(bytes), /missing its required padding byte/);
});

test("one-frame fade-in and fade-out affect their endpoint", () => {
  const audio = {
    sampleRate: 8_000,
    channels: 1,
    samples: Int16Array.from([1_000, 2_000, 3_000]),
  };
  assert.deepEqual([...applyAudioFade(audio, 1, 0).samples], [0, 2_000, 3_000]);
  assert.deepEqual([...applyAudioFade(audio, 0, 1).samples], [1_000, 2_000, 0]);
  assert.deepEqual([...applyAudioFade(audio, 1, 1).samples], [0, 2_000, 0]);
});
