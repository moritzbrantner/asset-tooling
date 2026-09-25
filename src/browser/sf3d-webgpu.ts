/**
 * Browser Stable Fast 3D runtime.
 *
 * Inference structure is adapted from Pixel11211/sf3d-webgpu at
 * 751e6642761466dbf15ed1e4c53ef6ed4db12b40 (MIT). Model artifacts are
 * fetched from the immutable needle-tools/SF3D-webgpu revision declared in
 * sf3d-model-manifest.ts and remain governed by the Stability AI Community License.
 */
import * as ort from "onnxruntime-web";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { borderWhiteToAlphaRgba8 } from "../image-border-white-alpha-core.js";
import {
  BROWSER_ORT_VERSION,
  BROWSER_SF3D_CACHE_NAME,
  BROWSER_SF3D_MODEL,
} from "./sf3d-model-manifest.js";

export type BrowserProgress = (stage: string, fraction: number, detail?: string) => void;

export interface BrowserMeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  roughness: number;
  metallic: number;
}

export interface BrowserSf3dDiagnostics {
  adapterInfo: string;
  shaderF16: boolean;
  maxBufferSize?: number;
  maxStorageBufferBindingSize?: number;
}

const HF_BASE =
  "https://huggingface.co/" +
  BROWSER_SF3D_MODEL.repository +
  "/resolve/" +
  BROWSER_SF3D_MODEL.revision;
const ORT_WASM_PATHS =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@" + BROWSER_ORT_VERSION + "/dist/";

const COND_IMAGE_SIZE = 512;
const BACKGROUND_COLOR = [0.5, 0.5, 0.5] as const;
const FOREGROUND_RATIO = 0.85;
const ISO_RESOLUTION = 160;
const ISO_THRESHOLD = 10.0;
const TRIPLANE_PLANES = 3;
const TRIPLANE_CHANNELS = 40;
const TRIPLANE_SIZE = 384;
const TRIPLANE_FEATURE_DIM = 120;
const TET_VERTEX_COUNT = 535882;
const DEFAULT_ROUGHNESS = 0.75;
const DEFAULT_METALLIC = 0.0;
const BACKGROUND_FLOOR = 224;
const TRANSPARENT_ABOVE = 250;

type AssetKey = keyof typeof BROWSER_SF3D_MODEL.assets;

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function bufferWithProgress(
  response: Response,
  expectedBytes: number,
  stage: string,
  progress?: BrowserProgress,
): Promise<ArrayBuffer> {
  if (!response.body) return response.arrayBuffer();
  const reader = response.body.getReader();
  let received = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      if (next.value) {
        received += next.value.byteLength;
        progress?.(
          stage,
          Math.min(1, received / expectedBytes),
          (received / 1_000_000).toFixed(0) +
            " / " +
            (expectedBytes / 1_000_000).toFixed(0) +
            " MB",
        );
        controller.enqueue(next.value);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(stream).arrayBuffer();
}

async function verifyAssetBytes(
  key: AssetKey,
  bytes: ArrayBuffer,
): Promise<void> {
  const spec = BROWSER_SF3D_MODEL.assets[key];
  if (bytes.byteLength !== spec.bytes) {
    throw new Error(
      "browser model asset " +
        spec.path +
        " has " +
        bytes.byteLength +
        " bytes; expected " +
        spec.bytes,
    );
  }
  const actual = await sha256Hex(bytes);
  if (actual !== spec.sha256) {
    throw new Error(
      "browser model asset " +
        spec.path +
        " failed SHA-256 verification; expected " +
        spec.sha256 +
        ", got " +
        actual,
    );
  }
}

export async function fetchVerifiedBrowserSf3dAsset(
  key: AssetKey,
  progress?: BrowserProgress,
): Promise<ArrayBuffer> {
  const spec = BROWSER_SF3D_MODEL.assets[key];
  const url = HF_BASE + "/" + spec.path;
  const stage = "model:" + key;

  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open(BROWSER_SF3D_CACHE_NAME);
      const cached = await cache.match(url);
      if (cached) {
        progress?.(stage, 0, "verifying cached bytes");
        const bytes = await cached.arrayBuffer();
        try {
          await verifyAssetBytes(key, bytes);
          progress?.(stage, 1, "verified cache");
          return bytes;
        } catch {
          await cache.delete(url);
        }
      }
    } catch {
      // Cache Storage is acceleration only. Verification still happens on fresh bytes.
    }
  }

  progress?.(stage, 0, "downloading");
  const response = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!response.ok) {
    throw new Error("could not acquire " + spec.path + ": HTTP " + response.status);
  }
  const bytes = await bufferWithProgress(response, spec.bytes, stage, progress);
  await verifyAssetBytes(key, bytes);

  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open(BROWSER_SF3D_CACHE_NAME);
      await cache.put(
        url,
        new Response(bytes.slice(0), {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(bytes.byteLength),
          },
        }),
      );
    } catch {
      // Browsers may refuse very large Cache Storage entries. Generation can proceed.
    }
  }
  progress?.(stage, 1, "downloaded and verified");
  return bytes;
}

