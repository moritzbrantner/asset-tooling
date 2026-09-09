import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PIXELS = 16_777_216;
const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

function crc32(...buffers) {
  let crc = 0xffffffff;
  for (const buffer of buffers) {
    for (const byte of buffer) {
      crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(buffer) {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  for (const byte of buffer) {
    a = (a + byte) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(typeBytes, data), 8 + data.length);
  return result;
}

function storedZlib(data) {
  const parts = [Buffer.from([0x78, 0x01])];
  let offset = 0;
  while (offset < data.length) {
    const length = Math.min(65_535, data.length - offset);
    const final = offset + length === data.length;
    const header = Buffer.alloc(5);
    header[0] = final ? 1 : 0;
    header.writeUInt16LE(length, 1);
    header.writeUInt16LE((~length) & 0xffff, 3);
    parts.push(header, data.subarray(offset, offset + length));
    offset += length;
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(adler32(data), 0);
  parts.push(checksum);
  return Buffer.concat(parts);
}

function assertDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("PNG width and height must be positive integers");
  }
  if (width * height > MAX_PIXELS) {
    throw new Error(`PNG exceeds the ${MAX_PIXELS}-pixel safety limit`);
  }
}

function paeth(left, up, upperLeft) {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

function unfilter(raw, width, height) {
  const bytesPerPixel = 4;
  const rowBytes = width * bytesPerPixel;
  const expectedLength = height * (rowBytes + 1);
  if (raw.length !== expectedLength) {
    throw new Error(`PNG decompressed data length mismatch: expected ${expectedLength}, got ${raw.length}`);
  }
  const pixels = Buffer.alloc(width * height * bytesPerPixel);
  for (let y = 0; y < height; y += 1) {
    const rawRowStart = y * (rowBytes + 1);
    const filter = raw[rawRowStart];
    if (filter > 4) throw new Error(`PNG scanline ${y} uses unsupported filter ${filter}`);
    const outputRowStart = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const encoded = raw[rawRowStart + 1 + x];
      const left = x >= bytesPerPixel ? pixels[outputRowStart + x - bytesPerPixel] : 0;
      const up = y > 0 ? pixels[outputRowStart - rowBytes + x] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel
        ? pixels[outputRowStart - rowBytes + x - bytesPerPixel]
        : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upperLeft);
      pixels[outputRowStart + x] = (encoded + predictor) & 0xff;
    }
  }
  return pixels;
}

export function decodePngRgba8(bytes) {
  const source = Buffer.from(bytes);
  if (source.length < PNG_SIGNATURE.length || !source.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("input is not a PNG file");
  }

  let offset = 8;
  let width;
  let height;
  let seenIhdr = false;
  let seenIdat = false;
  let endedIdat = false;
  let seenIend = false;
  let sourceHadSrgbChunk = false;
  const idat = [];

  while (offset < source.length) {
    if (offset + 12 > source.length) throw new Error("PNG chunk header is truncated");
    const length = source.readUInt32BE(offset);
    if (length > 256 * 1024 * 1024) throw new Error("PNG chunk exceeds safety limit");
    const end = offset + 12 + length;
    if (end > source.length) throw new Error("PNG chunk is truncated");
    const typeBytes = source.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    const data = source.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = source.readUInt32BE(offset + 8 + length);
    if (crc32(typeBytes, data) !== expectedCrc) throw new Error(`PNG ${type} chunk CRC mismatch`);
    offset = end;

    if (!seenIhdr && type !== "IHDR") throw new Error("PNG IHDR must be the first chunk");
    if (seenIend) throw new Error("PNG contains data after IEND");

    if (type === "IHDR") {
      if (seenIhdr || length !== 13) throw new Error("PNG must contain exactly one 13-byte IHDR");
      seenIhdr = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assertDimensions(width, height);
      if (data[8] !== 8 || data[9] !== 6) {
        throw new Error("PNG input must be 8-bit RGBA (color type 6)");
      }
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error("PNG input must use standard compression/filter methods and be non-interlaced");
      }
    } else if (type === "IDAT") {
      if (endedIdat) throw new Error("PNG IDAT chunks must be consecutive");
      seenIdat = true;
      idat.push(data);
    } else {
      if (seenIdat && type !== "IEND") endedIdat = true;
      if (type === "IEND") {
        if (length !== 0) throw new Error("PNG IEND must be empty");
        seenIend = true;
      } else if (type === "sRGB") {
        if (length !== 1 || data[0] > 3) throw new Error("PNG sRGB chunk is invalid");
        sourceHadSrgbChunk = true;
      } else if (["iCCP", "gAMA", "cHRM"].includes(type)) {
        throw new Error(`PNG ${type} color metadata is outside canonical sRGB crop v1`);
      } else if (["acTL", "fcTL", "fdAT"].includes(type)) {
        throw new Error("animated PNG is outside canonical crop v1");
      } else if ((typeBytes[0] & 0x20) === 0) {
        throw new Error(`PNG contains unsupported critical chunk ${type}`);
      }
    }
  }

  if (!seenIhdr || !seenIdat || !seenIend || offset !== source.length) {
    throw new Error("PNG is missing required IHDR, IDAT, or IEND structure");
  }
  const expectedRawLength = height * (width * 4 + 1);
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expectedRawLength });
  } catch (error) {
    throw new Error(`PNG IDAT decompression failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    width,
    height,
    pixels: unfilter(raw, width, height),
    sourceHadSrgbChunk,
  };
}

export function encodeCanonicalPngRgba8({ width, height, pixels }) {
  assertDimensions(width, height);
  const pixelBytes = Buffer.from(pixels);
  const expectedPixels = width * height * 4;
  if (pixelBytes.length !== expectedPixels) {
    throw new Error(`RGBA8 pixel length mismatch: expected ${expectedPixels}, got ${pixelBytes.length}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowBytes = width * 4;
  const scanlines = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y += 1) {
    const scanlineStart = y * (rowBytes + 1);
    scanlines[scanlineStart] = 0;
    pixelBytes.copy(scanlines, scanlineStart + 1, y * rowBytes, (y + 1) * rowBytes);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("sRGB", Buffer.from([0])),
    chunk("IDAT", storedZlib(scanlines)),
    chunk("IEND"),
  ]);
}

export function cropRgba8(image, parameters) {
  const { x, y, width, height } = parameters;
  for (const [name, value, minimum] of [["x", x, 0], ["y", y, 0], ["width", width, 1], ["height", height, 1]]) {
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(`crop ${name} must be an integer >= ${minimum}`);
    }
  }
  if (x + width > image.width || y + height > image.height) {
    throw new Error(
      `crop rectangle ${x},${y},${width},${height} exceeds source dimensions ${image.width}x${image.height}`,
    );
  }

  const pixels = Buffer.alloc(width * height * 4);
  const sourceRowBytes = image.width * 4;
  const resultRowBytes = width * 4;
  for (let row = 0; row < height; row += 1) {
    const sourceStart = (y + row) * sourceRowBytes + x * 4;
    image.pixels.copy(pixels, row * resultRowBytes, sourceStart, sourceStart + resultRowBytes);
  }
  return { width, height, pixels };
}
