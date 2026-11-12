// Browser stand-in for the `node:zlib` functions the shared recipe modules call (crc32, deflateSync, inflateSync),
// so Pages bundles run them unchanged. pako ports zlib's deflate, but its compressed bytes can differ from the
// runtime's native zlib, so PNG bytes built in a browser are not CLI byte identities; decoded samples are equal.
import { Buffer } from "buffer";
import { deflate, inflate } from "pako";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array | string, value = 0): number {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let crc = (value ^ 0xffffffff) >>> 0;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

type Level = -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export function deflateSync(data: Uint8Array, options: { level?: number } = {}): Buffer {
  return Buffer.from(deflate(data, { level: (options.level ?? 6) as Level }));
}

export function inflateSync(data: Uint8Array): Buffer {
  return Buffer.from(inflate(data));
}
