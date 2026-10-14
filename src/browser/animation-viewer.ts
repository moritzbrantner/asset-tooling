// Browser client of the rigged source animation viewer (#111), bundled into
// dist/pages/viewer/app.js by scripts/build-catalog-pages.ts.
//
// Presentation and evidence only: the shared 3d-lab renderer verifies the
// catalog pin, parses, skins and samples clips. This file decides eligibility
// from the runtime catalog.json, drives the controls, and maps renderer
// failures to user-facing alerts. Contract: docs/animation-viewer.md.
import { createThreeSceneRenderer, type RendererCamera, type ThreeSceneRenderer } from "@moritzbrantner/three-d-renderer";
import {
  adaptPinnedCharacterSource,
  renderImportedCharacterInstances,
  type InspectionCharacterAsset,
  type InspectionCharacterClip,
  type InspectionCharacterInstance,
} from "@moritzbrantner/three-d-renderer/inspection-character";
import { Box3, PerspectiveCamera, Vector3, WebGPUCoordinateSystem, type Object3D, type SkinnedMesh } from "three";
import { animationViewerIneligibility } from "../animation-viewer-eligibility.ts";

// ---------------------------------------------------------------------------
// Catalog

interface CatalogEntry {
  id: string;
  title: string;
  kind: string;
  mediaType: string;
  tags: string[];
  provider?: { label?: string | null } | null;
  license?: { spdx?: string | null; attribution?: string | null; evidenceUrl?: string | null } | null;
  source: { url: string; sha256: string; byteLength: number; revision?: string | null; path?: string | null };
}

// ---------------------------------------------------------------------------
// Failures

type FailureKind = "missing" | "unknown" | "ineligible" | "catalog" | "http" | "network" | "length" | "hash" | "parse" | "no-clips";

class ViewerFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly heading: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** Map the renderer's admission errors (inspection-character.js) to viewer failures. */
function rendererFailure(error: unknown, entry: CatalogEntry, fetched: number): ViewerFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (/byte length .* does not match/i.test(message)) {
    return new ViewerFailure(
      "length",
      "Byte-length mismatch",
      `The fetched source is ${fetched} bytes but the catalog pins ${entry.source.byteLength} bytes. It was not rendered.`,
    );
  }
  if (/SHA-256 does not match/i.test(message)) {
    return new ViewerFailure(
      "hash",
      "SHA-256 mismatch",
      `The fetched bytes do not match the catalog's pinned SHA-256 ${entry.source.sha256.slice(0, 12)}…. They were not rendered.`,
    );
  }
  if (/no animation clips/i.test(message)) {
    return new ViewerFailure(
      "no-clips",
      "Unsupported for this viewer",
      "The source has no animation clips, so there is nothing for this viewer to inspect.",
    );
  }
  if (/clip names must be present and unique/i.test(message)) {
    // The renderer's Rust bridge rejects an empty clip set with this message
    // before its own "no animation clips" check runs; it also covers duplicate names.
    return new ViewerFailure(
      "no-clips",
      "Unsupported for this viewer",
      "The renderer found no usable animation clips in this source (it has no clips, or their names are not unique), so there is nothing for this viewer to inspect.",
    );
  }
  const reason = message.replace(/^inspection character:\s*/i, "");
  return new ViewerFailure("parse", "The renderer could not read this source", `The bytes match their catalog pin, but parsing failed: ${reason}`);
}

// ---------------------------------------------------------------------------
// Small helpers

const VIEWS = {
  front: { yaw: 0, pitch: 0.06, distance: 1 },
  side: { yaw: Math.PI / 2, pitch: 0.06, distance: 1 },
  back: { yaw: Math.PI, pitch: 0.06, distance: 1 },
  gameplay: { yaw: Math.PI / 5, pitch: 0.55, distance: 2.4 },
} as const;
type ViewName = keyof typeof VIEWS;
const isView = (value: string | null): value is ViewName => value !== null && Object.hasOwn(VIEWS, value);

