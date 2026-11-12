// Terrain workbench (#127, docs/terrain-workbench.md): direct controls over one terrain patch recipe. Edits run the
// recipe's own component build in a Web Worker (terrain-workbench-worker.ts), which keeps the previous build so only
// components whose inputs changed execute; kept components are passed as `preserve`, so an edit that would change
// one is refused. Only the latest request may update the page, invalid edits keep the last valid result, and the
// recipe lives in the URL so a reload restores it.
import exampleRecipe from "../../examples/terrain-patches/recipe.json";
import { TERRAIN_PATCH_PRESETS, type TerrainDetailLayer, type TerrainPatchRecipe, type TerrainShaping } from "../terrain-patch-recipes.js";
import type { TerrainWorkbenchPatch } from "./terrain-workbench-compute.js";
import {
  changedComponents, componentIdentities, decodeTerrainParam, encodeTerrainParam, reseedTerrainRecipe, terrainComponentNames,
  terrainFieldForError, terrainFormFields, terrainRecipeKey, terrainSeedFields, terrainWorkbenchRecipe,
} from "./terrain-workbench-state.js";
import { RecipeHistory } from "./texture-workbench-state.js";
import type { TerrainWorkbenchJob, TerrainWorkbenchResult } from "./terrain-workbench-worker.js";
import { WorkbenchRunner } from "./workbench-runner.js";

type Accepted = { recipe: TerrainPatchRecipe; identities: Record<string, string> };
type Built = { patches: TerrainWorkbenchPatch[]; recipe: TerrainPatchRecipe; identities: Record<string, string> };

const STORAGE_ACCEPTED = "asset-tooling.terrain-workbench.accepted.v1";
const STORAGE_PRESETS = "asset-tooling.terrain-workbench.presets.v1";
const builtInPresets: Record<string, unknown> = { "greyhaven-hillside (example)": exampleRecipe, ...TERRAIN_PATCH_PRESETS };
const LAYER_COLORS = ["#f4d35e", "#ef6f8f", "#7fc8f8", "#c3f584", "#c39bd3", "#ff9f43", "#5ee0c0", "#ffffff"];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("recipe");
const status = $<HTMLParagraphElement>("status");
const stagesLine = $<HTMLParagraphElement>("stages");
const cancelButton = $<HTMLButtonElement>("cancel");
const undoButton = $<HTMLButtonElement>("undo");
const redoButton = $<HTMLButtonElement>("redo");
const presetSelect = $<HTMLSelectElement>("preset");
const currentCanvas = $<HTMLCanvasElement>("current");
const acceptedCanvas = $<HTMLCanvasElement>("accepted");
const acceptedFigure = $<HTMLElement>("accepted-figure");
const approval = $<HTMLParagraphElement>("approval");
const componentsBody = $<HTMLTableSectionElement>("components");
const compareToggle = $<HTMLInputElement>("compare");
const overlayButton = $<HTMLButtonElement>("overlay");

function readJson<T>(key: string): T | undefined {
  try {
    const text = localStorage.getItem(key);
    return text ? (JSON.parse(text) as T) : undefined;
  } catch {
    return undefined;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    status.textContent = "This browser refused to store the workbench state.";
  }
}
const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ---- recipe <-> form -------------------------------------------------------------------------------------------

const lockedSeeds = new Set<string>();
const keptComponents = new Set<string>();

