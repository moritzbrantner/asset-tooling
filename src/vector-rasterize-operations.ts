// Derive transparent raster sizes from an editable SVG through one established rasterizer (resvg, WebAssembly build).
// The SVG stays the editable source; every raster is a derived canonical RGBA8 image whose build identity names the
// exact rasterizer package version and WebAssembly bytes. Unsupported SVG features are diagnosed and rejected rather
// than silently flattened. See docs/vector-artwork.md.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { initWasm, Resvg } from "@resvg/resvg-wasm";

import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { sha256Bytes } from "./hash.js";
import { encodeRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "./image-rgba8.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  createAssetRef,
  normalizeAssetOperationResult,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";

export type VectorRasterizeInvocation = { parameters?: unknown; inputs?: unknown };
export type SvgRasterDiagnosis = { width: number; height: number; diagnostics: string[] };

const VERSION = "1";
const MAX_DIMENSION = 4096;
const MAX_PADDING = 1024;
const MAX_SVG_BYTES = 1024 * 1024;
const RASTERIZER_PACKAGE = "@resvg/resvg-wasm";

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "image.vector.rasterize",
    version: VERSION,
    label: "Rasterize SVG",
    description:
      "Derive one transparent straight-alpha sRGB RGBA8 raster from an editable SVG at an explicit pixel size and transparent padding through the pinned resvg WebAssembly rasterizer. Unsupported SVG features fail with diagnostics.",
    category: "image.vector",
    inputs: [{ id: "source", label: "SVG", assetKinds: ["vector-image"], mediaTypes: ["image/svg+xml"] }],
    outputs: [{ id: "output", label: "Canonical RGBA8 image", assetKinds: ["image"], mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE] }],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["width", "height", "padding"],
      properties: {
        width: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        height: { type: "integer", minimum: 1, maximum: MAX_DIMENSION },
        padding: { type: "integer", minimum: 0, maximum: MAX_PADDING },
      },
    },
  },
]);

export const VECTOR_RASTERIZE_OPERATION = OPERATION_REGISTRY.get("image.vector.rasterize", VERSION)!;
export const VECTOR_RASTERIZE_OPERATIONS = OPERATION_REGISTRY.list();

// The SVG subset whose rendering does not depend on fonts, external resources, scripts, CSS cascade or filters.
const ELEMENTS = new Set(["svg", "g", "circle", "ellipse", "rect", "line", "polyline", "polygon", "path"]);
const GEOMETRY_ATTRIBUTES = new Set([
  "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "width", "height", "points", "d", "transform", "id",
]);
const PAINT_ATTRIBUTES = new Set(["fill", "stroke"]);
const PRESENTATION_ATTRIBUTES = new Set([
  "fill-opacity", "fill-rule", "stroke-width", "stroke-opacity", "stroke-linejoin", "stroke-linecap",
  "stroke-miterlimit", "opacity",
]);
const ROOT_ATTRIBUTES = new Set(["xmlns", "width", "height", "viewBox"]);
const PAINT = /^(none|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})$/;
const PIXEL_LENGTH = /^[1-9][0-9]*$/;