/** Largest millisecond-precision time not after `duration`, so a clamped value is always renderable. */
function clampTime(seconds: number, duration: number): number {
  const ceiling = Math.floor(duration * 1000) / 1000;
  return Math.max(0, Math.min(roundTime(Number.isFinite(seconds) ? seconds : 0), ceiling));
}
/** Times are shown and kept at millisecond precision; the renderer is seeked to exactly the shown value. */
function roundTime(seconds: number): number {
  const rounded = Math.round(seconds * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}
const formatTime = (seconds: number): string => String(roundTime(seconds));
const clipLabel = (clip: InspectionCharacterClip): string =>
  `${clip.name ?? `Clip ${clip.index}`} · ${formatTime(clip.duration)} s`;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`viewer shell lacks #${id}`);
  return found as T;
}

// ---------------------------------------------------------------------------
// DOM

const dom = {
  title: element<HTMLHeadingElement>("viewer-title"),
  assetId: element<HTMLParagraphElement>("viewer-asset-id"),
  status: element<HTMLParagraphElement>("status"),
  failure: element<HTMLDivElement>("failure"),
  workspace: element<HTMLDivElement>("workspace"),
  canvas: element<HTMLCanvasElement>("viewer-canvas"),
  clip: element<HTMLSelectElement>("clip"),
  play: element<HTMLButtonElement>("play"),
  rest: element<HTMLInputElement>("rest"),
  time: element<HTMLInputElement>("time"),
  scrub: element<HTMLInputElement>("scrub"),
  identity: element<HTMLDListElement>("identity"),
  provenance: element<HTMLDivElement>("provenance-body"),
  presets: [...document.querySelectorAll<HTMLButtonElement>("button[data-view]")],
};

// ---------------------------------------------------------------------------
// State

interface Loaded {
  entry: CatalogEntry;
  asset: InspectionCharacterAsset;
  instance: InspectionCharacterInstance;
  rest: InspectionCharacterInstance | null;
  center: Vector3;
  radius: number;
  /** Rest-pose bounds of the renderer's root object in metres (W, H, D). */
  bounds: [number, number, number];
}

const state = {
  generation: 0,
  abort: null as AbortController | null,
  loaded: null as Loaded | null,
  renderer: null as ThreeSceneRenderer | null,
  clip: 0,
  time: 0,
  playing: false,
  restPose: false,
  view: "front" as ViewName,
  yaw: 0,
  pitch: 0,
  zoom: 1,
  dirty: false,
  lastFrame: null as number | null,
};

function currentClip(): InspectionCharacterClip | null {
  return state.loaded?.asset.clips[state.clip] ?? null;
}
function clipDuration(): number {
  return currentClip()?.duration ?? 0;
}

// ---------------------------------------------------------------------------
// Rendering

const camera = new PerspectiveCamera(35, 4 / 3, 0.01, 100);
camera.coordinateSystem = WebGPUCoordinateSystem;

function frameCamera(loaded: Loaded): RendererCamera {
  const width = Math.max(1, dom.canvas.clientWidth);
  const height = Math.max(1, dom.canvas.clientHeight);
  const preset = VIEWS[state.view];
  const yaw = preset.yaw + state.yaw;
  const pitch = Math.max(-1.45, Math.min(1.45, preset.pitch + state.pitch));
  camera.aspect = width / height;
  const vertical = (camera.fov * Math.PI) / 180;
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
  // Fit the bounding sphere in the narrower field of view, then apply the preset and zoom.
  const fit = (loaded.radius / Math.sin(Math.min(vertical, horizontal) / 2)) * 1.02;
  const distance = fit * preset.distance * state.zoom;
  camera.near = Math.max(distance - loaded.radius * 4, distance * 0.01);
  camera.far = distance + loaded.radius * 4;
  camera.position.set(
    loaded.center.x + distance * Math.sin(yaw) * Math.cos(pitch),
    loaded.center.y + distance * Math.sin(pitch),
    loaded.center.z + distance * Math.cos(yaw) * Math.cos(pitch),
  );
  camera.lookAt(loaded.center);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return {
    viewMatrix: [...camera.matrixWorldInverse.elements] as RendererCamera["viewMatrix"],
    projectionMatrix: [...camera.projectionMatrix.elements] as RendererCamera["projectionMatrix"],
  };
}

