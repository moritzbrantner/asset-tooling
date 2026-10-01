import { canonicalJson } from "./canonical.js";

export const RGBA8_IMAGE_MEDIA_TYPE = "application/vnd.moritzbrantner.rgba8+json";
export const RGBA8_IMAGE_SCHEMA_VERSION = 1;

const MAX_DIMENSION = 8192;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function assertPlainObject(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${location} must be a plain object`);
  }
  // The plain-object check establishes a string-keyed JSON boundary.
  return value as Record<string, unknown>;
}

function assertExactKeys(value: unknown, keys: ReadonlySet<string>, location: string) {
  const object = assertPlainObject(value, location);
  for (const key of Object.keys(object)) {
    if (!keys.has(key)) throw new Error(`${location} contains unknown field '${key}'`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(object, key)) throw new Error(`${location} is missing '${key}'`);
  }
  return object;
}

function dimension(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_DIMENSION) {
    throw new Error(`${location} must be an integer in 1..${MAX_DIMENSION}`);
  }
  return value;
}

function expectedByteLength(width: number, height: number) {
  const length = width * height * 4;
  if (!Number.isSafeInteger(length)) throw new Error("RGBA8 image byte length exceeds the safe integer range");
  return length;
}

function canonicalBase64(value: unknown, location: string) {
  if (typeof value !== "string" || !BASE64_PATTERN.test(value)) {
    throw new Error(`${location} must be canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new Error(`${location} must be canonical base64`);
  }
  return bytes;
}

export type Rgba8Image = {
  width: number;
  height: number;
  pixels: Uint8Array;
};

export function createRgba8Image({ width, height, pixels }: Rgba8Image) {
  const normalizedWidth = dimension(width, "RGBA8 image width");
  const normalizedHeight = dimension(height, "RGBA8 image height");
  if (!(pixels instanceof Uint8Array)) {
    throw new Error("RGBA8 image pixels must be a Uint8Array");
  }
  const pixelBytes = Buffer.from(pixels);
  const expected = expectedByteLength(normalizedWidth, normalizedHeight);
  if (pixelBytes.length !== expected) {
    throw new Error(`RGBA8 image pixels must contain exactly ${expected} bytes`);
  }
  return {
    schemaVersion: RGBA8_IMAGE_SCHEMA_VERSION,
    width: normalizedWidth,
    height: normalizedHeight,
    colorSpace: "srgb",
    alphaMode: "straight",
    pixelsBase64: pixelBytes.toString("base64"),
  };
}

export function encodeRgba8Image(image: Rgba8Image) {
  return Buffer.from(`${canonicalJson(createRgba8Image(image))}\n`, "utf8");
}

export function parseRgba8Image(bytes: Uint8Array, expectedDimensions?: Pick<Rgba8Image, "width" | "height">) {
  if (!(bytes instanceof Uint8Array)) throw new Error("RGBA8 image bytes must be a Uint8Array");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error: unknown) {
    throw new Error(`RGBA8 image is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const document = assertExactKeys(
    value,
    new Set(["schemaVersion", "width", "height", "colorSpace", "alphaMode", "pixelsBase64"]),
    "RGBA8 image",
  );
  if (document.schemaVersion !== RGBA8_IMAGE_SCHEMA_VERSION) {
    throw new Error(`RGBA8 image schemaVersion must be ${RGBA8_IMAGE_SCHEMA_VERSION}`);
  }
  const width = dimension(document.width, "RGBA8 image width");
  const height = dimension(document.height, "RGBA8 image height");
  if (document.colorSpace !== "srgb") throw new Error("RGBA8 image colorSpace must be 'srgb'");
  if (document.alphaMode !== "straight") throw new Error("RGBA8 image alphaMode must be 'straight'");
  if (expectedDimensions && (width !== expectedDimensions.width || height !== expectedDimensions.height)) {
    throw new Error("RGBA8 image dimensions disagree with expected dimensions");
  }
  const pixels = canonicalBase64(document.pixelsBase64, "RGBA8 image pixelsBase64");
  const expected = expectedByteLength(width, height);
  if (pixels.length !== expected) {
    throw new Error(`RGBA8 image pixelsBase64 must decode to exactly ${expected} bytes`);
  }
  return { width, height, colorSpace: "srgb", alphaMode: "straight", pixels };
}