function integer(value: unknown, location: string, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${location} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

/**
 * Check that an SVG uses only the rasterizable subset above. Returns every unsupported feature found (not just the
 * first) so an author can fix them together; an empty list means the SVG is accepted.
 */
export function diagnoseSvgForRasterization(bytes: Uint8Array): SvgRasterDiagnosis {
  const diagnostics: string[] = [];
  if (bytes.byteLength > MAX_SVG_BYTES) diagnostics.push(`SVG is ${bytes.byteLength} bytes; the limit is ${MAX_SVG_BYTES}`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { width: 0, height: 0, diagnostics: [...diagnostics, "SVG is not valid UTF-8"] };
  }
  let width = 0, height = 0, cursor = 0, depth = 0, sawRoot = false;
  const stack: string[] = [];
  const tag = /<([^>]*)>/g;
  for (let match = tag.exec(text); match; match = tag.exec(text)) {
    const between = text.slice(cursor, match.index);
    if (between.trim().length > 0) diagnostics.push(`text content '${between.trim().slice(0, 24)}' is not supported`);
    cursor = match.index + match[0].length;
    const body = match[1]!;
    if (body.startsWith("?")) {
      if (sawRoot || !/^\?xml\s[^?]*\?$/.test(body)) diagnostics.push(`processing instruction <${body.slice(0, 24)}> is not supported`);
      continue;
    }
    if (body.startsWith("!--")) {
      if (!body.endsWith("--")) diagnostics.push("comments may not contain '>'");
      continue;
    }
    if (body.startsWith("!")) {
      diagnostics.push(`<${body.slice(0, 24)}> (DOCTYPE, entity or CDATA) is not supported`);
      continue;
    }
    if (body.startsWith("/")) {
      const name = body.slice(1).trim();
      if (stack.pop() !== name) diagnostics.push(`closing tag </${name}> does not match`);
      depth -= 1;
      continue;
    }
    const selfClosing = body.endsWith("/");
    const content = selfClosing ? body.slice(0, -1) : body;
    const nameMatch = /^([A-Za-z_][-\w.:]*)/.exec(content);
    if (!nameMatch) {
      diagnostics.push(`malformed tag <${body.slice(0, 24)}>`);
      continue;
    }
    const name = nameMatch[1]!;
    const attributes = new Map<string, string>();
    const attribute = /\s+([A-Za-z_][-\w.:]*)\s*=\s*"([^"<]*)"/y;
    attribute.lastIndex = name.length;
    let end = name.length;
    for (let found = attribute.exec(content); found; found = attribute.exec(content)) {
      if (attributes.has(found[1]!)) diagnostics.push(`<${name}> repeats attribute '${found[1]}'`);
      attributes.set(found[1]!, found[2]!);
      end = attribute.lastIndex;
    }
    if (content.slice(end).trim().length > 0) diagnostics.push(`<${name}> has malformed attributes '${content.slice(end).trim().slice(0, 24)}'`);
    if (depth === 0) {
      if (sawRoot || name !== "svg") diagnostics.push(`the document must have exactly one root <svg>; found <${name}>`);
      sawRoot = true;
      for (const [key, value] of attributes) {
        if (!ROOT_ATTRIBUTES.has(key)) diagnostics.push(`root <svg> attribute '${key}' is not supported`);
        else if (key === "xmlns" && value !== "http://www.w3.org/2000/svg") diagnostics.push(`root xmlns '${value}' is not the SVG namespace`);
      }
      const w = attributes.get("width"), h = attributes.get("height");
      if (!w || !h || !PIXEL_LENGTH.test(w) || !PIXEL_LENGTH.test(h)) {
        diagnostics.push("root <svg> needs unitless positive integer width and height");
      } else {
        width = Number(w);
        height = Number(h);
        if (width > MAX_DIMENSION || height > MAX_DIMENSION) diagnostics.push(`root <svg> size ${width}x${height} exceeds ${MAX_DIMENSION}`);
      }
      if (attributes.get("xmlns") === undefined) diagnostics.push("root <svg> needs xmlns=\"http://www.w3.org/2000/svg\"");
    } else if (!ELEMENTS.has(name) || name === "svg") {
      diagnostics.push(`element <${name}> is not supported`);
    } else {
      for (const [key, value] of attributes) {
        if (PAINT_ATTRIBUTES.has(key)) {
          if (!PAINT.test(value)) diagnostics.push(`<${name}> ${key}='${value}' is not a plain color or none`);
        } else if (!GEOMETRY_ATTRIBUTES.has(key) && !PRESENTATION_ATTRIBUTES.has(key)) {
          diagnostics.push(`<${name}> attribute '${key}' is not supported`);
        }
      }
    }
    if (!selfClosing) {
      stack.push(name);
      depth += 1;
    }
  }
  if (text.slice(cursor).trim().length > 0) diagnostics.push("trailing content after the last tag is not supported");
  if (!sawRoot) diagnostics.push("no root <svg> element");
  if (stack.length > 0) diagnostics.push(`unclosed element <${stack.at(-1)}>`);
  return { width, height, diagnostics };
}

let rasterizer: Promise<{ version: string; wasmSha256: string }> | undefined;

/** Load the pinned rasterizer once per process and report its identity (package version and WebAssembly hash). */
export function vectorRasterizerIdentity() {
  rasterizer ??= (async () => {
    const require = createRequire(import.meta.url);
    const packageDirectory = path.dirname(require.resolve(`${RASTERIZER_PACKAGE}/package.json`));
    const manifest = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8")) as { version: string };
    const wasm = await readFile(path.join(packageDirectory, "index_bg.wasm"));
    await initWasm(wasm);
    return { version: manifest.version, wasmSha256: sha256Bytes(wasm) };
  })();
  return rasterizer;
}