function input(name: string, label: string, unit: string, { text = false } = {}) {
  return `<label for="f-${name}">${label}</label>
    <div class="input"><input id="f-${name}" name="${name}" type="${text ? "text" : "number"}" ${text ? 'spellcheck="false"' : 'step="any" inputmode="decimal"'} aria-describedby="error-${name}"><span class="unit">${unit}</span></div>
    <small class="error" id="error-${name}" aria-live="polite"></small>`;
}
function seedInput(name: string, label: string) {
  return `<label for="f-${name}">${label}</label>
    <div class="input"><input id="f-${name}" name="${name}" type="text" inputmode="numeric" spellcheck="false" aria-describedby="error-${name}"><span class="unit">uint32</span></div>
    <small class="error" id="error-${name}" aria-live="polite"></small>
    <div class="wide row"><label><input type="checkbox" data-seed-lock="${name}"> Lock</label><button type="button" class="small" data-reseed="${name}">Reseed</button></div>`;
}
function pair(name: string, label: string, unit: string, parts = ["0", "1"]) {
  return `<label for="f-${name}.${parts[0]}">${label}</label>
    <div class="input"><input id="f-${name}.${parts[0]}" name="${name}.${parts[0]}" type="number" step="any" inputmode="decimal" aria-label="${label} ${parts[0] === "0" ? "low / X" : parts[0]}" aria-describedby="error-${name}.${parts[0]}">
    <input id="f-${name}.${parts[1]}" name="${name}.${parts[1]}" type="number" step="any" inputmode="decimal" aria-label="${label} ${parts[1] === "1" ? "high / Z" : parts[1]}" aria-describedby="error-${name}.${parts[1]}"><span class="unit">${unit}</span></div>
    <small class="error" id="error-${name}.${parts[0]}" aria-live="polite"></small><small class="error" id="error-${name}.${parts[1]}" aria-live="polite"></small>`;
}
function json(name: string, label: string) {
  return `<label class="wide" for="f-${name}">${label}</label>
    <textarea class="wide" id="f-${name}" name="${name}" spellcheck="false" aria-describedby="error-${name}"></textarea>
    <small class="error" id="error-${name}" aria-live="polite"></small>`;
}

/** Rebuilds the form controls for a recipe's structure (shaping kind and detail layers) and fills them. */
function writeForm(recipe: TerrainPatchRecipe) {
  const shaping = recipe.shaping.kind === "island"
    ? pair("shaping.center", "Center", "m") + input("shaping.radius", "Radius", "m") + input("shaping.falloff", "Falloff", "m") + input("shaping.seaLevel", "Sea level", "m")
    : recipe.shaping.kind === "terrace" ? input("shaping.step", "Step", "m") + input("shaping.sharpness", "Sharpness", "0–0.95") : "";
  form.innerHTML = `
    <fieldset><legend>Patch grid</legend>
      ${input("id", "Recipe id", "token", { text: true })}
      ${seedInput("seed", "Height seed")}
      ${pair("origin", "Origin X / Z", "m")}
      ${input("sampleSpacing", "Sample spacing", "m")}
      ${pair("samples", "Samples X / Z", "per patch")}
    </fieldset>
    <fieldset><legend>Height range</legend>
      ${input("height.min", "Minimum", "m")}${input("height.max", "Maximum", "m")}${input("height.precision", "Precision", "m / step")}
    </fieldset>
    <fieldset><legend>Noise</legend>
      ${input("noise.baseHeight", "Base height", "m")}${input("noise.amplitude", "Amplitude", "m")}${input("noise.featureSize", "Feature size", "m")}
      ${input("noise.octaves", "Octaves", "1–8")}${input("noise.roughness", "Roughness", "0–1")}
    </fieldset>
    <fieldset><legend>Shaping</legend>
      <label for="f-shaping.kind">Kind</label>
      <div class="input"><select id="f-shaping.kind" name="shaping.kind" aria-describedby="error-shaping.kind"><option value="noise">noise</option><option value="island">island</option><option value="terrace">terrace</option></select></div>
      <small class="error" id="error-shaping.kind" aria-live="polite"></small>
      ${shaping}
    </fieldset>
    <fieldset><legend>Shapes (JSON, metres)</legend>
      ${json("edits", "Edits: flatten / path")}${json("exclusions", "Detail exclusions")}${json("paint", "Paint masks by name")}
    </fieldset>
    ${recipe.detail.map((layer, i) => `<fieldset data-layer="${i}"><legend>Detail layer ${i + 1}<button type="button" class="small" data-remove-layer="${i}" aria-label="Remove detail layer ${i + 1}">Remove</button></legend>
      ${input(`detail.${i}.id`, "Layer id", "token", { text: true })}
      ${seedInput(`detail.${i}.seed`, "Layer seed")}
      ${input(`detail.${i}.density`, "Density", "/ m²")}${input(`detail.${i}.minSpacing`, "Min spacing", "m")}
      ${pair(`detail.${i}.slopeDegrees`, "Slope", "°")}${pair(`detail.${i}.height`, "Height", "m")}
      ${input(`detail.${i}.maxExclusion`, "Max exclusion", "0–1")}
      ${input(`detail.${i}.paint`, "Paint mask", "name / empty", { text: true })}
      ${pair(`detail.${i}.scale`, "Scale", "×")}${input(`detail.${i}.variants`, "Variants", "count")}
    </fieldset>`).join("")}`;
  const set = (name: string, value: unknown) => {
    const element = form.elements.namedItem(name) as HTMLInputElement | null;
    if (element) element.value = value === null ? "" : String(value);
  };
  set("id", recipe.id); set("seed", recipe.seed); set("origin.0", recipe.origin[0]); set("origin.1", recipe.origin[1]);
  set("sampleSpacing", recipe.sampleSpacing); set("samples.0", recipe.samples[0]); set("samples.1", recipe.samples[1]);
  for (const key of ["min", "max", "precision"] as const) set(`height.${key}`, recipe.height[key]);
  for (const key of ["baseHeight", "amplitude", "featureSize", "octaves", "roughness"] as const) set(`noise.${key}`, recipe.noise[key]);
  set("shaping.kind", recipe.shaping.kind);
  if (recipe.shaping.kind === "island") {
    set("shaping.center.0", recipe.shaping.center[0]); set("shaping.center.1", recipe.shaping.center[1]);
    for (const key of ["radius", "falloff", "seaLevel"] as const) set(`shaping.${key}`, recipe.shaping[key]);
  } else if (recipe.shaping.kind === "terrace") {
    set("shaping.step", recipe.shaping.step); set("shaping.sharpness", recipe.shaping.sharpness);
  }
  set("edits", JSON.stringify(recipe.edits, null, 1)); set("exclusions", JSON.stringify(recipe.exclusions, null, 1)); set("paint", JSON.stringify(recipe.paint, null, 1));
  recipe.detail.forEach((layer, i) => {
    for (const key of ["id", "seed", "density", "minSpacing", "maxExclusion", "paint", "variants"] as const) set(`detail.${i}.${key}`, layer[key]);
    for (const key of ["slopeDegrees", "height", "scale"] as const) { set(`detail.${i}.${key}.0`, layer[key][0]); set(`detail.${i}.${key}.1`, layer[key][1]); }
  });
  syncSeedLocks();
}

