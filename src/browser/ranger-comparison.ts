// Browser client of the Ranger source-versus-processed comparison (#111, owner answers Q1 = A and
// Q2 = A, 2026-10-17), bundled into dist/pages/compare/ranger/app.js by scripts/build-catalog-pages.ts.
//
// Four synchronized panels share one clip, time and camera:
//   1. the original Ranger source (UBC body + Male_Ranger outfit) in rest pose: the source ships no clips;
//   2. the source motion: the clip library's own mannequin playing the selected clip;
//   3. the processed humanoid-ranger-male bundle playing the same clip, composed from the bundle's appearance
//      (outfit, skin, hood, hair, tint, faction colour, level of detail) and exportable as one GLB (#127);
//   4. the primitive-built archer (a static debug fallback).
// Presentation only, in plain three.js (Atlas Decision 7.1.1, #281): GLTFLoader loads every character and
// AnimationMixer plays the clips. Files are not rehashed in the browser (Decision 7.1.2); the build copies the
// pinned sources, and a working processed bundle only needs its declared resources.
// Contract: docs/animation-viewer.md#ranger-comparison.
import { AxesHelper, Group, LoadingManager, Mesh, MeshStandardMaterial, PerspectiveCamera, Quaternion, Scene, SkeletonHelper, Vector3, WebGLRenderer, type Material, type Object3D } from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { characterAsset, viewerScene, type CharacterAsset, type CharacterInstance } from "./three-character.ts";
import {
  composeHumanoid, defaultSelection, hairColors, type HumanoidAppearance, type HumanoidSelection, type HumanoidSockets,
} from "./humanoid-composer.ts";
import type { PinnedFile, PinnedGltf, RangerComparisonData } from "../ranger-comparison.ts";

type PanelId = "source" | "motion" | "processed" | "archer";

const VIEWS = {
  front: { yaw: 0, pitch: 0.06, distance: 1 },
  side: { yaw: Math.PI / 2, pitch: 0.06, distance: 1 },
  back: { yaw: Math.PI, pitch: 0.06, distance: 1 },
  gameplay: { yaw: Math.PI / 5, pitch: 0.55, distance: 2.4 },
} as const;
type ViewName = keyof typeof VIEWS;
const isView = (value: string | null): value is ViewName => value !== null && Object.hasOwn(VIEWS, value);
/** Every panel frames the same human-sized volume, so camera and scale match exactly. */
const FRAME = { center: new Vector3(0, 0.9, 0), radius: 1.05 };

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`comparison shell lacks #${id}`);
  return found as T;
}
const dom = {
  status: element<HTMLParagraphElement>("status"),
  failure: element<HTMLDivElement>("failure"),
  workspace: element<HTMLDivElement>("workspace"),
  clip: element<HTMLSelectElement>("clip"),
  play: element<HTMLButtonElement>("play"),
  rest: element<HTMLInputElement>("rest"),
  time: element<HTMLInputElement>("time"),
  scrub: element<HTMLInputElement>("scrub"),
  body: element<HTMLInputElement>("show-body"),
  outfit: element<HTMLInputElement>("show-outfit"),
  wireframe: element<HTMLInputElement>("wireframe"),
  skeleton: element<HTMLInputElement>("skeleton"),
  sockets: element<HTMLInputElement>("sockets"),
  compose: element<HTMLFieldSetElement>("compose"),
  outfitSelect: element<HTMLSelectElement>("outfit"),
  skin: element<HTMLSelectElement>("skin"),
  hood: element<HTMLInputElement>("hood"),
  hair: element<HTMLSelectElement>("hair"),
  hairColor: element<HTMLSelectElement>("hair-color"),
  faction: element<HTMLInputElement>("faction"),
  lod: element<HTMLSelectElement>("lod"),
  composeError: element<HTMLParagraphElement>("compose-error"),
  exportGlb: element<HTMLButtonElement>("export"),
  resetLook: element<HTMLButtonElement>("reset-look"),
  presets: [...document.querySelectorAll<HTMLButtonElement>("button[data-view]")],
  canvases: Object.fromEntries((["source", "motion", "processed", "archer"] as const).map((id) => [id, element<HTMLCanvasElement>(`canvas-${id}`)])) as Record<PanelId, HTMLCanvasElement>,
  captions: Object.fromEntries((["source", "motion", "processed", "archer"] as const).map((id) => [id, element<HTMLElement>(`caption-${id}`)])) as Record<PanelId, HTMLElement>,
};