function renderNow(): void {
  const { loaded, renderer } = state;
  if (!loaded || !renderer) return;
  const width = dom.canvas.clientWidth;
  const height = dom.canvas.clientHeight;
  if (width <= 0 || height <= 0) return;
  renderer.setSize(width, height, window.devicePixelRatio || 1);
  const shown = state.restPose ? (loaded.rest ??= loaded.asset.createInstance()) : loaded.instance;
  renderImportedCharacterInstances(renderer, { camera: frameCamera(loaded), instances: [shown] });
}

function tick(timestamp: number): void {
  const delta = state.lastFrame === null ? 0 : Math.min(0.1, Math.max(0, (timestamp - state.lastFrame) / 1000));
  state.lastFrame = timestamp;
  const loaded = state.loaded;
  if (loaded && state.playing) {
    const duration = clipDuration();
    state.time = duration > 0 ? (state.time + delta) % duration : 0;
    loaded.instance.seek(state.clip, state.time);
    showTime(true);
    state.dirty = true;
  }
  if (state.dirty) {
    state.dirty = false;
    try {
      renderNow();
    } catch (error) {
      // A renderer failure must never leave a "loaded" viewer showing a stale or blank canvas.
      state.generation += 1;
      setPlaying(false);
      release();
      showFailure(new ViewerFailure("parse", "The renderer could not draw this source",
        error instanceof Error ? error.message : String(error), true));
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

new ResizeObserver(() => {
  state.dirty = true;
}).observe(dom.canvas);

// ---------------------------------------------------------------------------
// Controls

function showTime(playing = false): void {
  const text = formatTime(state.time);
  // Do not overwrite a value the user is typing while the clip plays.
  if (!(playing && document.activeElement === dom.time)) dom.time.value = text;
  dom.scrub.value = text;
}

function syncUrl(): void {
  const params = new URLSearchParams();
  const loaded = state.loaded;
  params.set("asset", loaded?.entry.id ?? new URLSearchParams(location.search).get("asset") ?? "");
  params.set("clip", String(state.clip));
  if (!state.playing) params.set("t", formatTime(state.time));
  params.set("view", state.view);
  const next = `${location.pathname}?${params.toString()}${location.hash}`;
  if (next !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(history.state, "", next);
}

function syncPlayButton(): void {
  dom.play.textContent = state.playing ? "Pause" : "Play";
}

function setRestPose(on: boolean): void {
  if (state.restPose === on) return;
  state.restPose = on;
  dom.rest.checked = on;
  if (on) setPlaying(false);
  state.dirty = true;
}

function setPlaying(playing: boolean): void {
  if (!state.loaded || state.playing === playing) return;
  if (playing) {
    setRestPose(false);
    state.lastFrame = null;
  } else {
    // Pause on a millisecond-exact frame so the shown time, URL and pose agree.
    state.time = clampTime(state.time, clipDuration());
    state.loaded.instance.seek(state.clip, state.time);
    showTime();
    state.dirty = true;
  }
  state.playing = playing;
  syncPlayButton();
  syncUrl();
}

/** Show exactly `seconds`, clamped to the clip, paused. */
function seekTo(seconds: number): void {
  const loaded = state.loaded;
  if (!loaded) return;
  setPlaying(false);
  setRestPose(false);
  const duration = clipDuration();
  state.time = clampTime(seconds, duration);
  loaded.instance.seek(state.clip, state.time);
  showTime();
  syncUrl();
  state.dirty = true;
}

function selectClip(index: number): void {
  const loaded = state.loaded;
  if (!loaded || !loaded.asset.clips[index]) return;
  state.clip = index;
  dom.clip.selectedIndex = index;
  const duration = clipDuration();
  dom.scrub.max = formatTime(duration);
  dom.time.max = formatTime(duration);
  state.time = clampTime(state.time, duration);
  if (!state.playing) setRestPose(false);
  loaded.instance.seek(state.clip, state.time);
  showTime();
  renderIdentity(loaded);
  syncUrl();
  state.dirty = true;
}

function selectView(view: ViewName): void {
  state.view = view;
  state.yaw = 0;
  state.pitch = 0;
  state.zoom = 1;
  for (const button of dom.presets) button.setAttribute("aria-pressed", String(button.dataset.view === view));
  syncUrl();
  state.dirty = true;
}

function orbit(yaw: number, pitch: number): void {
  state.yaw += yaw;
  state.pitch = Math.max(-1.5, Math.min(1.5, state.pitch + pitch));
  state.dirty = true;
}

function zoomBy(factor: number): void {
  state.zoom = Math.max(0.2, Math.min(8, state.zoom * factor));
  state.dirty = true;
}

dom.clip.addEventListener("change", () => selectClip(dom.clip.selectedIndex));
dom.play.addEventListener("click", () => setPlaying(!state.playing));
dom.rest.addEventListener("change", () => setRestPose(dom.rest.checked));
dom.time.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    seekTo(Number(dom.time.value));
  }
});
dom.time.addEventListener("change", () => {
  if (dom.time.value.trim() === "") showTime();
  else seekTo(Number(dom.time.value));
});
dom.scrub.addEventListener("input", () => seekTo(Number(dom.scrub.value)));
dom.scrub.addEventListener("keydown", (event) => {
  // The slider keeps millisecond precision; keyboard steps move 1% (Page keys 10%) of the clip.
  const duration = clipDuration();
  const step = { ArrowRight: 0.01, ArrowUp: 0.01, ArrowLeft: -0.01, ArrowDown: -0.01, PageUp: 0.1, PageDown: -0.1 }[event.key];
  if (step === undefined || duration <= 0) return;
  event.preventDefault();
  seekTo(state.time + step * duration);
});
for (const button of dom.presets) {
  button.addEventListener("click", () => {
    const view = button.dataset.view ?? null;
    if (isView(view)) selectView(view);
  });
}

dom.canvas.addEventListener("keydown", (event) => {
  const step = Math.PI / 18;
  const actions: Record<string, () => void> = {
    ArrowLeft: () => orbit(-step, 0),
    ArrowRight: () => orbit(step, 0),
    ArrowUp: () => orbit(0, step),
    ArrowDown: () => orbit(0, -step),
    "+": () => zoomBy(1 / 1.2),
    "=": () => zoomBy(1 / 1.2),
    "-": () => zoomBy(1.2),
    _: () => zoomBy(1.2),
  };
  const action = actions[event.key];
  if (!action) return;
  event.preventDefault();
  action();
});
let drag: { x: number; y: number; id: number } | null = null;
dom.canvas.addEventListener("pointerdown", (event) => {
  drag = { x: event.clientX, y: event.clientY, id: event.pointerId };
  dom.canvas.setPointerCapture(event.pointerId);
});
dom.canvas.addEventListener("pointermove", (event) => {
  if (!drag || drag.id !== event.pointerId) return;
  orbit(-(event.clientX - drag.x) * 0.01, (event.clientY - drag.y) * 0.01);
  drag = { x: event.clientX, y: event.clientY, id: event.pointerId };
});
const endDrag = (event: PointerEvent) => {
  if (drag?.id === event.pointerId) drag = null;
};
dom.canvas.addEventListener("pointerup", endDrag);
dom.canvas.addEventListener("pointercancel", endDrag);
dom.canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    zoomBy(Math.exp(event.deltaY * 0.001));
  },
  { passive: false },
);