function syncSeedLocks() {
  for (const box of form.querySelectorAll<HTMLInputElement>("[data-seed-lock]")) {
    const name = box.dataset.seedLock!;
    box.checked = lockedSeeds.has(name);
    (form.elements.namedItem(name) as HTMLInputElement).readOnly = box.checked;
    form.querySelector<HTMLButtonElement>(`[data-reseed="${name}"]`)!.disabled = box.checked;
  }
}

function readForm(): unknown {
  const raw = (name: string) => ((form.elements.namedItem(name) as HTMLInputElement | null)?.value ?? "").trim();
  const number = (name: string): unknown => { const text = raw(name); return /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text) ? Number(text) : text; };
  const pairOf = (name: string) => [number(`${name}.0`), number(`${name}.1`)];
  const parsed = (name: string): unknown => {
    try { return JSON.parse(raw(name)); } catch (error) { throw new Error(`${name} is not valid JSON: ${(error as Error).message}`); }
  };
  const kind = raw("shaping.kind");
  const shaping = kind === "island" ? { kind, center: pairOf("shaping.center"), radius: number("shaping.radius"), falloff: number("shaping.falloff"), seaLevel: number("shaping.seaLevel") }
    : kind === "terrace" ? { kind, step: number("shaping.step"), sharpness: number("shaping.sharpness") } : { kind };
  const layers = form.querySelectorAll("[data-layer]").length;
  return {
    schemaVersion: 2, id: raw("id"), seed: number("seed"), origin: pairOf("origin"), sampleSpacing: number("sampleSpacing"), samples: pairOf("samples"),
    height: { min: number("height.min"), max: number("height.max"), precision: number("height.precision") },
    noise: { baseHeight: number("noise.baseHeight"), amplitude: number("noise.amplitude"), featureSize: number("noise.featureSize"), octaves: number("noise.octaves"), roughness: number("noise.roughness") },
    shaping, edits: parsed("edits"), exclusions: parsed("exclusions"), paint: parsed("paint"),
    detail: Array.from({ length: layers }, (_, i) => {
      const p = `detail.${i}`;
      return { id: raw(`${p}.id`), seed: number(`${p}.seed`), density: number(`${p}.density`), minSpacing: number(`${p}.minSpacing`),
        slopeDegrees: pairOf(`${p}.slopeDegrees`), height: pairOf(`${p}.height`), maxExclusion: number(`${p}.maxExclusion`),
        paint: raw(`${p}.paint`) === "" ? null : raw(`${p}.paint`), scale: pairOf(`${p}.scale`), variants: number(`${p}.variants`) };
    }),
  };
}