export async function clearBrowserSf3dCache(): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  return caches.delete(BROWSER_SF3D_CACHE_NAME);
}

let ortConfigured = false;

function configureOrt(): void {
  if (ortConfigured) return;
  ort.env.wasm.wasmPaths = ORT_WASM_PATHS;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  try {
    (ort.env as unknown as { webgpu?: { powerPreference?: string } }).webgpu = {
      ...((ort.env as unknown as { webgpu?: Record<string, unknown> }).webgpu ?? {}),
      powerPreference: "high-performance",
    };
  } catch {
    // Older ORT builds may expose a readonly WebGPU configuration object.
  }
  ortConfigured = true;
}

async function requireWebGpu(): Promise<BrowserSf3dDiagnostics> {
  if (typeof window !== "undefined" && !window.isSecureContext) {
    throw new Error("WebGPU requires HTTPS or localhost.");
  }
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(options?: unknown): Promise<any> } }).gpu;
  if (!gpu) {
    throw new Error("WebGPU is not available in this browser.");
  }
  configureOrt();
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) {
    throw new Error("No WebGPU adapter is available.");
  }
  const shaderF16 = Boolean(adapter.features?.has?.("shader-f16"));
  if (!shaderF16) {
    throw new Error("The selected WebGPU adapter does not support shader-f16, required by the SF3D backbone.");
  }
  const info = adapter.info;
  const adapterInfo = info
    ? [info.vendor, info.device, info.architecture, info.description].filter(Boolean).join(" ") || "WebGPU adapter"
    : "WebGPU adapter";
  return {
    adapterInfo,
    shaderF16,
    maxBufferSize: Number(adapter.limits?.maxBufferSize) || undefined,
    maxStorageBufferBindingSize:
      Number(adapter.limits?.maxStorageBufferBindingSize) || undefined,
  };
}

async function createSession(bytes: ArrayBuffer): Promise<ort.InferenceSession> {
  configureOrt();
  return ort.InferenceSession.create(new Uint8Array(bytes), {
    executionProviders: ["webgpu"],
    graphOptimizationLevel: "all",
    logSeverityLevel: 2,
  });
}

function f32Tensor(data: Float32Array, dimensions: number[]): ort.Tensor {
  return new ort.Tensor("float32", data, dimensions);
}