function setControlsEnabled(enabled: boolean): void {
  for (const control of [dom.clip, dom.play, dom.rest, dom.time, dom.scrub, ...dom.presets]) control.disabled = !enabled;
}

// ---------------------------------------------------------------------------
// Identity and provenance

function row(name: string, value: string, code = false): string {
  const escaped = value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  return `<dt>${name}</dt><dd>${code ? `<code>${escaped}</code>` : escaped}</dd>`;
}

function renderIdentity(loaded: Loaded): void {
  const { entry } = loaded;
  const clip = currentClip();
  const size = loaded.bounds;
  dom.identity.innerHTML = [
    row("Catalog id", entry.id, true),
    row("Title", entry.title),
    row("Displayed", "Original source"),
    row("SHA-256", `${entry.source.sha256.slice(0, 12)}…`, true),
    row("License", entry.license?.spdx ?? "unknown", true),
    entry.license?.attribution ? row("Attribution", entry.license.attribution) : "",
    clip ? row("Clip", clip.name ?? `Clip ${clip.index} (unnamed)`) : "",
    clip ? row("Duration", `${formatTime(clip.duration)} s`) : "",
    row("Bounds", `${size.map((value) => value.toFixed(2)).join(" × ")} m (W × H × D)`),
  ].join("");
}