const roundTime = (seconds: number) => { const rounded = Math.round(seconds * 1000) / 1000; return Object.is(rounded, -0) ? 0 : rounded; };
const formatTime = (seconds: number) => String(roundTime(seconds));
const clampTime = (seconds: number, duration: number) => Math.max(0, Math.min(roundTime(Number.isFinite(seconds) ? seconds : 0), Math.floor(duration * 1000) / 1000));
const short = (sha256: string) => `${sha256.slice(0, 12)}…`;

async function fetchBytes(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(new URL(url, location.href), { signal });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Loads a source glTF whose buffers and images were copied under content-addressed names. */
async function loadSourceGltf(gltf: PinnedGltf, signal: AbortSignal): Promise<CharacterAsset> {
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    const name = decodeURIComponent(url.split("/").pop() ?? "");
    const file = gltf.resources[name];
    return file ? new URL(file.path, location.href).href : url;
  });
  const text = new TextDecoder().decode(await fetchBytes(gltf.document.path, signal));
  return characterAsset(await new GLTFLoader(manager).parseAsync(text, new URL(".", location.href).href));
}

type MotionEntry = { name: string; source: { catalogId?: string; provider?: string; clip: string }; durationSeconds: number; loop: boolean };
/** What the processed view shows: a composition of bundle entries, or a reloaded export of one. */
type Processed = {
  instance: CharacterInstance; rest: CharacterInstance; label: string; detail: string;
  /** Present for a reloaded export; disposed with it. */
  exported?: CharacterAsset;
};
type Loaded = {
  data: RangerComparisonData;
  clips: MotionEntry[];
  sourceAssets: CharacterAsset[];
  body: CharacterInstance;
  outfit: CharacterInstance;
  libraries: Map<string, { asset: CharacterAsset; instance: CharacterInstance; rest: CharacterInstance; label: string }>;
  /** The `default` entry: its clips play on every composed variant through the shared joint names. */
  processedAsset: CharacterAsset;
  processed: Processed;
  appearance: HumanoidAppearance;
  sockets: HumanoidSockets;
  loadEntry: (key: string, variant: string) => Promise<GLTF>;
  archer: Group;
  /** Socket axes on the processed instances (humanoid-sockets attachment), shown with the Sockets toggle. */
  socketAxes: AxesHelper[];
  skeletons: Map<Object3D, SkeletonHelper>;
};

const state = {
  loaded: null as Loaded | null,
  renderers: null as Record<PanelId, { renderer: WebGLRenderer; scene: Scene; content: Group }> | null,
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
  selection: null as HumanoidSelection | null,
  /** Increments per composition request, so a late result never replaces a newer selection. */
  composeGeneration: 0,
};
const abort = new AbortController();

const currentClip = () => state.loaded?.clips[state.clip] ?? null;
const duration = () => currentClip()?.durationSeconds ?? 0;
/** The clip's source library mannequin, or undefined for a Mixamo clip, whose raw source is never published (Atlas 6.1.6). */
const motionLibrary = (loaded: Loaded) => loaded.libraries.get(currentClip()!.source.catalogId ?? "");

// ---------------------------------------------------------------------------
// Rendering

const camera = new PerspectiveCamera(35, 4 / 3, 0.01, 100);
function frameCamera(canvas: HTMLCanvasElement): PerspectiveCamera {
  const preset = VIEWS[state.view];
  const yaw = preset.yaw + state.yaw;
  const pitch = Math.max(-1.45, Math.min(1.45, preset.pitch + state.pitch));
  camera.aspect = Math.max(1, canvas.clientWidth) / Math.max(1, canvas.clientHeight);
  const vertical = (camera.fov * Math.PI) / 180;
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
  const distance = (FRAME.radius / Math.sin(Math.min(vertical, horizontal) / 2)) * preset.distance * state.zoom;
  camera.near = Math.max(distance - FRAME.radius * 4, distance * 0.01);
  camera.far = distance + FRAME.radius * 4;
  camera.position.set(
    FRAME.center.x + distance * Math.sin(yaw) * Math.cos(pitch),
    FRAME.center.y + distance * Math.sin(pitch),
    FRAME.center.z + distance * Math.cos(yaw) * Math.cos(pitch),
  );
  camera.lookAt(FRAME.center);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}


