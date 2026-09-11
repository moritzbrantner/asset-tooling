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
  const canonical = encodeCanonicalPcm16Wav({
    sampleRate: 8_000,
    channels: 1,
    samples: Int16Array.from([100, -100]),
  }).bytes;
  const oddChunkWithoutPadding = Buffer.alloc(9);
  oddChunkWithoutPadding.write("JUNK", 0, "ascii");
  oddChunkWithoutPadding.writeUInt32LE(1, 4);
  oddChunkWithoutPadding[8] = 0x42;
  const malformed = Buffer.concat([canonical, oddChunkWithoutPadding]);
  malformed.writeUInt32LE(malformed.length - 8, 4);
  assert.throws(() => decodePcmWav(malformed), /missing its required padding byte/);
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