function renderProvenance(entry: CatalogEntry): void {
  const link = document.createElement("p");
  const anchor = document.createElement("a");
  anchor.href = entry.source.url;
  anchor.rel = "noreferrer";
  anchor.textContent = entry.source.url;
  link.append("Source URL: ", anchor);
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(entry, null, 2);
  dom.provenance.replaceChildren(link, pre);
}

// ---------------------------------------------------------------------------
// Loading

function showFailure(failure: ViewerFailure): void {
  dom.workspace.hidden = true;
  dom.status.hidden = true;
  setControlsEnabled(false);
  const box = document.createElement("div");
  box.setAttribute("role", "alert");
  const heading = document.createElement("strong");
  heading.textContent = failure.heading;
  const message = document.createElement("p");
  message.textContent = failure.message;
  box.append(heading, message);
  dom.failure.replaceChildren(box);
  if (failure.retryable) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => void start());
    dom.failure.append(retry);
  }
  dom.failure.hidden = false;
}

function release(): void {
  state.abort?.abort();
  state.abort = null;
  const loaded = state.loaded;
  state.loaded = null;
  if (loaded) {
    loaded.rest?.dispose();
    loaded.instance.dispose();
    loaded.asset.dispose();
  }
}

async function fetchCatalogEntry(id: string, signal: AbortSignal): Promise<CatalogEntry> {
  let response: Response;
  try {
    response = await fetch(new URL("../catalog.json", location.href), { signal, cache: "no-cache" });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ViewerFailure("catalog", "The catalog could not be loaded", "The network request for catalog.json failed.", true);
  }
  if (!response.ok) {
    throw new ViewerFailure("catalog", "The catalog could not be loaded", `catalog.json answered HTTP ${response.status}.`, true);
  }
  const catalog = (await response.json()) as { assets?: unknown };
  const assets = Array.isArray(catalog.assets) ? (catalog.assets as Record<string, unknown>[]) : [];
  const entry = assets.find((asset) => asset?.id === id);
  if (!entry) throw new ViewerFailure("unknown", "Unknown asset", `The catalog has no source with id “${id}”.`);
  const reason = animationViewerIneligibility(entry);
  if (reason !== null) {
    throw new ViewerFailure("ineligible", "Not inspectable in this viewer", `“${id}” cannot be inspected here because ${reason}.`);
  }
  return entry as unknown as CatalogEntry;
}