function outputFloat32(tensor: ort.Tensor): Float32Array {
  return tensor.data as Float32Array;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function silu(value: number): number {
  return value / (1 + Math.exp(-value));
}

function scalePositions(
  positions: Float32Array,
  inputLow: number,
  inputHigh: number,
  outputLow: number,
  outputHigh: number,
): Float32Array {
  const scale = (outputHigh - outputLow) / (inputHigh - inputLow);
  for (let index = 0; index < positions.length; index += 1) {
    positions[index] = ((positions[index] ?? 0) - inputLow) * scale + outputLow;
  }
  return positions;
}

function defaultCondC2W(distance = 1.6): Float32Array {
  return new Float32Array([
    0, 0, 1, distance,
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 0, 1,
  ]);
}

function intrinsicNormed(fovDegrees = 40): Float32Array {
  const field = (fovDegrees * Math.PI) / 180;
  const focal = (0.5 * COND_IMAGE_SIZE) / Math.tan(0.5 * field);
  return new Float32Array([
    focal / COND_IMAGE_SIZE, 0, 0.5,
    0, focal / COND_IMAGE_SIZE, 0.5,
    0, 0, 1,
  ]);
}

function makeCanvas(width: number, height: number) {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D canvas is unavailable");
    return { canvas, context };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("2D canvas is unavailable");
  return { canvas, context };
}

async function readBlobRgba(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  const target = makeCanvas(bitmap.width, bitmap.height);
  target.context.drawImage(bitmap, 0, 0);
  const data = target.context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close?.();
  return { width: data.width, height: data.height, pixels: data.data };
}

function hasMeaningfulAlpha(pixels: Uint8Array | Uint8ClampedArray): boolean {
  for (let offset = 3; offset < pixels.length; offset += 4) {
    if ((pixels[offset] ?? 255) < 250) return true;
  }
  return false;
}

function foregroundBounds(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
) {
  let x0 = -1;
  let x1 = -1;
  let y0 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    let row = false;
    for (let x = 0; x < width; x += 1) {
      if ((pixels[(y * width + x) * 4 + 3] ?? 0) > 127) {
        row = true;
        if (x0 < 0 || x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
    }
    if (row) {
      if (y0 < 0) y0 = y;
      y1 = y;
    }
  }
  if (x0 < 0) return null;
  return { x0, x1, y0, y1 };
}

async function preprocessImage(blob: Blob): Promise<{
  rgb: Float32Array;
  matte: "source-alpha" | "border-white";
  transparentPixelCount: number;
}> {
  const decoded = await readBlobRgba(blob);
  const sourceHasAlpha = hasMeaningfulAlpha(decoded.pixels);
  const prepared = sourceHasAlpha
    ? {
        image: decoded,
        observations: { transparentPixelCount: 0 },
      }
    : borderWhiteToAlphaRgba8(decoded, {
        backgroundFloor: BACKGROUND_FLOOR,
        transparentAbove: TRANSPARENT_ABOVE,
      });

  const bounds =
    foregroundBounds(prepared.image.pixels, prepared.image.width, prepared.image.height) ?? {
      x0: 0,
      y0: 0,
      x1: prepared.image.width - 1,
      y1: prepared.image.height - 1,
    };
  const boxWidth = Math.max(1, bounds.x1 - bounds.x0);
  const boxHeight = Math.max(1, bounds.y1 - bounds.y0);
  const centerX = (bounds.x0 + bounds.x1) / 2;
  const centerY = (bounds.y0 + bounds.y1) / 2;
  const cropSize = Math.max(boxWidth, boxHeight) / FOREGROUND_RATIO;
  const cropLeft = centerX - cropSize / 2;
  const cropTop = centerY - cropSize / 2;

  const source = makeCanvas(prepared.image.width, prepared.image.height);
  source.context.putImageData(
    new ImageData(
      new Uint8ClampedArray(
        prepared.image.pixels.buffer,
        prepared.image.pixels.byteOffset,
        prepared.image.pixels.byteLength,
      ),
      prepared.image.width,
      prepared.image.height,
    ),
    0,
    0,
  );

  const target = makeCanvas(COND_IMAGE_SIZE, COND_IMAGE_SIZE);
  target.context.clearRect(0, 0, COND_IMAGE_SIZE, COND_IMAGE_SIZE);
  const factor = COND_IMAGE_SIZE / cropSize;
  target.context.imageSmoothingEnabled = true;
  target.context.imageSmoothingQuality = "high";
  target.context.setTransform(
    factor,
    0,
    0,
    factor,
    -cropLeft * factor,
    -cropTop * factor,
  );
  target.context.drawImage(source.canvas, 0, 0);
  target.context.setTransform(1, 0, 0, 1, 0, 0);
  const resized = target.context.getImageData(
    0,
    0,
    COND_IMAGE_SIZE,
    COND_IMAGE_SIZE,
  ).data;

  const rgb = new Float32Array(COND_IMAGE_SIZE * COND_IMAGE_SIZE * 3);
  const [backgroundRed, backgroundGreen, backgroundBlue] = BACKGROUND_COLOR;
  for (let index = 0; index < COND_IMAGE_SIZE * COND_IMAGE_SIZE; index += 1) {
    const alpha = (resized[index * 4 + 3] ?? 0) / 255;
    rgb[index * 3] =
      backgroundRed * (1 - alpha) + ((resized[index * 4] ?? 0) / 255) * alpha;
    rgb[index * 3 + 1] =
      backgroundGreen * (1 - alpha) + ((resized[index * 4 + 1] ?? 0) / 255) * alpha;
    rgb[index * 3 + 2] =
      backgroundBlue * (1 - alpha) + ((resized[index * 4 + 2] ?? 0) / 255) * alpha;
  }

  return {
    rgb,
    matte: sourceHasAlpha ? "source-alpha" : "border-white",
    transparentPixelCount: prepared.observations.transparentPixelCount,
  };
}

interface Triplane {
  data: Float32Array;
  planes: number;
  channels: number;
  size: number;
}

function queryTriplane(
  triplane: Triplane,
  positions: Float32Array,
  count: number,
): Float32Array {
  const { data, planes, channels, size } = triplane;
  const planeStride = channels * size * size;
  const channelStride = size * size;
  const featureDimension = planes * channels;
  const result = new Float32Array(count * featureDimension);
  const coordinateScale = (size - 1) * 0.5;

  for (let item = 0; item < count; item += 1) {
    const x = positions[item * 3] ?? 0;
    const y = positions[item * 3 + 1] ?? 0;
    const z = positions[item * 3 + 2] ?? 0;
    const outputBase = item * featureDimension;
    for (let plane = 0; plane < planes; plane += 1) {
      const u = plane === 2 ? y : x;
      const v = plane === 0 ? y : z;
      const fx = (u + 1) * coordinateScale;
      const fy = (v + 1) * coordinateScale;
      let x0 = Math.floor(fx);
      let y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      let x1 = x0 + 1;
      let y1 = y0 + 1;
      x0 = clamp(x0, 0, size - 1);
      x1 = clamp(x1, 0, size - 1);
      y0 = clamp(y0, 0, size - 1);
      y1 = clamp(y1, 0, size - 1);
      const planeOffset = plane * planeStride;
      const sample00 = planeOffset + y0 * size + x0;
      const sample01 = planeOffset + y0 * size + x1;
      const sample10 = planeOffset + y1 * size + x0;
      const sample11 = planeOffset + y1 * size + x1;
      const weight00 = (1 - tx) * (1 - ty);
      const weight01 = tx * (1 - ty);
      const weight10 = (1 - tx) * ty;
      const weight11 = tx * ty;
      const outputOffset = outputBase + plane * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        const channelOffset = channel * channelStride;
        result[outputOffset + channel] =
          (data[sample00 + channelOffset] ?? 0) * weight00 +
          (data[sample01 + channelOffset] ?? 0) * weight01 +
          (data[sample10 + channelOffset] ?? 0) * weight10 +
          (data[sample11 + channelOffset] ?? 0) * weight11;
      }
    }
  }
  return result;
}

interface ColorHeadJson {
  w0: number[][];
  b0: number[];
  w1: number[][];
  b1: number[];
  w2: number[][];
  b2: number[];
  w3: number[][];
  b3: number[];
}

interface ColorHeadWeights {
  w0: Float32Array;
  b0: Float32Array;
  w1: Float32Array;
  b1: Float32Array;
  w2: Float32Array;
  b2: Float32Array;
  w3: Float32Array;
  b3: Float32Array;
}

function flatten2d(values: number[][]): Float32Array {
  const rows = values.length;
  const columns = values[0]?.length ?? 0;
  const result = new Float32Array(rows * columns);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      result[row * columns + column] = values[row]?.[column] ?? 0;
    }
  }
  return result;
}