function renderAll(): void {
  const { loaded, renderers } = state;
  if (!loaded || !renderers) return;
  const library = motionLibrary(loaded);
  const withSkeleton = (instance: { root: Object3D }) => {
    if (!dom.skeleton.checked) return [instance];
    let helper = loaded.skeletons.get(instance.root);
    if (!helper) loaded.skeletons.set(instance.root, (helper = new SkeletonHelper(instance.root)));
    return [instance, { root: helper }];
  };
  const instances: Record<PanelId, { root: Object3D }[]> = {
    source: [...(dom.body.checked ? [loaded.body] : []), ...(dom.outfit.checked ? [loaded.outfit] : [])],
    motion: library ? withSkeleton(state.restPose ? library.rest : library.instance) : [],
    processed: withSkeleton(state.restPose ? loaded.processed.rest : loaded.processed.instance),
    archer: [{ root: loaded.archer }],
  };
  for (const id of Object.keys(instances) as PanelId[]) {
    const canvas = dom.canvases[id];
    if (canvas.clientWidth <= 0 || canvas.clientHeight <= 0) continue;
    const { renderer, content, scene } = renderers[id];
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    content.clear();
    for (const instance of instances[id]) content.add(instance.root);
    renderer.render(scene, frameCamera(canvas));
  }
}

function seekAll(): void {
  const loaded = state.loaded;
  const clip = currentClip();
  if (!loaded || !clip) return;
  motionLibrary(loaded)?.instance.seek(clip.source.clip, state.time);
  loaded.processed.instance.seek(clip.name, state.time);
}

