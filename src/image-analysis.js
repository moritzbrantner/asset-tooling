import { assertRgba8Image } from "./image-geometry.js";
import { lumaRgba8 } from "./image-color.js";

export function inspectRgba8Image(sourceValue) {
  const source = assertRgba8Image(sourceValue, "source RGBA8 image");
  let opaquePixelCount = 0;
  let transparentPixelCount = 0;
  let translucentPixelCount = 0;
  let minAlpha = 255;
  let maxAlpha = 0;

  for (let offset = 3; offset < source.pixels.length; offset += 4) {
    const alpha = source.pixels[offset];
    minAlpha = Math.min(minAlpha, alpha);
    maxAlpha = Math.max(maxAlpha, alpha);
    if (alpha === 255) opaquePixelCount += 1;
    else if (alpha === 0) transparentPixelCount += 1;
    else translucentPixelCount += 1;
  }

  return {
    width: source.width,
    height: source.height,
    pixelCount: source.width * source.height,
    colorSpace: "srgb",
    alphaMode: "straight",
    opaquePixelCount,
    transparentPixelCount,
    translucentPixelCount,
    minAlpha,
    maxAlpha,
  };
}

export function histogramRgba8(sourceValue) {
  const source = assertRgba8Image(sourceValue, "source RGBA8 image");
  const red = Array(256).fill(0);
  const green = Array(256).fill(0);
  const blue = Array(256).fill(0);
  const alpha = Array(256).fill(0);
  const luma = Array(256).fill(0);

  for (let offset = 0; offset < source.pixels.length; offset += 4) {
    const redValue = source.pixels[offset];
    const greenValue = source.pixels[offset + 1];
    const blueValue = source.pixels[offset + 2];
    const alphaValue = source.pixels[offset + 3];
    red[redValue] += 1;
    green[greenValue] += 1;
    blue[blueValue] += 1;
    alpha[alphaValue] += 1;
    luma[lumaRgba8(redValue, greenValue, blueValue)] += 1;
  }

  return {
    width: source.width,
    height: source.height,
    pixelCount: source.width * source.height,
    bins: 256,
    red,
    green,
    blue,
    alpha,
    luma,
  };
}