async function fetchSource(entry: CatalogEntry, signal: AbortSignal): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(entry.source.url, { signal, mode: "cors", credentials: "omit" });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ViewerFailure("network", "Network failure", `The source could not be downloaded from ${entry.source.url}.`, true);
  }
  if (!response.ok) {
    throw new ViewerFailure(
      "http",
      `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
      `The source host answered HTTP ${response.status} for ${entry.source.url}.`,
      true,
    );
  }
  try {
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ViewerFailure("network", "Network failure", "The source download was interrupted.", true);
  }
}

function measure(root: Object3D): { center: Vector3; radius: number; size: [number, number, number] } {
  root.updateMatrixWorld(true);
  root.traverse((node) => {
    const skinned = node as SkinnedMesh;
    if (skinned.isSkinnedMesh) {
      skinned.skeleton.update();
    }
  });
  const box = new Box3().setFromObject(root);
  const center = box.getCenter(new Vector3());
  const extent = box.getSize(new Vector3());
  const radius = Math.max(extent.length() / 2, 1e-3);
  return { center, radius, size: [extent.x, extent.y, extent.z] };
}

async function start(): Promise<void> {
  release();
  const generation = ++state.generation;
  const abort = new AbortController();
  state.abort = abort;
  const current = () => generation === state.generation && !abort.signal.aborted;

  dom.failure.hidden = true;
  dom.failure.replaceChildren();
  dom.status.hidden = false;
  dom.status.textContent = "Loading…";
  setControlsEnabled(false);

  const params = new URLSearchParams(location.search);
  const id = params.get("asset");
  try {
    if (!id) throw new ViewerFailure("missing", "No asset selected", "Open this viewer from an asset page, or add ?asset=<catalog source id> to the URL.");
    dom.assetId.textContent = id;
    const entry = await fetchCatalogEntry(id, abort.signal);
    if (!current()) return;
    dom.title.textContent = entry.title;
    document.title = `${entry.title} · Animation viewer · asset-tooling`;
    dom.status.textContent = `Loading ${entry.source.url}…`;
    const bytes = await fetchSource(entry, abort.signal);
    if (!current()) return;

    let asset: InspectionCharacterAsset;
    try {
      // The renderer verifies SHA-256 and byte length before it parses anything.
      asset = await adaptPinnedCharacterSource(bytes, { sha256: entry.source.sha256, byteLength: entry.source.byteLength });
    } catch (error) {
      throw rendererFailure(error, entry, bytes.byteLength);
    }
    if (!current()) {
      asset.dispose();
      return;
    }
    if (asset.clips.length === 0) {
      asset.dispose();
      throw rendererFailure(new Error("no animation clips"), entry, bytes.byteLength);
    }
    const instance = asset.createInstance();
    const metrics = measure(instance.root);
    const loaded: Loaded = { entry, asset, instance, rest: null, center: metrics.center, radius: metrics.radius, bounds: metrics.size };
    state.loaded = loaded;

    // Restore clip, view and paused time from the URL.
    const clipParam = Number(params.get("clip"));
    state.clip = Number.isInteger(clipParam) && clipParam >= 0 && clipParam < asset.clips.length ? clipParam : 0;
    const view = params.get("view")?.toLowerCase() ?? null;
    state.playing = false;
    state.restPose = false;
    dom.rest.checked = false;
    dom.clip.replaceChildren(
      ...asset.clips.map((clip) => {
        const option = document.createElement("option");
        option.value = String(clip.index);
        option.textContent = clipLabel(clip);
        return option;
      }),
    );
    renderProvenance(entry);
    state.time = 0;
    selectView(isView(view) ? view : "front");
    selectClip(state.clip);
    const t = Number(params.get("t") ?? "0");
    seekTo(Number.isFinite(t) ? t : 0);
    syncPlayButton();

    state.renderer ??= createThreeSceneRenderer(dom.canvas, { alpha: true, antialias: true });
    dom.status.hidden = true;
    dom.workspace.hidden = false;
    setControlsEnabled(true);
    state.dirty = true;
  } catch (error) {
    if (!current()) return;
    if (error instanceof ViewerFailure) showFailure(error);
    else showFailure(new ViewerFailure("parse", "The viewer failed", error instanceof Error ? error.message : String(error), true));
  }
}

// Always release on pagehide, including back-forward cache entries; a restored page rebuilds.
window.addEventListener("pagehide", () => {
  state.generation += 1;
  release();
  state.renderer?.dispose();
  state.renderer = null;
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});

void start();