function parseColorHead(value: ColorHeadJson): ColorHeadWeights {
  return {
    w0: flatten2d(value.w0),
    b0: Float32Array.from(value.b0),
    w1: flatten2d(value.w1),
    b1: Float32Array.from(value.b1),
    w2: flatten2d(value.w2),
    b2: Float32Array.from(value.b2),
    w3: flatten2d(value.w3),
    b3: Float32Array.from(value.b3),
  };
}

function colorHeadForward(
  weights: ColorHeadWeights,
  features: Float32Array,
  count: number,
): Float32Array {
  const hidden = 64;
  const result = new Float32Array(count * 3);
  const first = new Float32Array(hidden);
  const second = new Float32Array(hidden);
  const third = new Float32Array(hidden);

  for (let item = 0; item < count; item += 1) {
    const featureOffset = item * TRIPLANE_FEATURE_DIM;
    for (let output = 0; output < hidden; output += 1) {
      let value = weights.b0[output] ?? 0;
      const row = output * TRIPLANE_FEATURE_DIM;
      for (let input = 0; input < TRIPLANE_FEATURE_DIM; input += 1) {
        value += (weights.w0[row + input] ?? 0) * (features[featureOffset + input] ?? 0);
      }
      first[output] = silu(value);
    }
    for (let output = 0; output < hidden; output += 1) {
      let value = weights.b1[output] ?? 0;
      const row = output * hidden;
      for (let input = 0; input < hidden; input += 1) {
        value += (weights.w1[row + input] ?? 0) * (first[input] ?? 0);
      }
      second[output] = silu(value);
    }
    for (let output = 0; output < hidden; output += 1) {
      let value = weights.b2[output] ?? 0;
      const row = output * hidden;
      for (let input = 0; input < hidden; input += 1) {
        value += (weights.w2[row + input] ?? 0) * (second[input] ?? 0);
      }
      third[output] = silu(value);
    }
    for (let output = 0; output < 3; output += 1) {
      let value = weights.b3[output] ?? 0;
      const row = output * hidden;
      for (let input = 0; input < hidden; input += 1) {
        value += (weights.w3[row + input] ?? 0) * (third[input] ?? 0);
      }
      result[item * 3 + output] = clamp(value, 0, 1);
    }
  }
  return result;
}