function showError(message: string | undefined) {
  for (const slot of form.querySelectorAll<HTMLElement>(".error")) slot.textContent = "";
  for (const element of form.querySelectorAll("[aria-invalid]")) element.removeAttribute("aria-invalid");
  $("error-form").textContent = "";
  if (!message) return;
  const name = terrainFieldForError(message, terrainFormFields(history.current));
  const slot = name ? document.getElementById(`error-${name}`) : null;
  (slot ?? $("error-form")).textContent = message;
  if (slot) (form.elements.namedItem(name!) as HTMLElement | null)?.setAttribute("aria-invalid", "true");
}

// ---- state -----------------------------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const initial = decodeTerrainParam(params.get("recipe")) ?? terrainWorkbenchRecipe(structuredClone(exampleRecipe));
const history = new RecipeHistory<TerrainPatchRecipe>(initial);
let current: Built | undefined;
let lastBuild: { executed: Record<string, number>; reused: Record<string, number> } | undefined;
let refused: string | undefined;
let acceptedBuilt: Built | undefined;
let accepted = readJson<Accepted>(STORAGE_ACCEPTED);
let savedKey = terrainRecipeKey(initial);
let view = params.get("view") ?? "shaded";
let overlay = params.get("detail") !== "0";
try { if (accepted) accepted.recipe = terrainWorkbenchRecipe(accepted.recipe); } catch { accepted = undefined; }

const newRunner = (onResult: (result: TerrainWorkbenchResult) => void, onBusy: (busy: boolean) => void) =>
  new WorkbenchRunner<Omit<TerrainWorkbenchJob, "id">, TerrainWorkbenchResult>("./worker.js", onResult, onBusy);
const built = (patches: TerrainWorkbenchPatch[], recipe: TerrainPatchRecipe): Built =>
  ({ patches, recipe, identities: componentIdentities(patches.map((p) => p.record)) });

let requested: TerrainPatchRecipe = history.current;
const currentRunner = newRunner((result) => {
  if (!result.ok) {
    refused = /terrain component '([^']+)' cannot be preserved/.exec(result.error)?.[1];
    status.dataset.state = "error";
    status.textContent = `Build refused: ${result.error}. The last valid result stays; undo or release the component.`;
    if (!refused) status.textContent = `Build failed: ${result.error}. The last valid result stays.`;
    render();
    return;
  }
  refused = undefined;
  current = built(result.patches, requested);
  const count = (key: "executed" | "reused") => {
    const out: Record<string, number> = {};
    for (const patch of result.patches) for (const name of patch.stages[key]) out[name] = (out[name] ?? 0) + 1;
    return out;
  };
  lastBuild = { executed: count("executed"), reused: count("reused") };
  const total = (key: "executed" | "reused") => result.patches.reduce((sum, p) => sum + p.stages[key].length, 0);
  const samples = result.patches.reduce((sum, p) => sum + p.heightSamplesEvaluated, 0);
  const instances = result.patches.reduce((sum, p) => sum + p.detail.length, 0);
  status.dataset.state = "";
  status.textContent = `Built ${result.patches.length} patches in ${result.milliseconds} ms: ${instances.toLocaleString("en-US")} detail instances.`;
  stagesLine.textContent = `${total("executed")} components executed, ${total("reused")} reused; ${samples.toLocaleString("en-US")} height samples evaluated.`;
  render();
}, (busy) => {
  cancelButton.hidden = !busy;
  if (busy) { status.dataset.state = ""; status.textContent = "Building…"; }
});
let acceptedRequested: TerrainPatchRecipe | undefined;
const acceptedRunner = newRunner((result) => {
  if (result.ok && acceptedRequested) acceptedBuilt = built(result.patches, acceptedRequested);
  render();
}, () => undefined);

function runCurrent() {
  requested = history.current;
  const names = new Set(terrainComponentNames(history.current));
  currentRunner.run({ recipe: history.current, preserve: [...keptComponents].filter((name) => names.has(name)) });
}

