// Web Worker of the texture workbench (#127): runs the staged surface recipe off the main thread and returns each
// channel's pixels plus the SHA-256 of its canonical RGBA8 document, the same identity the CLI build's AssetRef carries.
import "./node-buffer-shim.js";
import { encodeRgba8Image } from "../image-rgba8.js";
import { TextureWorkbenchSession, TEXTURE_CHANNELS, type StageStatus, type TextureChannel } from "./texture-workbench-compute.js";
import { workbenchRecipe } from "./texture-workbench-state.js";

export type WorkbenchJob = { id: number; recipe: unknown };
export type WorkbenchChannelResult = { width: number; height: number; pixels: Uint8ClampedArray; sha256: string; byteLength: number };
export type WorkbenchResult =
  | { id: number; ok: true; channels: Record<TextureChannel, WorkbenchChannelResult>; stages: StageStatus[]; milliseconds: number }
  | { id: number; ok: false; error: string };

const session = new TextureWorkbenchSession();
const hashes = new WeakMap<object, { sha256: string; byteLength: number }>();

async function identity(image: { width: number; height: number; pixels: Uint8Array }) {
  const known = hashes.get(image);
  if (known) return known;
  const bytes = encodeRgba8Image(image);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const result = { sha256: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""), byteLength: bytes.byteLength };
  hashes.set(image, result);
  return result;
}

self.onmessage = async (event: MessageEvent<WorkbenchJob>) => {
  const { id } = event.data;
  try {
    const started = performance.now();
    const { images, stages } = session.run(workbenchRecipe(event.data.recipe));
    const channels = {} as Record<TextureChannel, WorkbenchChannelResult>;
    for (const channel of TEXTURE_CHANNELS) {
      const image = images[channel];
      // A copy: the session keeps its own pixels for the next run's reuse.
      channels[channel] = { width: image.width, height: image.height, pixels: new Uint8ClampedArray(image.pixels), ...(await identity(image)) };
    }
    const result: WorkbenchResult = { id, ok: true, channels, stages, milliseconds: Math.round(performance.now() - started) };
    (self as unknown as Worker).postMessage(result, TEXTURE_CHANNELS.map((channel) => channels[channel].pixels.buffer));
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies WorkbenchResult);
  }
};