const TRIANGLE_TABLE: readonly (readonly number[])[] = [
  [-1, -1, -1, -1, -1, -1],
  [1, 0, 2, -1, -1, -1],
  [4, 0, 3, -1, -1, -1],
  [1, 4, 2, 1, 3, 4],
  [3, 1, 5, -1, -1, -1],
  [2, 3, 0, 2, 5, 3],
  [1, 4, 0, 1, 5, 4],
  [4, 2, 5, -1, -1, -1],
  [4, 5, 2, -1, -1, -1],
  [4, 1, 0, 4, 5, 1],
  [3, 2, 0, 3, 5, 2],
  [1, 3, 5, -1, -1, -1],
  [4, 1, 2, 4, 3, 1],
  [3, 0, 4, -1, -1, -1],
  [2, 0, 1, -1, -1, -1],
  [-1, -1, -1, -1, -1, -1],
];
const TRIANGLE_COUNT = [0, 1, 1, 2, 1, 2, 2, 1, 1, 2, 2, 1, 2, 1, 1, 0];
const TET_EDGES = [0, 1, 0, 2, 0, 3, 1, 2, 1, 3, 2, 3];

function marchingTetrahedra(
  positions: Float32Array,
  sdf: Float32Array,
  tetrahedra: Int32Array,
) {
  const vertexCount = sdf.length;
  const tetCount = Math.floor(tetrahedra.length / 4);
  const occupied = new Uint8Array(vertexCount);
  for (let index = 0; index < vertexCount; index += 1) {
    occupied[index] = (sdf[index] ?? 0) > 0 ? 1 : 0;
  }

  const vertices: number[] = [];
  const faces: number[] = [];
  const edgeMap = new Map<number, number>();
  const mappedEdges = new Int32Array(6);
  const local = new Int32Array(4);

  for (let tet = 0; tet < tetCount; tet += 1) {
    const base = tet * 4;
    local[0] = tetrahedra[base] ?? 0;
    local[1] = tetrahedra[base + 1] ?? 0;
    local[2] = tetrahedra[base + 2] ?? 0;
    local[3] = tetrahedra[base + 3] ?? 0;
    const o0 = occupied[local[0] ?? 0] ?? 0;
    const o1 = occupied[local[1] ?? 0] ?? 0;
    const o2 = occupied[local[2] ?? 0] ?? 0;
    const o3 = occupied[local[3] ?? 0] ?? 0;
    const sum = o0 + o1 + o2 + o3;
    if (sum === 0 || sum === 4) continue;
    const caseIndex = o0 | (o1 << 1) | (o2 << 2) | (o3 << 3);
    const triangleCount = TRIANGLE_COUNT[caseIndex] ?? 0;
    if (triangleCount === 0) continue;

    for (let edge = 0; edge < 6; edge += 1) {
      const left = local[TET_EDGES[edge * 2] ?? 0] ?? 0;
      const right = local[TET_EDGES[edge * 2 + 1] ?? 0] ?? 0;
      if ((occupied[left] ?? 0) === (occupied[right] ?? 0)) {
        mappedEdges[edge] = -1;
        continue;
      }
      const minimum = Math.min(left, right);
      const maximum = Math.max(left, right);
      const key = minimum * vertexCount + maximum;
      let mapped = edgeMap.get(key);
      if (mapped === undefined) {
        const first = sdf[minimum] ?? 0;
        const second = sdf[maximum] ?? 0;
        const denominator = first - second;
        const firstWeight = denominator !== 0 ? -second / denominator : 0.5;
        const secondWeight = denominator !== 0 ? first / denominator : 0.5;
        const firstPosition = minimum * 3;
        const secondPosition = maximum * 3;
        mapped = vertices.length / 3;
        vertices.push(
          (positions[firstPosition] ?? 0) * firstWeight +
            (positions[secondPosition] ?? 0) * secondWeight,
          (positions[firstPosition + 1] ?? 0) * firstWeight +
            (positions[secondPosition + 1] ?? 0) * secondWeight,
          (positions[firstPosition + 2] ?? 0) * firstWeight +
            (positions[secondPosition + 2] ?? 0) * secondWeight,
        );
        edgeMap.set(key, mapped);
      }
      mappedEdges[edge] = mapped;
    }

    const triangle = TRIANGLE_TABLE[caseIndex] ?? TRIANGLE_TABLE[0]!;
    faces.push(
      mappedEdges[triangle[0] ?? 0] ?? 0,
      mappedEdges[triangle[1] ?? 0] ?? 0,
      mappedEdges[triangle[2] ?? 0] ?? 0,
    );
    if (triangleCount === 2) {
      faces.push(
        mappedEdges[triangle[3] ?? 0] ?? 0,
        mappedEdges[triangle[4] ?? 0] ?? 0,
        mappedEdges[triangle[5] ?? 0] ?? 0,
      );
    }
  }

  return {
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(faces),
  };
}