function presetOptions() {
  const saved = readJson<Record<string, TerrainPatchRecipe>>(STORAGE_PRESETS) ?? {};
  const option = (value: string, label: string) => `<option value="${escape(value)}">${escape(label)}</option>`;
  presetSelect.innerHTML = `<option value="">Choose a preset…</option><optgroup label="Recipe presets">${
    Object.keys(builtInPresets).map((name) => option(`builtin:${name}`, name)).join("")}</optgroup>${
    Object.keys(saved).length ? `<optgroup label="Saved in this browser">${
      Object.keys(saved).map((name) => option(`saved:${encodeURIComponent(name)}`, name)).join("")}</optgroup>` : ""}`;
  $<HTMLButtonElement>("delete-preset").disabled = true;
}

function syncUrl() {
  const url = new URL(location.href);
  url.searchParams.set("recipe", encodeTerrainParam(history.current));
  url.searchParams.set("view", view);
  url.searchParams.set("detail", overlay ? "1" : "0");
  window.history.replaceState(null, "", url);
}

function commit(recipe: TerrainPatchRecipe, { record = true, writeBack = true } = {}) {
  if (record) history.push(recipe);
  // Edits typed into the form keep their text (and caret); undo, presets, reseeding and structure changes rewrite it.
  if (writeBack) writeForm(history.current);
  showError(undefined);
  undoButton.disabled = !history.canUndo;
  redoButton.disabled = !history.canRedo;
  syncUrl();
  runCurrent();
  render();
}

function editFromForm() {
  try {
    const recipe = terrainWorkbenchRecipe(readForm());
    showError(undefined);
    if (history.push(recipe)) commit(recipe, { record: false, writeBack: false });
  } catch (error) {
    // Invalid edits never replace the last valid recipe or its result.
    showError(error instanceof Error ? error.message : String(error));
  }
}