function tick(timestamp: number): void {
  const delta = state.lastFrame === null ? 0 : Math.min(0.1, Math.max(0, (timestamp - state.lastFrame) / 1000));
  state.lastFrame = timestamp;
  if (state.loaded && state.playing) {
    state.time = duration() > 0 ? (state.time + delta) % duration() : 0;
    seekAll();
    showTime(true);
    state.dirty = true;
  }
  if (state.dirty) {
    state.dirty = false;
    renderAll();
  }
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Controls

function showTime(playing = false): void {
  if (!(playing && document.activeElement === dom.time)) dom.time.value = formatTime(state.time);
  dom.scrub.value = formatTime(state.time);
}
function syncUrl(): void {
  const params = new URLSearchParams();
  const clip = currentClip();
  if (clip) params.set("clip", clip.name);
  if (!state.playing) params.set("t", formatTime(state.time));
  params.set("view", state.view);
  const loaded = state.loaded;
  if (loaded && state.selection) {
    const initial = defaultSelection(loaded.appearance);
    const look = state.selection;
    if (look.outfit !== initial.outfit) params.set("outfit", look.outfit);
    if (look.skin !== initial.skin) params.set("skin", look.skin);
    if (look.hood !== initial.hood) params.set("hood", look.hood ? "1" : "0");
    if (look.hair) params.set("hair", look.hair);
    if (look.hairColor !== initial.hairColor) params.set("color", look.hairColor);
    if (look.faction !== initial.faction) params.set("faction", look.faction.slice(1));
    if (look.lod !== initial.lod) params.set("lod", look.lod);
  }
  history.replaceState(history.state, "", `${location.pathname}?${params.toString()}${location.hash}`);
}
function setRestPose(on: boolean): void {
  state.restPose = on;
  dom.rest.checked = on;
  if (on) setPlaying(false);
  state.dirty = true;
}
function setPlaying(playing: boolean): void {
  if (!state.loaded || state.playing === playing) return;
  if (playing) {
    if (state.restPose) setRestPose(false);
    state.lastFrame = null;
  } else {
    state.time = clampTime(state.time, duration());
    seekAll();
    showTime();
    state.dirty = true;
  }
  state.playing = playing;
  dom.play.textContent = playing ? "Pause" : "Play";
  syncUrl();
}
function seekTo(seconds: number): void {
  if (!state.loaded) return;
  setPlaying(false);
  if (state.restPose) setRestPose(false);
  state.time = clampTime(seconds, duration());
  seekAll();
  showTime();
  syncUrl();
  state.dirty = true;
}
function selectClip(index: number): void {
  const loaded = state.loaded;
  if (!loaded || !loaded.clips[index]) return;
  state.clip = index;
  dom.clip.selectedIndex = index;
  dom.scrub.max = formatTime(duration());
  dom.time.max = formatTime(duration());
  state.time = clampTime(state.time, duration());
  seekAll();
  showTime();
  renderCaptions(loaded);
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
const orbit = (yaw: number, pitch: number) => { state.yaw += yaw; state.pitch = Math.max(-1.5, Math.min(1.5, state.pitch + pitch)); state.dirty = true; };
const zoomBy = (factor: number) => { state.zoom = Math.max(0.2, Math.min(8, state.zoom * factor)); state.dirty = true; };

dom.clip.addEventListener("change", () => selectClip(dom.clip.selectedIndex));
dom.play.addEventListener("click", () => setPlaying(!state.playing));
dom.rest.addEventListener("change", () => setRestPose(dom.rest.checked));
dom.body.addEventListener("change", () => { state.dirty = true; });
dom.skeleton.addEventListener("change", () => { state.dirty = true; });
dom.sockets.addEventListener("change", () => {
  for (const axes of state.loaded?.socketAxes ?? []) axes.visible = dom.sockets.checked;
  state.dirty = true;
});
function applyWireframe(roots: Object3D[]): void {
  for (const root of roots) root.traverse((node) => {
    const material = (node as Mesh).material as Material | Material[] | undefined;
    for (const item of Array.isArray(material) ? material : material ? [material] : []) {
      (item as Material & { wireframe?: boolean }).wireframe = dom.wireframe.checked;
    }
  });
}
dom.wireframe.addEventListener("change", () => {
  const loaded = state.loaded;
  if (!loaded) return;
  applyWireframe([loaded.body.root, loaded.outfit.root, loaded.processed.instance.root, loaded.processed.rest.root, loaded.archer,
    ...[...loaded.libraries.values()].flatMap((library) => [library.instance.root, library.rest.root])]);
  state.dirty = true;
});
dom.outfit.addEventListener("change", () => { state.dirty = true; });
dom.time.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); seekTo(Number(dom.time.value)); } });
dom.time.addEventListener("change", () => (dom.time.value.trim() === "" ? showTime() : seekTo(Number(dom.time.value))));
dom.scrub.addEventListener("input", () => seekTo(Number(dom.scrub.value)));
for (const button of dom.presets) button.addEventListener("click", () => { const view = button.dataset.view ?? null; if (isView(view)) selectView(view); });
for (const canvas of Object.values(dom.canvases)) {
  canvas.addEventListener("keydown", (event) => {
    const step = Math.PI / 18;
    const actions: Record<string, () => void> = {
      ArrowLeft: () => orbit(-step, 0), ArrowRight: () => orbit(step, 0), ArrowUp: () => orbit(0, step), ArrowDown: () => orbit(0, -step),
      "+": () => zoomBy(1 / 1.2), "=": () => zoomBy(1 / 1.2), "-": () => zoomBy(1.2), _: () => zoomBy(1.2),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  });
  let drag: { x: number; y: number; id: number } | null = null;
  canvas.addEventListener("pointerdown", (event) => { drag = { x: event.clientX, y: event.clientY, id: event.pointerId }; canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    orbit(-(event.clientX - drag.x) * 0.01, (event.clientY - drag.y) * 0.01);
    drag = { x: event.clientX, y: event.clientY, id: event.pointerId };
  });
  const end = (event: PointerEvent) => { if (drag?.id === event.pointerId) drag = null; };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("wheel", (event) => { event.preventDefault(); zoomBy(Math.exp(event.deltaY * 0.001)); }, { passive: false });
  new ResizeObserver(() => { state.dirty = true; }).observe(canvas);
}
function setControlsEnabled(enabled: boolean): void {
  for (const control of [dom.clip, dom.play, dom.rest, dom.time, dom.scrub, dom.body, dom.outfit, dom.wireframe, dom.skeleton, dom.sockets, dom.compose, ...dom.presets]) control.disabled = !enabled;
}

function caption(id: PanelId, title: string, detail: string): void {
  const heading = document.createElement("strong");
  heading.textContent = title;
  const line = document.createElement("span");
  line.textContent = detail;
  dom.captions[id].replaceChildren(heading, line);
}
function renderCaptions(loaded: Loaded): void {
  const { data } = loaded;
  const clip = currentClip()!;
  const library = motionLibrary(loaded);
  caption("source", "Original source · rest pose", `${data.ranger.outfitId} + ${data.ranger.bodyId} · ${short(data.ranger.outfit.document.sha256)} / ${short(data.ranger.body.document.sha256)} · source ships no clips`);
  // Owner answer: a clip without a published source (Mixamo) hides the source-motion view; the others widen.
  const motionView = dom.canvases.motion.parentElement!;
  motionView.hidden = !library;
  motionView.parentElement!.classList.toggle("three", !library);
  if (library) caption("motion", `Source motion · ${library.label}`, `${clip.source.catalogId} · ${clip.source.clip} · not retargeted`);
  caption("processed", `Processed · ${loaded.processed.label}`, `${loaded.processed.detail} · ${clip.name} · retargeted, in place`);
  caption("archer", "Primitive-built archer · debug fallback", `medieval-character-kit archer.obj · ${short(data.archer.file.sha256)} · static, no rig`);
}

// ---------------------------------------------------------------------------
// Editing the processed character (#127)

const socketAxes = (loaded: Loaded, roots: Object3D[]): AxesHelper[] => {
  const axes: AxesHelper[] = [];
  for (const root of roots) {
    for (const socket of loaded.sockets.sockets) {
      const joint = root.getObjectByName(socket.joint);
      if (!joint) continue;
      const helper = new AxesHelper(0.12);
      helper.name = `socket-axes:${socket.id}`;
      helper.position.fromArray(socket.translation);
      helper.quaternion.copy(new Quaternion().fromArray(socket.rotation));
      helper.visible = dom.sockets.checked;
      joint.add(helper);
      axes.push(helper);
    }
  }
  return axes;
};

function replaceProcessed(loaded: Loaded, next: Processed): void {
  const previous = loaded.processed;
  for (const root of [previous.instance.root, previous.rest.root]) {
    loaded.skeletons.get(root)?.dispose();
    loaded.skeletons.delete(root);
    root.removeFromParent();
  }
  for (const axes of loaded.socketAxes) axes.removeFromParent();
  previous.instance.dispose();
  previous.rest.dispose();
  previous.exported?.dispose();
  loaded.processed = next;
  loaded.socketAxes = socketAxes(loaded, [next.instance.root, next.rest.root]);
  applyWireframe([next.instance.root, next.rest.root]);
  seekAll();
  renderCaptions(loaded);
  state.dirty = true;
}

function showLook(look: HumanoidSelection): void {
  dom.outfitSelect.value = look.outfit;
  dom.skin.value = look.skin;
  dom.hood.checked = look.hood;
  dom.hair.value = look.hair ?? "";
  dom.hairColor.value = look.hairColor;
  dom.faction.value = look.faction;
  dom.lod.value = look.lod;
  const outfit = state.loaded?.appearance.outfits.find((candidate) => candidate.id === look.outfit);
  dom.faction.disabled = !outfit?.faction;
  dom.hairColor.disabled = !look.hair;
}

function lookFromControls(): HumanoidSelection {
  return {
    outfit: dom.outfitSelect.value, skin: dom.skin.value, hood: dom.hood.disabled ? (state.selection?.hood ?? false) : dom.hood.checked, hair: dom.hair.value || null,
    hairColor: dom.hairColor.value, faction: dom.faction.value, lod: dom.lod.value,
  };
}

/**
 * Composes `look` from the bundle and shows it. An incompatible or failing look keeps the previous character
 * and controls and shows why; a newer request supersedes an older one that is still loading.
 */
async function applyLook(look: HumanoidSelection): Promise<boolean> {
  const loaded = state.loaded;
  if (!loaded) return false;
  const generation = ++state.composeGeneration;
  dom.composeError.hidden = true;
  dom.compose.setAttribute("aria-busy", "true");
  const compose = () => composeHumanoid({
    appearance: loaded.appearance, sockets: loaded.sockets, selection: look, clips: loaded.processedAsset.gltf.animations, load: loaded.loadEntry,
  });
  const composed: Awaited<ReturnType<typeof compose>>[] = [];
  try {
    composed.push(await compose());
    composed.push(await compose());
  } catch (error) {
    for (const item of composed) item.dispose();
    if (generation !== state.composeGeneration) return false;
    dom.compose.removeAttribute("aria-busy");
    dom.composeError.textContent = `Not applied: ${error instanceof Error ? error.message : String(error)}`;
    dom.composeError.hidden = false;
    if (state.selection) showLook(state.selection);
    return false;
  }
  if (generation !== state.composeGeneration || state.loaded !== loaded) {
    for (const item of composed) item.dispose();
    return false;
  }
  dom.compose.removeAttribute("aria-busy");
  const [instance, rest] = composed as [typeof composed[number], typeof composed[number]];
  state.selection = look;
  showLook(look);
  dom.hood.disabled = !instance.hasHood;
  if (!instance.hasHood) dom.hood.checked = false;
  const outfit = loaded.appearance.outfits.find((candidate) => candidate.id === look.outfit)!;
  const parts = [outfit.label, look.skin, instance.hasHood ? (look.hood ? "hood" : "no hood") : "", look.hair ? `${look.hair} (${look.hairColor})` : "", look.lod];
  replaceProcessed(loaded, {
    instance, rest, label: loaded.data.bundle.label,
    detail: `${loaded.appearance.character}/${instance.variant} · ${parts.filter(Boolean).join(", ")} · ${Math.round(instance.triangles)} triangles`,
  });
  syncUrl();
  return true;
}

function download(bytes: ArrayBuffer, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: "model/gltf-binary" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Exports the shown composition as one GLB with every clip, downloads it and reloads it into the processed view. */
async function exportLook(): Promise<void> {
  const loaded = state.loaded;
  const look = state.selection;
  if (!loaded || !look) return;
  const generation = ++state.composeGeneration;
  dom.composeError.hidden = true;
  dom.exportGlb.disabled = true;
  const { root } = loaded.processed.instance;
  const helpers = loaded.socketAxes.filter((axes) => axes.parent !== null);
  const parents = helpers.map((axes) => axes.parent!);
  for (const axes of helpers) axes.removeFromParent();
  try {
    const bytes = (await new GLTFExporter().parseAsync(root, { binary: true, animations: loaded.processedAsset.gltf.animations, onlyVisible: true })) as ArrayBuffer;
    helpers.forEach((axes, index) => parents[index]!.add(axes));
    const name = `${loaded.appearance.character}.${look.outfit}.glb`;
    download(bytes, name);
    const asset = characterAsset(await new GLTFLoader().parseAsync(bytes, ""));
    if (generation !== state.composeGeneration || state.loaded !== loaded) { asset.dispose(); return; }
    replaceProcessed(loaded, {
      instance: asset.createInstance(), rest: asset.createInstance(), exported: asset, label: "exported GLB, reloaded",
      detail: `${name} · ${(bytes.byteLength / 1048576).toFixed(1)} MB · ${asset.clips.length} clips`,
    });
  } catch (error) {
    helpers.forEach((axes, index) => { if (!axes.parent) parents[index]!.add(axes); });
    dom.composeError.textContent = `Export failed: ${error instanceof Error ? error.message : String(error)}`;
    dom.composeError.hidden = false;
  } finally {
    dom.exportGlb.disabled = false;
  }
}

for (const control of [dom.outfitSelect, dom.skin, dom.hood, dom.hair, dom.hairColor, dom.faction, dom.lod]) {
  control.addEventListener("change", () => void applyLook(lookFromControls()));
}
dom.exportGlb.addEventListener("click", () => void exportLook());
dom.resetLook.addEventListener("click", () => { if (state.loaded) void applyLook(defaultSelection(state.loaded.appearance)); });

function lookFromUrl(appearance: HumanoidAppearance, params: URLSearchParams): HumanoidSelection {
  const look = defaultSelection(appearance);
  const outfit = params.get("outfit");
  if (outfit) look.outfit = outfit;
  const skin = params.get("skin");
  if (skin) look.skin = skin;
  if (params.has("hood")) look.hood = params.get("hood") === "1";
  look.hair = params.get("hair") || null;
  const color = params.get("color");
  if (color) look.hairColor = color;
  const faction = params.get("faction");
  if (faction && /^[0-9a-f]{6}$/i.test(faction)) look.faction = `#${faction.toLowerCase()}`;
  const lod = params.get("lod");
  if (lod) look.lod = lod;
  return look;
}

function fillLookControls(appearance: HumanoidAppearance): void {
  const options = (select: HTMLSelectElement, items: { value: string; label: string }[]) =>
    select.replaceChildren(...items.map((item) => { const option = document.createElement("option"); option.value = item.value; option.textContent = item.label; return option; }));
  options(dom.outfitSelect, appearance.outfits.map((outfit) => ({ value: outfit.id, label: outfit.label })));
  options(dom.skin, appearance.skins.map((skin) => ({ value: skin.id, label: skin.label })));
  options(dom.hair, [{ value: "", label: "None" }, ...appearance.hair.map((hair) => ({ value: hair.id, label: hair.id.replace(/^hair\./, "") }))]);
  options(dom.hairColor, hairColors(appearance).map((color) => ({ value: color.id, label: color.label })));
  const levels = [...new Set(appearance.levelsOfDetail.map((level) => level.level))];
  options(dom.lod, [{ value: "lod0", label: "lod0 (full)" }, ...levels.map((level) => ({ value: level, label: level }))]);
}

// ---------------------------------------------------------------------------
// Loading

function showFailure(message: string): void {
  dom.workspace.hidden = true;
  dom.status.hidden = true;
  setControlsEnabled(false);
  const box = document.createElement("div");
  box.setAttribute("role", "alert");
  const heading = document.createElement("strong");
  heading.textContent = "The comparison could not be loaded";
  const text = document.createElement("p");
  text.textContent = message;
  box.append(heading, text);
  dom.failure.replaceChildren(box);
  dom.failure.hidden = false;
}

async function loadArcher(file: PinnedFile, unitScale: number, signal: AbortSignal): Promise<Group> {
  const bytes = await fetchBytes(file.path, signal);
  const group = new OBJLoader().parse(new TextDecoder().decode(bytes));
  const material = new MeshStandardMaterial({ color: 0x8c8c8c, roughness: 0.8 });
  group.traverse((node) => { if ((node as Mesh).isMesh) (node as Mesh).material = material; });
  group.scale.setScalar(unitScale);
  return group;
}

async function start(): Promise<void> {
  const { signal } = abort;
  try {
    const response = await fetch(new URL("data.json", location.href), { signal, cache: "no-cache" });
    if (!response.ok) throw new Error(`data.json answered HTTP ${response.status}; this Pages build has no Ranger comparison data`);
    const data = (await response.json()) as RangerComparisonData;
    dom.status.textContent = "Loading the processed bundle…";
    const manifestBytes = await fetchBytes(data.bundle.manifest, signal);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    const entry = manifest.assets.find((asset: { key: string; variant: string }) => asset.key === data.bundle.key && asset.variant === data.bundle.variant);
    if (!entry) throw new Error("processed Ranger entry is missing from the bundle manifest");
    type ManifestEntry = { key: string; variant: string; path: string; resources: { path: string }[]; attachments: { name: string; path: string }[] };
    const declared = new Set<string>((manifest.assets as ManifestEntry[]).flatMap((asset) =>
      [asset.path, ...asset.resources.map((resource) => resource.path), ...asset.attachments.map((item) => item.path)]));
    // Preview only: prevent undeclared loads and report missing files; do not rehash every working output.
    const readResource = async (file: string) => {
      if (!declared.has(file)) throw new Error(`bundle file ${file} is not declared in the manifest`);
      return fetchBytes(`bundle/${file}`, signal);
    };
    const attachment = async (name: string) => {
      const declaredAttachment = entry.attachments.find((item: { name: string }) => item.name === name);
      if (!declaredAttachment) throw new Error(`processed Ranger entry has no ${name} attachment`);
      return JSON.parse(new TextDecoder().decode(await readResource(declaredAttachment.path)));
    };
    // The bundle's scene refers to its resources relatively, so GLTFLoader resolves them under bundle/.
    const manager = new LoadingManager();
    manager.setURLModifier((url) => {
      const relative = new URL(url, location.href).pathname.split("/bundle/")[1];
      if (relative !== undefined && !declared.has(relative)) throw new Error(`bundle file ${relative} is not declared in the manifest`);
      return url;
    });
    const entries = new Map<string, Promise<GLTF>>();
    const loadEntry = (key: string, variant: string): Promise<GLTF> => {
      const id = `${key}/${variant}`;
      let pending = entries.get(id);
      if (!pending) {
        const found = (manifest.assets as ManifestEntry[]).find((asset) => asset.key === key && asset.variant === variant);
        pending = found
          ? new GLTFLoader(manager).loadAsync(new URL(`bundle/${found.path}`, location.href).href)
          : Promise.reject(new Error(`the bundle has no ${id} entry`));
        pending.catch(() => entries.delete(id));
        entries.set(id, pending);
      }
      return pending;
    };
    const processedAsset = characterAsset(await loadEntry(entry.key, entry.variant));
    const motion = (await attachment("humanoid-clips")) as { clips: MotionEntry[] };
    const sockets = (await attachment("humanoid-sockets")) as HumanoidSockets;
    const appearance = (await attachment("humanoid-appearance")) as HumanoidAppearance;

    dom.status.textContent = "Loading the original source and clip libraries…";
    const bodyAsset = await loadSourceGltf(data.ranger.body, signal);
    const outfitAsset = await loadSourceGltf(data.ranger.outfit, signal);
    const libraries: Loaded["libraries"] = new Map();
    const sourceAssets = [bodyAsset, outfitAsset];
    for (const library of data.libraries) {
      const asset = characterAsset(await new GLTFLoader().parseAsync((await fetchBytes(library.file.path, signal)).buffer as ArrayBuffer, ""));
      sourceAssets.push(asset);
      libraries.set(library.catalogId, { asset, instance: asset.createInstance(), rest: asset.createInstance(), label: library.label });
    }
    const clips = motion.clips;
    const archer = await loadArcher(data.archer.file, data.archer.unitScale, signal);
    const processed: Processed = {
      instance: processedAsset.createInstance(), rest: processedAsset.createInstance(), label: data.bundle.label, detail: `${data.bundle.key}/${data.bundle.variant}`,
    };
    const loaded: Loaded = {
      data, clips, sourceAssets, body: bodyAsset.createInstance(), outfit: outfitAsset.createInstance(), libraries,
      processedAsset, processed, appearance, sockets, loadEntry, archer, socketAxes: [], skeletons: new Map(),
    };
    state.loaded = loaded;
    dom.clip.replaceChildren(...clips.map((clip) => {
      const option = document.createElement("option");
      option.value = clip.name;
      option.textContent = `${clip.name} · ${formatTime(clip.durationSeconds)} s`;
      return option;
    }));
    const params = new URLSearchParams(location.search);
    const requested = clips.findIndex((clip) => clip.name === params.get("clip"));
    const view = params.get("view")?.toLowerCase() ?? null;
    state.renderers = Object.fromEntries(Object.entries(dom.canvases).map(([id, canvas]) =>
      [id, { renderer: new WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true }), ...viewerScene() }])) as NonNullable<typeof state.renderers>;
    selectView(isView(view) ? view : "front");
    selectClip(requested >= 0 ? requested : 0);
    fillLookControls(appearance);
    dom.status.textContent = "Composing the processed character…";
    if (!(await applyLook(lookFromUrl(appearance, params)))) {
      const reason = dom.composeError.textContent;
      if (!(await applyLook(defaultSelection(appearance)))) throw new Error(dom.composeError.textContent ?? "the default character could not be composed");
      dom.composeError.textContent = `The look in the URL was not applied: ${reason}`;
      dom.composeError.hidden = false;
    }
    const t = Number(params.get("t") ?? "0");
    seekTo(Number.isFinite(t) ? t : 0);
    dom.status.hidden = true;
    dom.workspace.hidden = false;
    setControlsEnabled(true);
    state.dirty = true;
    requestAnimationFrame(tick);
  } catch (error) {
    if (signal.aborted) return;
    showFailure(error instanceof Error ? error.message : String(error));
  }
}

window.addEventListener("pagehide", () => {
  abort.abort();
  const loaded = state.loaded;
  state.loaded = null;
  if (loaded) {
    loaded.processed.instance.dispose();
    loaded.processed.rest.dispose();
    loaded.processed.exported?.dispose();
    loaded.processedAsset.dispose();
    for (const asset of loaded.sourceAssets) asset.dispose();
  }
  for (const panel of Object.values(state.renderers ?? {})) panel.renderer.dispose();
  state.renderers = null;
});
window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); });

void start();