function computeVertexNormals(
  positions: Float32Array,
  indices: Uint32Array,
): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let face = 0; face < indices.length; face += 3) {
    const a = (indices[face] ?? 0) * 3;
    const b = (indices[face + 1] ?? 0) * 3;
    const c = (indices[face + 2] ?? 0) * 3;
    const ax = positions[a] ?? 0;
    const ay = positions[a + 1] ?? 0;
    const az = positions[a + 2] ?? 0;
    const ux = (positions[b] ?? 0) - ax;
    const uy = (positions[b + 1] ?? 0) - ay;
    const uz = (positions[b + 2] ?? 0) - az;
    const vx = (positions[c] ?? 0) - ax;
    const vy = (positions[c + 1] ?? 0) - ay;
    const vz = (positions[c + 2] ?? 0) - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const index of [a, b, c]) {
      normals[index] = (normals[index] ?? 0) + nx;
      normals[index + 1] = (normals[index + 1] ?? 0) + ny;
      normals[index + 2] = (normals[index + 2] ?? 0) + nz;
    }
  }
  for (let index = 0; index < normals.length; index += 3) {
    const length =
      Math.hypot(
        normals[index] ?? 0,
        normals[index + 1] ?? 0,
        normals[index + 2] ?? 0,
      ) || 1;
    normals[index] = (normals[index] ?? 0) / length;
    normals[index + 1] = (normals[index + 1] ?? 0) / length;
    normals[index + 2] = (normals[index + 2] ?? 0) / length;
  }
  return normals;
}

