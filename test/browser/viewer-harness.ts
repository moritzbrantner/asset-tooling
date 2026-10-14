// Test harness for the rigged source animation viewer (#111) acceptance tests.
//
// Nothing here is production code. It serves local copies of the pinned
// catalog sources in place of raw.githubusercontent.com, blocks every other
// non-loopback request, and derives small test-only glTF fixtures from the
// CC0 SimpleSkin sample (two clips, no clips, malformed GLB).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, type Route } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..", "..");
export const evidenceDir = path.join(repoRoot, "test-results", "animation-viewer-evidence");

export function ensureEvidenceDir(): string {
  mkdirSync(evidenceDir, { recursive: true });
  return evidenceDir;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Catalog sources

export interface CatalogSourcePin {
  url: string;
  sha256: string;
  byteLength: number;
}

export interface CatalogAsset {
  id: string;
  title: string;
  kind: string;
  mediaType: string;
  tags: string[];
  license: { spdx: string; attribution?: string; evidenceUrl?: string };
  source: CatalogSourcePin & Record<string, unknown>;
  [key: string]: unknown;
}

interface SourceCatalog {
  sources: CatalogAsset[];
}

const sourceCatalog = JSON.parse(readFileSync(path.join(repoRoot, "catalog", "sources.json"), "utf8")) as SourceCatalog;

export function catalogAsset(id: string): CatalogAsset {
  const asset = sourceCatalog.sources.find((entry) => entry.id === id);
  if (!asset) throw new Error("catalog source missing: " + id);
  return asset;
}

export const RIGGED_ID = "khronos.riggedfigure-glb";
export const SIMPLE_ID = "khronos.simpleskin-embedded-gltf";
export const NON_ELIGIBLE_ID = "khronos.avocado-glb";
export const NON_ELIGIBLE_GLTF_ID = "khronos.triangle-embedded-gltf";
export const UNKNOWN_ID = "khronos.does-not-exist";

export const rigged = catalogAsset(RIGGED_ID);
export const simple = catalogAsset(SIMPLE_ID);

/** Clip durations of the pinned sources, measured from their animation input accessors. */
export const RIGGED_DURATION = 1.25;
export const SIMPLE_DURATION = 5.5;

export const riggedBytes = new Uint8Array(readFileSync(path.join(repoRoot, "test", "fixtures", "khronos", "RiggedFigure.glb")));
export const simpleBytes = new Uint8Array(readFileSync(path.join(repoRoot, "test", "fixtures", "khronos", "SimpleSkin.gltf")));

// ---------------------------------------------------------------------------
// Test-only fixture sources, injected into the runtime catalog.json.
//
// The viewer must resolve `asset` against the site's published catalog.json at
// runtime (the file the Pages build already emits at the site root), so these
// tests can add fixture entries by intercepting that one request. Their source
// URLs are routed to in-memory bytes; their pins are computed from those bytes,
// so the hash check passes and the failure under test is the one intended.

export const FIXTURE_HOST = "https://raw.githubusercontent.com/asset-tooling-test-fixtures/viewer/0000000000000000000000000000000000000000/";

export const TWO_CLIPS_ID = "test.simpleskin-two-clips-gltf";
export const NO_CLIPS_ID = "test.simpleskin-no-clips-gltf";
export const MALFORMED_ID = "test.malformed-glb";
export const SECOND_CLIP_NAME = "Bend";
export const SECOND_CLIP_DURATION = 2.2;
export const ODD_DURATION_ID = "test.simpleskin-odd-duration-gltf";
/** A clip duration that is not a whole number of milliseconds. */
export const ODD_DURATION = 1.2346;
/** The largest millisecond time not after ODD_DURATION: what clamping must show and seek. */
export const ODD_DURATION_CLAMPED = "1.234";

function float32DataUri(values: number[]): string {
  const buffer = Buffer.from(new Float32Array(values).buffer);
  return "data:application/octet-stream;base64," + buffer.toString("base64");
}

interface GltfJson {
  animations?: { name?: string; channels: unknown[]; samplers: { input: number; output: number; interpolation?: string }[] }[];
  accessors: Record<string, unknown>[];
  bufferViews: Record<string, unknown>[];
  buffers: { byteLength: number; uri?: string }[];
  [key: string]: unknown;
}

function simpleSkinJson(): GltfJson {
  return JSON.parse(Buffer.from(simpleBytes).toString("utf8")) as GltfJson;
}

/** SimpleSkin plus a second, named clip "Bend" that plays the same rotation track in 2.2 s. */
export function twoClipsGltf(): Uint8Array {
  const gltf = simpleSkinJson();
  const first = gltf.animations?.[0];
  const firstSampler = first?.samplers[0];
  if (!first || !firstSampler) throw new Error("SimpleSkin animation layout changed");
  const inputAccessor = gltf.accessors[firstSampler.input] as { count: number };
  // Original keyframes are 0, 0.5, ... 5.5 (12 keys). Scale them to 0 .. 2.2.
  const times = Array.from({ length: inputAccessor.count }, (_, index) => (index * SECOND_CLIP_DURATION) / (inputAccessor.count - 1));
  const bufferIndex = gltf.buffers.length;
  gltf.buffers.push({ byteLength: times.length * 4, uri: float32DataUri(times) });
  const viewIndex = gltf.bufferViews.length;
  gltf.bufferViews.push({ buffer: bufferIndex, byteLength: times.length * 4 });
  const accessorIndex = gltf.accessors.length;
  gltf.accessors.push({
    bufferView: viewIndex,
    componentType: 5126,
    count: times.length,
    type: "SCALAR",
    min: [0],
    max: [SECOND_CLIP_DURATION],
  });
  gltf.animations = [
    first,
    {
      name: SECOND_CLIP_NAME,
      channels: first.channels,
      samplers: [{ input: accessorIndex, interpolation: "LINEAR", output: firstSampler.output }],
    },
  ];
  return new Uint8Array(Buffer.from(JSON.stringify(gltf), "utf8"));
}

/** SimpleSkin with its skin intact but every animation removed. */
/** SimpleSkin whose only clip is rescaled to last 1.2346 s (not a whole millisecond). */
export function oddDurationGltf(): Uint8Array {
  const gltf = simpleSkinJson();
  const first = gltf.animations?.[0];
  const firstSampler = first?.samplers[0];
  if (!first || !firstSampler) throw new Error("SimpleSkin animation layout changed");
  const inputAccessor = gltf.accessors[firstSampler.input] as { count: number };
  const times = Array.from({ length: inputAccessor.count }, (_, index) => (index * ODD_DURATION) / (inputAccessor.count - 1));
  const bufferIndex = gltf.buffers.length;
  gltf.buffers.push({ byteLength: times.length * 4, uri: float32DataUri(times) });
  const viewIndex = gltf.bufferViews.length;
  gltf.bufferViews.push({ buffer: bufferIndex, byteLength: times.length * 4 });
  const accessorIndex = gltf.accessors.length;
  gltf.accessors.push({
    bufferView: viewIndex,
    componentType: 5126,
    count: times.length,
    type: "SCALAR",
    min: [0],
    max: [Math.fround(ODD_DURATION)],
  });
  gltf.animations = [{ ...first, samplers: [{ ...firstSampler, input: accessorIndex }] }];
  return new Uint8Array(Buffer.from(JSON.stringify(gltf), "utf8"));
}

export function noClipsGltf(): Uint8Array {
  const gltf = simpleSkinJson();
  delete gltf.animations;
  return new Uint8Array(Buffer.from(JSON.stringify(gltf), "utf8"));
}

/**
 * A GLB container whose header is valid but whose JSON chunk is truncated
 * garbage. The catalog pin is computed for exactly these bytes, so the hash and
 * length checks pass and only the renderer's parse can fail.
 */
export function malformedGlb(): Uint8Array {
  const json = Buffer.from('{"asset":{"version":"2.0"},"scenes":[{"nodes":[0', "utf8");
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const total = 12 + 8 + padded.length;
  const header = Buffer.alloc(20);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  header.writeUInt32LE(padded.length, 12);
  header.write("JSON", 16, "ascii");
  return new Uint8Array(Buffer.concat([header, padded]));
}

export interface FixtureSource {
  id: string;
  title: string;
  mediaType: string;
  file: string;
  bytes: Uint8Array;
}

export const fixtureSources: FixtureSource[] = [
  { id: TWO_CLIPS_ID, title: "Simple Skin (two clips, test fixture)", mediaType: "model/gltf+json", file: "SimpleSkinTwoClips.gltf", bytes: twoClipsGltf() },
  { id: NO_CLIPS_ID, title: "Simple Skin (no clips, test fixture)", mediaType: "model/gltf+json", file: "SimpleSkinNoClips.gltf", bytes: noClipsGltf() },
  { id: MALFORMED_ID, title: "Malformed GLB (test fixture)", mediaType: "model/gltf-binary", file: "Malformed.glb", bytes: malformedGlb() },
  { id: ODD_DURATION_ID, title: "Simple Skin (1.2346 s clip, test fixture)", mediaType: "model/gltf+json", file: "SimpleSkinOddDuration.gltf", bytes: oddDurationGltf() },
];

function fixtureCatalogEntry(fixture: FixtureSource, template: Record<string, unknown>): Record<string, unknown> {
  const templateSource = (template.source ?? {}) as Record<string, unknown>;
  return {
    ...template,
    id: fixture.id,
    title: fixture.title,
    kind: "mesh",
    mediaType: fixture.mediaType,
    tags: ["animation", "gltf", "skinning", "testing", "three-d"],
    license: { spdx: "CC0-1.0", evidenceUrl: simple.license.evidenceUrl },
    source: {
      ...templateSource,
      url: FIXTURE_HOST + fixture.file,
      upstreamId: "asset-tooling-test-fixture/" + fixture.file,
      path: fixture.file,
      sha256: sha256Hex(fixture.bytes),
      byteLength: fixture.bytes.byteLength,
    },
  };
}

// ---------------------------------------------------------------------------
// Network

export type SourceResponder = (route: Route, url: string) => Promise<void>;

export interface NetworkOptions {
  /** Add the test-only fixture sources to the runtime catalog.json. */
  injectFixtures?: boolean;
  /** Override how a specific catalog source URL is answered. */
  override?: Map<string, SourceResponder>;
}

export interface NetworkLog {
  /** Every source URL the page requested on the routed source host. */
  sourceRequests: string[];
  /** Every non-loopback request that was blocked (CDNs and anything else). */
  blocked: string[];
}

function contentTypeFor(url: string): string {
  return url.endsWith(".glb") ? "model/gltf-binary" : "model/gltf+json";
}

export async function fulfillBytes(route: Route, bytes: Uint8Array, url: string): Promise<void> {
  await route.fulfill({
    status: 200,
    body: Buffer.from(bytes),
    headers: {
      "content-type": contentTypeFor(url),
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}

export function localSourceBytes(url: string): Uint8Array | null {
  if (url === rigged.source.url) return riggedBytes;
  if (url === simple.source.url) return simpleBytes;
  const fixture = fixtureSources.find((entry) => FIXTURE_HOST + entry.file === url);
  return fixture ? fixture.bytes : null;
}

/**
 * Route the whole browser context: loopback is served by the Pages server,
 * pinned catalog sources come from test/fixtures/khronos, and everything else
 * (model-viewer CDN, any other CDN) is aborted and logged. No test touches the
 * real network.
 */
export async function installNetwork(page: Page, options: NetworkOptions = {}): Promise<NetworkLog> {
  const log: NetworkLog = { sourceRequests: [], blocked: [] };
  await page.context().route("**/*", async (route) => {
    const url = route.request().url();
    const parsed = new URL(url);
    if (parsed.protocol === "data:" || parsed.protocol === "blob:") return route.continue();
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      if (options.injectFixtures && parsed.pathname === "/catalog.json") {
        const response = await route.fetch();
        const model = (await response.json()) as { assets: Record<string, unknown>[] };
        const template = model.assets.find((asset) => asset.id === SIMPLE_ID);
        if (!template) throw new Error("built catalog.json lacks " + SIMPLE_ID);
        model.assets.push(...fixtureSources.map((fixture) => fixtureCatalogEntry(fixture, template)));
        return route.fulfill({ response, json: model });
      }
      return route.continue();
    }
    if (parsed.hostname === "raw.githubusercontent.com") {
      log.sourceRequests.push(url);
      const custom = options.override?.get(url);
      if (custom) return custom(route, url);
      const bytes = localSourceBytes(url);
      if (bytes) return fulfillBytes(route, bytes, url);
    }
    log.blocked.push(url);
    return route.abort("blockedbyclient");
  });
  return log;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Page errors

export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
  page.on("crash", () => errors.push("page crashed"));
  return errors;
}

// ---------------------------------------------------------------------------
// Viewer locators. These encode the doc's control contract: visible labels,
// native roles, one focusable labelled canvas.

export function viewerUrl(params: Record<string, string>): string {
  return "viewer/?" + new URLSearchParams(params).toString();
}

export class Viewer {
  constructor(readonly page: Page) {}

  get clip(): Locator {
    return this.page.getByRole("combobox", { name: /clip/i });
  }
  get playPause(): Locator {
    return this.page.getByRole("button", { name: /^(play|pause)$/i });
  }
  get time(): Locator {
    return this.page.getByRole("spinbutton", { name: /time/i });
  }
  get slider(): Locator {
    return this.page.getByRole("slider", { name: /time/i });
  }
  get restPose(): Locator {
    return this.page
      .getByRole("checkbox", { name: /rest pose/i })
      .or(this.page.getByRole("switch", { name: /rest pose/i }))
      .or(this.page.getByRole("button", { name: /rest pose/i }));
  }
  preset(name: "Front" | "Side" | "Back" | "Gameplay"): Locator {
    return this.page.getByRole("button", { name, exact: true });
  }
  get canvas(): Locator {
    return this.page.locator("canvas");
  }
  get alert(): Locator {
    return this.page.getByRole("alert");
  }
  get retry(): Locator {
    return this.page.getByRole("button", { name: /^retry$/i });
  }

  async open(params: Record<string, string>): Promise<void> {
    await this.page.goto(viewerUrl(params));
  }

  /** The model is rendered: one visible canvas, a selectable clip, no alert. */
  async expectReady(): Promise<void> {
    await expect(this.alert).toHaveCount(0);
    await expect(this.canvas).toHaveCount(1);
    await expect(this.canvas).toBeVisible();
    await expect(this.clip).toBeEnabled();
    await expect.poll(async () => this.clip.locator("option").count()).toBeGreaterThan(0);
    await expect(this.time).toBeEnabled();
    await this.settle();
  }

  /** A failure: role=alert visible and no model canvas visible. */
  async expectFailure(message?: RegExp): Promise<void> {
    await expect(this.alert.first()).toBeVisible();
    if (message) await expect(this.alert.first()).toContainText(message);
    await expect(this.page.locator("canvas:visible")).toHaveCount(0);
  }

  async isPlaying(): Promise<boolean> {
    const name = ((await this.playPause.textContent()) ?? "").trim();
    const label = (await this.playPause.getAttribute("aria-label")) ?? name;
    const pressed = await this.playPause.getAttribute("aria-pressed");
    if (pressed === "true") return true;
    if (pressed === "false") return false;
    return /pause/i.test(label);
  }

  async pause(): Promise<void> {
    if (await this.isPlaying()) await this.playPause.click();
    await expect.poll(() => this.isPlaying()).toBe(false);
  }

  async play(): Promise<void> {
    if (!(await this.isPlaying())) await this.playPause.click();
    await expect.poll(() => this.isPlaying()).toBe(true);
  }

  async timeValue(): Promise<number> {
    return Number(await this.time.inputValue());
  }

  /** Enter a time in the numeric input and commit it with Enter. */
  async seek(seconds: string): Promise<void> {
    await this.time.fill(seconds);
    await this.time.press("Enter");
    await this.settle();
  }

  /** Wait for two animation frames so the renderer has presented the latest state. */
  async settle(): Promise<void> {
    await this.page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
  }

  /** Screenshot of the canvas only, after the frame settled. */
  async shot(): Promise<Buffer> {
    await this.settle();
    return this.canvas.screenshot({ animations: "disabled", caret: "hide" });
  }

  async params(): Promise<URLSearchParams> {
    return new URL(this.page.url()).searchParams;
  }
}

export function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.equals(b);
}

/** Press Tab until the target has focus (keyboard-only navigation). */
export async function tabTo(page: Page, target: Locator, maxTabs = 60): Promise<void> {
  for (let index = 0; index < maxTabs; index += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("could not reach the target with Tab within " + maxTabs + " presses");
}

/** Visible focus: the focused element shows an outline or box-shadow focus ring. */
export async function hasVisibleFocusIndicator(target: Locator): Promise<boolean> {
  return target.evaluate((element) => {
    const style = getComputedStyle(element);
    const outline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
    const ring = style.boxShadow !== "none" && style.boxShadow !== "";
    return element.matches(":focus-visible") && (outline || ring);
  });
}
