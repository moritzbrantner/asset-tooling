import { assertRgba8Image } from "./image-geometry.js";
import { lumaRgba8 } from "./image-color.js";

const CHANNELS = new Set(["red", "green", "blue", "alpha", "luma"]);

function channelValue(source, offset, channel) {
  if (channel === "red") return source.pixels[offset];
  if (channel === "green") return source.pixels[offset + 1];
  if (channel === "blue") return source.pixels[offset + 2];
  if (channel === "alpha") return source.pixels[offset + 3];
  return lumaRgba8(
    source.pixels[offset],
    source.pixels[offset + 1],
    source.pixels[offset + 2],
  );
}

export function extractRgba8Channel(sourceValue, channel) {
  const source = assertRgba8Image(sourceValue, "source RGBA8 image");
  if (!CHANNELS.has(channel)) {
    throw new Error("channel must be red, green, blue, alpha, or luma");
  }
  const output = Buffer.alloc(source.pixels.length);
  for (let offset = 0; offset < output.length; offset += 4) {
    const value = channelValue(source, offset, channel);
    output[offset] = value;
    output[offset + 1] = value;
    output[offset + 2] = value;
    output[offset + 3] = 255;
  }
  return { width: source.width, height: source.height, pixels: output };
}

function assertSameDimensions(images) {
  const first = images[0];
  for (let index = 1; index < images.length; index += 1) {
    if (images[index].width !== first.width || images[index].height !== first.height) {
      throw new Error("channel source dimensions must exactly match");
    }
  }
}

export function combineRgba8Channels({ red, green, blue, alpha }) {
  const sources = [
    assertRgba8Image(red, "red channel image"),
    assertRgba8Image(green, "green channel image"),
    assertRgba8Image(blue, "blue channel image"),
    assertRgba8Image(alpha, "alpha channel image"),
  ];
  assertSameDimensions(sources);
  const output = Buffer.alloc(sources[0].pixels.length);
  for (let offset = 0; offset < output.length; offset += 4) {
    for (let component = 0; component < 4; component += 1) {
      const source = sources[component];
      output[offset + component] = lumaRgba8(
        source.pixels[offset],
        source.pixels[offset + 1],
        source.pixels[offset + 2],
      );
    }
  }
  return { width: sources[0].width, height: sources[0].height, pixels: output };
}