function normalizeParameters(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("image.vector.rasterize parameters must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["width", "height", "padding"].includes(key)) throw new Error(`image.vector.rasterize parameters contain unknown field '${key}'`);
  }
  return {
    width: integer(record.width, "parameters.width", 1, MAX_DIMENSION),
    height: integer(record.height, "parameters.height", 1, MAX_DIMENSION),
    padding: integer(record.padding, "parameters.padding", 0, MAX_PADDING),
  };
}

function assertRoot(root: string) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("vector rasterize operation root must be an absolute path");
  return root;
}

async function prepare(root: string, { parameters, inputs = {} }: VectorRasterizeInvocation) {
  const assetRoot = assertRoot(root);
  const normalized = normalizeParameters(parameters);
  const identity = await vectorRasterizerIdentity();
  const build = createAssetOperationBuildIdentity({
    operation: VECTOR_RASTERIZE_OPERATION,
    implementation: {
      id: "builtin.image.vector.rasterize",
      version: VERSION,
      algorithm: "resvg-geometric-precision-premultiplied-to-straight-rgba8-padded-v1",
      rasterizer: { package: RASTERIZER_PACKAGE, version: identity.version, wasmSha256: identity.wasmSha256 },
      randomness: "none",
      tool: await captureToolIdentity(),
    },
    parameters: normalized,
    inputs,
  });
  const source = createAssetRef(build.inputs.source);
  const sourceBytes = await resolveAssetObject(assetRoot, source);
  const diagnosis = diagnoseSvgForRasterization(sourceBytes);
  if (diagnosis.diagnostics.length > 0) {
    throw new Error(`image.vector.rasterize: SVG uses unsupported features: ${diagnosis.diagnostics.join("; ")}`);
  }
  if (normalized.width * diagnosis.height !== normalized.height * diagnosis.width) {
    throw new Error(
      `image.vector.rasterize: ${normalized.width}x${normalized.height} does not keep the SVG's ${diagnosis.width}x${diagnosis.height} aspect ratio`,
    );
  }
  return { assetRoot, build, source, sourceBytes, parameters: normalized };
}

export async function createVectorRasterizeOperationBuildIdentity(root: string, invocation: VectorRasterizeInvocation = {}) {
  return (await prepare(root, invocation)).build;
}

export async function executeVectorRasterizeOperation(root: string, invocation: VectorRasterizeInvocation = {}) {
  const prepared = await prepare(root, invocation);
  const { width, height, padding } = prepared.parameters;
  const renderer = new Resvg(prepared.sourceBytes, {
    fitTo: { mode: "width", value: width },
    shapeRendering: 2,
    font: { loadSystemFonts: false },
  });
  let rendered;
  try {
    rendered = renderer.render();
  } finally {
    renderer.free();
  }
  const premultiplied = rendered.pixels;
  if (rendered.width !== width || rendered.height !== height || premultiplied.length !== width * height * 4) {
    rendered.free();
    throw new Error(`image.vector.rasterize: rasterizer produced ${rendered.width}x${rendered.height}; expected ${width}x${height}`);
  }
  rendered.free();
  const outputWidth = width + 2 * padding, outputHeight = height + 2 * padding;
  const pixels = new Uint8Array(outputWidth * outputHeight * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4, to = ((y + padding) * outputWidth + x + padding) * 4;
      const alpha = premultiplied[from + 3]!;
      if (alpha === 0) continue; // Fully transparent texels keep zero colour: no fringe colour leaks into filtering.
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[to + channel] = Math.min(255, Math.round((premultiplied[from + channel]! * 255) / alpha));
      }
      pixels[to + 3] = alpha;
    }
  }
  const stored = await storeAssetObject(prepared.assetRoot, {
    bytes: encodeRgba8Image({ width: outputWidth, height: outputHeight, pixels }),
    kind: "image",
    mediaType: RGBA8_IMAGE_MEDIA_TYPE,
    metadata: {
      width: outputWidth,
      height: outputHeight,
      pixelFormat: "rgba8",
      colorSpace: "srgb",
      alphaMode: "straight",
      sourceSha256: prepared.source.sha256,
      padding,
      generator: `${VECTOR_RASTERIZE_OPERATION.id}@${VECTOR_RASTERIZE_OPERATION.version}`,
    },
  });
  return normalizeAssetOperationResult(VECTOR_RASTERIZE_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      width: outputWidth,
      height: outputHeight,
      contentWidth: width,
      contentHeight: height,
      padding,
      algorithm: prepared.build.implementation.algorithm,
    },
  });
}