function rotateToGltf(values: Float32Array): void {
  for (let index = 0; index < values.length; index += 3) {
    const x = values[index] ?? 0;
    const y = values[index + 1] ?? 0;
    const z = values[index + 2] ?? 0;
    values[index] = -y;
    values[index + 1] = z;
    values[index + 2] = -x;
  }
}

function flipWinding(indices: Uint32Array): void {
  for (let face = 0; face < indices.length; face += 3) {
    const second = indices[face + 1] ?? 0;
    indices[face + 1] = indices[face + 2] ?? 0;
    indices[face + 2] = second;
  }
}

function parseJson<T>(bytes: ArrayBuffer): T {
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export class BrowserSf3dPipeline {
  private tokenizer?: ort.InferenceSession;
  private backbone?: ort.InferenceSession;
  private decoder?: ort.InferenceSession;
  private tetrahedronVertices?: Float32Array;
  private tetrahedronIndices?: Int32Array;
  private colorHead?: ColorHeadWeights;
  private diagnostics?: BrowserSf3dDiagnostics;
  private prepared = false;

  get loaded(): boolean {
    return this.prepared;
  }

  get gpuDiagnostics(): BrowserSf3dDiagnostics | undefined {
    return this.diagnostics;
  }

  async load(progress?: BrowserProgress): Promise<void> {
    if (this.prepared) return;

    progress?.("webgpu", 0, "checking browser GPU");
    this.diagnostics = await requireWebGpu();
    progress?.("webgpu", 1, this.diagnostics.adapterInfo);

    progress?.("model:grid", 0, "loading tetrahedral grid");
    const vertexBytes = await fetchVerifiedBrowserSf3dAsset("tetsVertices", progress);
    const indexBytes = await fetchVerifiedBrowserSf3dAsset("tetsIndices", progress);
    const colorBytes = await fetchVerifiedBrowserSf3dAsset("featuresMlp", progress);
    this.tetrahedronVertices = new Float32Array(vertexBytes);
    this.tetrahedronIndices = new Int32Array(indexBytes);
    this.colorHead = parseColorHead(parseJson<ColorHeadJson>(colorBytes));

    progress?.("model:decoder", 0, "creating decoder session");
    this.decoder = await createSession(
      await fetchVerifiedBrowserSf3dAsset("decoder", progress),
    );

    progress?.("model:tokenizer", 0, "creating image-tokenizer session");
    this.tokenizer = await createSession(
      await fetchVerifiedBrowserSf3dAsset("imageTokenizer", progress),
    );

    progress?.("model:backbone", 0, "creating backbone session");
    this.backbone = await createSession(
      await fetchVerifiedBrowserSf3dAsset("backbone", progress),
    );

    this.prepared = true;
    progress?.("ready", 1, "model ready");
  }

  async generate(blob: Blob, progress?: BrowserProgress): Promise<{
    mesh: BrowserMeshData;
    observations: Record<string, unknown>;
  }> {
    if (
      !this.prepared ||
      !this.tokenizer ||
      !this.backbone ||
      !this.decoder ||
      !this.tetrahedronVertices ||
      !this.tetrahedronIndices ||
      !this.colorHead
    ) {
      throw new Error("Prepare the browser model before generation.");
    }

    progress?.("preprocess", 0, "preparing image locally");
    const prepared = await preprocessImage(blob);
    progress?.("preprocess", 1, prepared.matte);

    progress?.("tokenizer", 0, "encoding image");
    const tokenOutput = await this.tokenizer.run({
      rgb: f32Tensor(prepared.rgb, [1, 512, 512, 3]),
      c2w: f32Tensor(defaultCondC2W(), [1, 4, 4]),
      intrinsic_normed: f32Tensor(intrinsicNormed(), [1, 3, 3]),
    });
    const imageTokens = tokenOutput.image_tokens;
    if (!imageTokens) throw new Error("SF3D tokenizer did not emit image_tokens");
    progress?.("tokenizer", 1, "encoded");

    progress?.("backbone", 0, "building triplane");
    const backboneOutput = await this.backbone.run({ image_tokens: imageTokens });
    const triplaneTensor = backboneOutput.triplane;
    if (!triplaneTensor) throw new Error("SF3D backbone did not emit triplane");
    const triplaneData = outputFloat32(triplaneTensor);
    const triplane: Triplane = {
      data: triplaneData,
      planes: TRIPLANE_PLANES,
      channels: TRIPLANE_CHANNELS,
      size: TRIPLANE_SIZE,
    };
    progress?.("backbone", 1, "triplane ready");

    progress?.("geometry", 0, "decoding density field");
    const normalizedGrid = scalePositions(
      new Float32Array(this.tetrahedronVertices),
      0,
      1,
      -1,
      1,
    );
    const decoderOutput = await this.decoder.run({
      triplane: f32Tensor(triplaneData, [
        1,
        TRIPLANE_PLANES,
        TRIPLANE_CHANNELS,
        TRIPLANE_SIZE,
        TRIPLANE_SIZE,
      ]),
      positions: f32Tensor(normalizedGrid, [1, TET_VERTEX_COUNT, 3]),
    });
    const densityTensor = decoderOutput.density;
    const offsetTensor = decoderOutput.vertex_offset;
    if (!densityTensor || !offsetTensor) {
      throw new Error("SF3D decoder did not emit density and vertex_offset");
    }
    const density = outputFloat32(densityTensor);
    const offsets = outputFloat32(offsetTensor);
    const sdf = new Float32Array(TET_VERTEX_COUNT);
    const deformedGrid = new Float32Array(TET_VERTEX_COUNT * 3);
    let insideCount = 0;
    for (let index = 0; index < TET_VERTEX_COUNT; index += 1) {
      const value = (density[index] ?? 0) - ISO_THRESHOLD;
      sdf[index] = value;
      if (value > 0) insideCount += 1;
    }
    const deformationScale = 1 / ISO_RESOLUTION;
    for (let index = 0; index < deformedGrid.length; index += 1) {
      deformedGrid[index] =
        (this.tetrahedronVertices[index] ?? 0) +
        deformationScale * Math.tanh(offsets[index] ?? 0);
    }
    progress?.("geometry", 0.55, "extracting isosurface");
    const surface = marchingTetrahedra(
      deformedGrid,
      sdf,
      this.tetrahedronIndices,
    );
    if (surface.vertices.length === 0) {
      throw new Error(
        "SF3D produced an empty mesh. Use a clear single-object image with transparent or near-white background.",
      );
    }
    scalePositions(surface.vertices, 0, 1, -1, 1);

    progress?.("color", 0, "sampling vertex color");
    const vertexCount = surface.vertices.length / 3;
    const features = queryTriplane(triplane, surface.vertices, vertexCount);
    const colors = colorHeadForward(this.colorHead, features, vertexCount);

    rotateToGltf(surface.vertices);
    flipWinding(surface.indices);
    const normals = computeVertexNormals(surface.vertices, surface.indices);
    const mesh: BrowserMeshData = {
      positions: surface.vertices,
      normals,
      colors,
      indices: surface.indices,
      roughness: DEFAULT_ROUGHNESS,
      metallic: DEFAULT_METALLIC,
    };
    progress?.(
      "done",
      1,
      vertexCount + " vertices · " + Math.floor(surface.indices.length / 3) + " triangles",
    );
    return {
      mesh,
      observations: {
        modelRevision: BROWSER_SF3D_MODEL.revision,
        preprocessMode: prepared.matte,
        borderTransparentPixelCount: prepared.transparentPixelCount,
        insideGridVertexCount: insideCount,
        vertexCount,
        triangleCount: Math.floor(surface.indices.length / 3),
        executionProvider: "webgpu",
      },
    };
  }
}

export async function exportBrowserMeshGlb(meshData: BrowserMeshData): Promise<ArrayBuffer> {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(meshData.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(meshData.normals, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(meshData.colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
  geometry.computeBoundingSphere();
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: meshData.roughness,
    metalness: meshData.metallic,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(
      mesh,
      (result) => {
        if (result instanceof ArrayBuffer) resolve(result);
        else reject(new Error("GLTF exporter returned JSON instead of GLB bytes"));
      },
      reject,
      { binary: true },
    );
  });
}