/** A structural edit (shaping kind, adding or removing a layer) applies to the last valid recipe. */
function structural(change: (recipe: TerrainPatchRecipe) => unknown) {
  clearTimeout(editTimer);
  editFromForm();
  try {
    commit(terrainWorkbenchRecipe(change(structuredClone(history.current))));
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0]!;

// ---- rendering -------------------------------------------------------------------------------------------------

function views(recipe: TerrainPatchRecipe): [string, string][] {
  return [["shaded", "Shaded"], ["slope", "Slope"], ["exclusion", "Exclusion"], ...Object.keys(recipe.paint).map((name): [string, string] => [`paint:${name}`, `Paint ${name}`])];
}

/** Draws the 2×2 grid stitched on its shared edges, +X right and +Z down, with detail instances as dots. */
function draw(canvas: HTMLCanvasElement, data: Built | undefined) {
  const context = canvas.getContext("2d")!;
  if (!data) {
    canvas.width = canvas.height = 1;
    context.clearRect(0, 0, 1, 1);
    return;
  }
  const r = data.recipe, [w, d] = r.samples, spanX = 2 * (w - 1) + 1, spanZ = 2 * (d - 1) + 1;
  const metres = new Float32Array(spanX * spanZ), mask = new Uint8Array(spanX * spanZ);
  for (const patch of data.patches) {
    const ox = (patch.patch[0] + 1) * (w - 1), oz = (patch.patch[1] + 1) * (d - 1);
    const source = view === "slope" ? patch.slope : view === "exclusion" ? patch.exclusion : view.startsWith("paint:") ? patch.paint[view.slice(6)] : undefined;
    for (let j = 0; j < d; j += 1) for (let i = 0; i < w; i += 1) {
      const k = (oz + j) * spanX + ox + i;
      metres[k] = r.height.min + patch.heights[j * w + i]! * r.height.precision;
      if (source) mask[k] = source[j * w + i]!;
    }
  }
  const image = new ImageData(spanX, spanZ), at = (i: number, j: number) => metres[Math.min(spanZ - 1, Math.max(0, j)) * spanX + Math.min(spanX - 1, Math.max(0, i))]!;
  const light = [-0.55, 0.7, -0.45], lightLength = Math.hypot(...light);
  for (let j = 0; j < spanZ; j += 1) for (let i = 0; i < spanX; i += 1) {
    const k = j * spanX + i;
    let rgb: [number, number, number];
    if (view === "shaded") {
      const nx = -(at(i + 1, j) - at(i - 1, j)) / (2 * r.sampleSpacing), nz = -(at(i, j + 1) - at(i, j - 1)) / (2 * r.sampleSpacing), n = Math.hypot(nx, 1, nz);
      const shade = Math.max(0.15, (nx * light[0]! + light[1]! + nz * light[2]!) / (n * lightLength));
      const t = Math.min(1, Math.max(0, (metres[k]! - r.height.min) / (r.height.max - r.height.min)));
      rgb = [(70 + 150 * t) * shade, (88 + 120 * t) * shade, (52 + 110 * t) * shade];
    } else rgb = [mask[k]!, mask[k]!, mask[k]!];
    image.data.set([rgb[0], rgb[1], rgb[2], 255], k * 4);
  }
  const scale = Math.max(1, Math.min(8, Math.floor(720 / Math.max(spanX, spanZ))));
  canvas.width = spanX * scale;
  canvas.height = spanZ * scale;
  const base = document.createElement("canvas");
  base.width = spanX;
  base.height = spanZ;
  base.getContext("2d")!.putImageData(image, 0, 0);
  context.imageSmoothingEnabled = false;
  context.drawImage(base, 0, 0, canvas.width, canvas.height);
  // Patch seams, so the shared edges can be checked.
  context.strokeStyle = "rgba(255,255,255,.25)";
  context.beginPath();
  context.moveTo((w - 1 + 0.5) * scale, 0); context.lineTo((w - 1 + 0.5) * scale, canvas.height);
  context.moveTo(0, (d - 1 + 0.5) * scale); context.lineTo(canvas.width, (d - 1 + 0.5) * scale);
  context.stroke();
  if (!overlay) return;
  const x0 = r.origin[0] - (w - 1) * r.sampleSpacing, z0 = r.origin[1] - (d - 1) * r.sampleSpacing;
  const radius = Math.max(0.6, scale * 0.22);
  r.detail.forEach((layer, index) => {
    context.fillStyle = LAYER_COLORS[index % LAYER_COLORS.length]!;
    for (const patch of data.patches) for (const instance of patch.detail) {
      if (instance.layer !== layer.id) continue;
      const px = ((instance.position[0] - x0) / r.sampleSpacing + 0.5) * scale, pz = ((instance.position[2] - z0) / r.sampleSpacing + 0.5) * scale;
      context.fillRect(px - radius, pz - radius, radius * 2, radius * 2);
    }
  });
}

function render() {
  const recipe = current?.recipe ?? history.current;
  const available = views(recipe);
  if (!available.some(([id]) => id === view)) view = "shaded";
  $("view-buttons").innerHTML = available.map(([id, label], i) =>
    `<button type="button" data-view="${escape(id)}" aria-pressed="${id === view}" title="Key ${i + 1}">${escape(label)}</button>`).join("");
  overlayButton.setAttribute("aria-pressed", String(overlay));
  const fresh = current !== undefined && terrainRecipeKey(current.recipe) === terrainRecipeKey(history.current);
  draw(currentCanvas, current);
  currentCanvas.dataset.stale = String(!fresh);
  $("current-caption").textContent = fresh ? "Current" : "Current (last valid build; the latest recipe has not built)";
  acceptedFigure.hidden = !(compareToggle.checked && accepted);
  draw(acceptedCanvas, compareToggle.checked && accepted ? acceptedBuilt : undefined);

  $("legend").innerHTML = current ? current.recipe.detail.map((layer, i) => {
    const count = current!.patches.reduce((sum, p) => sum + p.detail.filter((d) => d.layer === layer.id).length, 0);
    return `<li><i style="background:${LAYER_COLORS[i % LAYER_COLORS.length]}"></i>${escape(layer.id)}: ${count.toLocaleString("en-US")}</li>`;
  }).join("") : "";

  const changed = current && accepted ? changedComponents(accepted.identities, current.identities) : undefined;
  $<HTMLButtonElement>("accept").disabled = !fresh || changed?.length === 0;
  $<HTMLButtonElement>("reset").disabled = !accepted || terrainRecipeKey(accepted.recipe) === terrainRecipeKey(history.current);
  if (!current) approval.textContent = "Technical: building…";
  else if (!fresh) approval.textContent = "Technical: the latest recipe has not built. Nothing new can be accepted.";
  else if (!accepted) approval.textContent = "Technical: valid recipe, all four patches built. Not accepted yet.";
  else if (changed!.length === 0) approval.textContent = "Accepted: these exact component outputs are the accepted baseline.";
  else approval.textContent = `Changed since accepted: ${changed!.join(", ")}. Accept again or reset.`;
  approval.dataset.state = !current || !fresh ? "" : !accepted ? "valid" : changed!.length === 0 ? "accepted" : "changed";

  const names = current ? Object.keys(current.patches[0]!.record.components) : [];
  componentsBody.innerHTML = names.map((name) => {
    const executed = lastBuild?.executed[name] ?? 0, reused = lastBuild?.reused[name] ?? 0;
    const state = executed && reused ? `executed ×${executed}, reused ×${reused}` : executed ? `executed ×${executed}` : `reused ×${reused}`;
    const diff = !accepted ? "–" : accepted.identities[name] === undefined ? "new" : accepted.identities[name] === current!.identities[name] ? "same" : "changed";
    const key = current!.patches[0]!.record.components[name]!.key;
    return `<tr data-refused="${name === refused}"><td><code title="key sha256:${key}">${escape(name)}</code></td><td data-status="${executed ? "executed" : "reused"}">${state}</td>`
      + `<td data-diff="${diff}">${diff}</td><td><input type="checkbox" data-keep="${escape(name)}" aria-label="Keep ${escape(name)}"${keptComponents.has(name) ? " checked" : ""}></td></tr>`;
  }).join("");
  $("cli").textContent = "bun examples/terrain-patches/build.ts .artifacts/terrain-workbench recipe.json";
}

// ---- actions ---------------------------------------------------------------------------------------------------

function download(name: string, blob: Blob) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function loadPreset(value: string) {
  let recipe: unknown;
  if (value.startsWith("builtin:")) recipe = builtInPresets[value.slice(8)];
  if (value.startsWith("saved:")) recipe = readJson<Record<string, TerrainPatchRecipe>>(STORAGE_PRESETS)?.[decodeURIComponent(value.slice(6))];
  if (!recipe) return;
  try {
    // Locked seeds survive a preset: the height seed always, a layer seed when the preset has a layer at that index.
    const next = terrainWorkbenchRecipe(structuredClone(recipe));
    commit(terrainWorkbenchRecipe({
      ...next,
      seed: lockedSeeds.has("seed") ? history.current.seed : next.seed,
      detail: next.detail.map((layer, i) => ({ ...layer, seed: lockedSeeds.has(`detail.${i}.seed`) && history.current.detail[i] ? history.current.detail[i]!.seed : layer.seed })),
    }));
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

function reseed(only?: string) {
  const fields = terrainSeedFields(history.current);
  const locked = new Set(only ? fields.filter((field) => field !== only) : fields.filter((field) => lockedSeeds.has(field)));
  if (only && lockedSeeds.has(only)) return;
  commit(reseedTerrainRecipe(history.current, locked, randomSeed));
}

const defaultShaping = (kind: string, recipe: TerrainPatchRecipe): TerrainShaping =>
  kind === "island" ? { kind, center: [...recipe.origin], radius: 30, falloff: 34, seaLevel: Math.max(recipe.height.min, -2) }
    : kind === "terrace" ? { kind, step: 2.5, sharpness: 0.7 } : { kind: "noise" };

let editTimer: ReturnType<typeof setTimeout> | undefined;
form.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.name === "shaping.kind" || target.dataset.seedLock) return;
  clearTimeout(editTimer);
  editTimer = setTimeout(editFromForm, 150);
});
form.addEventListener("change", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.name === "shaping.kind") structural((recipe) => ({ ...recipe, shaping: defaultShaping(target.value, recipe) }));
  else if (target.dataset.seedLock) {
    if (target.checked) lockedSeeds.add(target.dataset.seedLock); else lockedSeeds.delete(target.dataset.seedLock);
    syncSeedLocks();
  }
});
form.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest("button");
  if (!button) return;
  if (button.dataset.reseed) reseed(button.dataset.reseed);
  if (button.dataset.removeLayer) {
    const index = Number(button.dataset.removeLayer);
    structural((recipe: TerrainPatchRecipe) => ({ ...recipe, detail: recipe.detail.filter((_, i) => i !== index) }));
  }
});
form.addEventListener("submit", (event) => { event.preventDefault(); clearTimeout(editTimer); editFromForm(); });
$<HTMLButtonElement>("add-layer").addEventListener("click", () => structural((recipe: TerrainPatchRecipe) => {
  let n = recipe.detail.length + 1;
  while (recipe.detail.some((layer) => layer.id === `layer-${n}`)) n += 1;
  const layer: TerrainDetailLayer = { id: `layer-${n}`, seed: randomSeed(), density: 0.2, minSpacing: 1.5, slopeDegrees: [0, 30], height: [recipe.height.min, recipe.height.max],
    maxExclusion: 0.5, paint: null, scale: [0.8, 1.2], variants: 3 };
  return { ...recipe, detail: [...recipe.detail, layer] };
}));
$<HTMLButtonElement>("reseed-all").addEventListener("click", () => reseed());
presetSelect.addEventListener("change", () => {
  $<HTMLButtonElement>("delete-preset").disabled = !presetSelect.value.startsWith("saved:");
  loadPreset(presetSelect.value);
});
undoButton.addEventListener("click", () => { const recipe = history.undo(); if (recipe) commit(recipe, { record: false }); });
redoButton.addEventListener("click", () => { const recipe = history.redo(); if (recipe) commit(recipe, { record: false }); });
cancelButton.addEventListener("click", () => {
  currentRunner.cancel();
  status.textContent = "Cancelled. The last finished result stays; edit or press Rebuild to run again (from a cold build).";
});
$<HTMLButtonElement>("rebuild").addEventListener("click", runCurrent);
$("view-buttons").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-view]");
  if (button) { view = button.dataset.view!; syncUrl(); render(); }
});
overlayButton.addEventListener("click", () => { overlay = !overlay; syncUrl(); render(); });
compareToggle.addEventListener("change", render);
componentsBody.addEventListener("change", (event) => {
  const box = event.target as HTMLInputElement;
  if (!box.dataset.keep) return;
  if (box.checked) keptComponents.add(box.dataset.keep); else keptComponents.delete(box.dataset.keep);
  // Releasing a refused component lets the waiting recipe build.
  if (!box.checked && refused === box.dataset.keep) runCurrent();
});
$<HTMLButtonElement>("accept").addEventListener("click", () => {
  if (!current) return;
  accepted = { recipe: current.recipe, identities: current.identities };
  acceptedBuilt = current;
  savedKey = terrainRecipeKey(current.recipe);
  writeJson(STORAGE_ACCEPTED, accepted);
  render();
});
$<HTMLButtonElement>("reset").addEventListener("click", () => { if (accepted) commit(accepted.recipe); });
$<HTMLButtonElement>("save-preset").addEventListener("click", () => {
  const name = prompt("Preset name", "")?.trim();
  if (!name) return;
  const saved = readJson<Record<string, TerrainPatchRecipe>>(STORAGE_PRESETS) ?? {};
  saved[name] = history.current;
  writeJson(STORAGE_PRESETS, saved);
  presetOptions();
});
$<HTMLButtonElement>("delete-preset").addEventListener("click", () => {
  if (!presetSelect.value.startsWith("saved:")) return;
  const saved = readJson<Record<string, TerrainPatchRecipe>>(STORAGE_PRESETS) ?? {};
  delete saved[decodeURIComponent(presetSelect.value.slice(6))];
  writeJson(STORAGE_PRESETS, saved);
  presetOptions();
});
$<HTMLButtonElement>("export-recipe").addEventListener("click", () => {
  savedKey = terrainRecipeKey(history.current);
  download("recipe.json", new Blob([JSON.stringify(history.current, null, 2) + "\n"], { type: "application/json" }));
});
$<HTMLButtonElement>("export-png").addEventListener("click", () => {
  currentCanvas.toBlob((blob) => blob && download(`terrain-${view.replace(":", "-")}.png`, blob), "image/png");
});

document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  const typing = target instanceof HTMLInputElement && target.type !== "checkbox" || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && !typing && event.key.toLowerCase() === "z") {
    event.preventDefault();
    (event.shiftKey ? redoButton : undoButton).click();
  } else if (mod && !typing && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redoButton.click();
  } else if (!mod && !typing && !event.altKey) {
    const index = Number(event.key) - 1, available = views(current?.recipe ?? history.current);
    if (Number.isInteger(index) && index >= 0 && index < available.length) { view = available[index]![0]; syncUrl(); render(); }
    else if (event.key === "r") reseed();
    else if (event.key === "d") overlayButton.click();
    else if (event.key === "Escape") cancelButton.click();
  }
});
window.addEventListener("beforeunload", (event) => {
  if (terrainRecipeKey(history.current) !== savedKey && terrainRecipeKey(history.current) !== (accepted && terrainRecipeKey(accepted.recipe))) {
    event.preventDefault();
  }
});

presetOptions();
commit(history.current, { record: false });
if (accepted) {
  acceptedRequested = accepted.recipe;
  acceptedRunner.run({ recipe: accepted.recipe, preserve: [] });
}
