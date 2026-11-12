// Texture workbench (#127, docs/texture-workbench.md): direct controls over one tileable surface recipe. Edits run
// the recipe's own kernels in a Web Worker (texture-workbench-worker.ts); only the latest request may update the
// page, invalid edits keep the last valid result, and the recipe lives in the URL so a reload restores it.
import { SURFACE_TEXTURE_PRESETS, type SurfaceTextureRecipe } from "../surface-texture-kernels.js";
import { TEXTURE_CHANNELS, type TextureChannel } from "./texture-workbench-compute.js";
import {
  decodeRecipeParam, encodeRecipeParam, fieldForError, RecipeHistory, recipeKey, WORKBENCH_FIELDS,
  workbenchRecipe, type WorkbenchField,
} from "./texture-workbench-state.js";
import type { WorkbenchChannelResult, WorkbenchResult } from "./texture-workbench-worker.js";
import { WorkbenchRunner } from "./workbench-runner.js";

type Channels = Record<TextureChannel, WorkbenchChannelResult>;
type Accepted = { recipe: SurfaceTextureRecipe; sha256: Record<TextureChannel, string> };

const STORAGE_ACCEPTED = "asset-tooling.texture-workbench.accepted.v1";
const STORAGE_PRESETS = "asset-tooling.texture-workbench.presets.v1";
const DEFAULT_PRESET = "soil-fine";
const builtInPresets = SURFACE_TEXTURE_PRESETS as unknown as Record<string, SurfaceTextureRecipe>;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("recipe");
const status = $<HTMLParagraphElement>("status");
const stagesLine = $<HTMLParagraphElement>("stages");
const cancelButton = $<HTMLButtonElement>("cancel");
const undoButton = $<HTMLButtonElement>("undo");
const redoButton = $<HTMLButtonElement>("redo");
const presetSelect = $<HTMLSelectElement>("preset");
const seedLock = $<HTMLInputElement>("seed-lock");
const reseedButton = $<HTMLButtonElement>("reseed");
const furrowsToggle = $<HTMLInputElement>("furrows");
const currentCanvas = $<HTMLCanvasElement>("current");
const acceptedCanvas = $<HTMLCanvasElement>("accepted");
const acceptedFigure = $<HTMLElement>("accepted-figure");
const approval = $<HTMLParagraphElement>("approval");
const identityList = $<HTMLDListElement>("identity");
const compareToggle = $<HTMLInputElement>("compare");

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

// ---- recipe <-> form -------------------------------------------------------------------------------------------

const hex = (rgb: readonly number[]) => "#" + rgb.map((byte) => byte.toString(16).padStart(2, "0")).join("");
function rgbFromHex(value: string): unknown {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim());
  return match ? match.slice(1).map((part) => parseInt(part, 16)) : value;
}
function field(name: WorkbenchField) {
  return form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
}
function numberValue(name: WorkbenchField): unknown {
  const text = field(name).value.trim();
  return text === "" || !/^-?[0-9]+$/.test(text) ? text : Number(text);
}

function writeForm(recipe: SurfaceTextureRecipe) {
  for (const name of ["seed", "width", "height", "gridX", "gridY", "detailGridX", "detailGridY", "detailWeight",
    "heightMin", "heightMax", "normalStrength", "roughnessMin", "roughnessMax"] as const) {
    field(name).value = String(recipe[name]);
  }
  furrowsToggle.checked = Boolean(recipe.furrows);
  const furrows = recipe.furrows ?? { axis: "x", count: 4, depth: 160, softness: 2 };
  field("furrowAxis").value = furrows.axis;
  field("furrowCount").value = String(furrows.count);
  field("furrowDepth").value = String(furrows.depth);
  field("furrowSoftness").value = String(furrows.softness);
  syncFurrows();
  for (const name of ["low", "high"] as const) {
    field(name).value = hex(recipe[name]);
    ($<HTMLInputElement>(`${name}-swatch`)).value = hex(recipe[name]);
  }
}

function readForm(): unknown {
  return {
    schemaVersion: 1, seamMode: "repeat", seed: field("seed").value.trim(),
    width: numberValue("width"), height: numberValue("height"),
    gridX: numberValue("gridX"), gridY: numberValue("gridY"),
    detailGridX: numberValue("detailGridX"), detailGridY: numberValue("detailGridY"), detailWeight: numberValue("detailWeight"),
    heightMin: numberValue("heightMin"), heightMax: numberValue("heightMax"),
    ...(furrowsToggle.checked ? { furrows: {
      axis: field("furrowAxis").value, count: numberValue("furrowCount"),
      depth: numberValue("furrowDepth"), softness: numberValue("furrowSoftness"),
    } } : {}),
    low: rgbFromHex(field("low").value), high: rgbFromHex(field("high").value),
    normalStrength: numberValue("normalStrength"), roughnessMin: numberValue("roughnessMin"), roughnessMax: numberValue("roughnessMax"),
  };
}

function syncFurrows() {
  for (const name of ["furrowAxis", "furrowCount", "furrowDepth", "furrowSoftness"] as const) field(name).disabled = !furrowsToggle.checked;
}

function showError(message: string | undefined) {
  for (const name of WORKBENCH_FIELDS) {
    const slot = $(`error-${name}`);
    slot.textContent = "";
    field(name).removeAttribute("aria-invalid");
  }
  $("error-form").textContent = "";
  if (!message) return;
  const name = fieldForError(message);
  const slot = name ? $(`error-${name}`) : $("error-form");
  slot.textContent = message;
  if (name) field(name).setAttribute("aria-invalid", "true");
}

// ---- state -----------------------------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const initial = decodeRecipeParam(params.get("recipe")) ?? workbenchRecipe(structuredClone(builtInPresets[DEFAULT_PRESET]));
const history = new RecipeHistory(initial);
let current: Channels | undefined;
let currentRecipeKey = "";
let acceptedChannels: Channels | undefined;
let accepted = readJson<Accepted>(STORAGE_ACCEPTED);
let savedKey = recipeKey(initial);
let channel: TextureChannel = TEXTURE_CHANNELS.includes(params.get("channel") as TextureChannel) ? params.get("channel") as TextureChannel : "color";
let tiled = params.get("tile") !== "1";
try { if (accepted) accepted.recipe = workbenchRecipe(accepted.recipe); } catch { accepted = undefined; }

const newRunner = (onResult: (result: WorkbenchResult) => void, onBusy: (busy: boolean) => void) =>
  new WorkbenchRunner<{ recipe: SurfaceTextureRecipe }, WorkbenchResult>("./worker.js", onResult, onBusy);
const currentRunner = newRunner((result) => {
  if (!result.ok) {
    status.dataset.state = "error";
    status.textContent = `Preview failed: ${result.error}. The last valid result stays.`;
    return;
  }
  current = result.channels;
  currentRecipeKey = recipeKey(history.current);
  status.dataset.state = "";
  status.textContent = `Built ${current.color.width}×${current.color.height} px in ${result.milliseconds} ms.`;
  stagesLine.textContent = result.stages.map((stage) => `${stage.channel} ${stage.status}`).join(" · ");
  render();
}, (busy) => {
  cancelButton.hidden = !busy;
  if (busy) { status.dataset.state = ""; status.textContent = "Building…"; }
});
const acceptedRunner = newRunner((result) => {
  if (result.ok) acceptedChannels = result.channels;
  render();
}, () => undefined);

function presetOptions() {
  const saved = readJson<Record<string, SurfaceTextureRecipe>>(STORAGE_PRESETS) ?? {};
  const option = (value: string, label: string) => `<option value="${value}">${label.replace(/[<&"]/g, "")}</option>`;
  presetSelect.innerHTML = `<option value="">Choose a preset…</option><optgroup label="Recipe presets">${
    Object.keys(builtInPresets).map((name) => option(`builtin:${name}`, name)).join("")}</optgroup>${
    Object.keys(saved).length ? `<optgroup label="Saved in this browser">${
      Object.keys(saved).map((name) => option(`saved:${encodeURIComponent(name)}`, name)).join("")}</optgroup>` : ""}`;
  $<HTMLButtonElement>("delete-preset").disabled = true;
}

function syncUrl() {
  const url = new URL(location.href);
  url.searchParams.set("recipe", encodeRecipeParam(history.current));
  url.searchParams.set("channel", channel);
  url.searchParams.set("tile", tiled ? "3" : "1");
  window.history.replaceState(null, "", url);
}

function commit(recipe: SurfaceTextureRecipe, { record = true, writeBack = true } = {}) {
  if (record) history.push(recipe);
  // Edits typed into the form keep their text (and caret); undo, presets and reseeding rewrite it.
  if (writeBack) writeForm(history.current);
  showError(undefined);
  undoButton.disabled = !history.canUndo;
  redoButton.disabled = !history.canRedo;
  syncUrl();
  currentRunner.run({ recipe: history.current });
  render();
}

function editFromForm() {
  try {
    const recipe = workbenchRecipe(readForm());
    showError(undefined);
    if (history.push(recipe)) commit(recipe, { record: false, writeBack: false });
  } catch (error) {
    // Invalid edits never replace the last valid recipe or its result.
    showError(error instanceof Error ? error.message : String(error));
  }
}

// ---- rendering -------------------------------------------------------------------------------------------------

function draw(canvas: HTMLCanvasElement, image: WorkbenchChannelResult | undefined) {
  const context = canvas.getContext("2d")!;
  if (!image) {
    canvas.width = canvas.height = 1;
    context.clearRect(0, 0, 1, 1);
    return;
  }
  const repeat = tiled ? 3 : 1;
  canvas.width = image.width * repeat;
  canvas.height = image.height * repeat;
  const data = new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height);
  for (let y = 0; y < repeat; y += 1) for (let x = 0; x < repeat; x += 1) context.putImageData(data, x * image.width, y * image.height);
}

function changedChannels(): TextureChannel[] | undefined {
  if (!accepted || !current) return undefined;
  return TEXTURE_CHANNELS.filter((name) => accepted!.sha256[name] !== current![name].sha256);
}

function render() {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-channel]")) {
    button.setAttribute("aria-pressed", String(button.dataset.channel === channel));
  }
  $<HTMLButtonElement>("tile").setAttribute("aria-pressed", String(tiled));
  const fresh = current && currentRecipeKey === recipeKey(history.current);
  draw(currentCanvas, current?.[channel]);
  currentCanvas.dataset.stale = String(!fresh);
  acceptedFigure.hidden = !(compareToggle.checked && accepted);
  draw(acceptedCanvas, compareToggle.checked ? acceptedChannels?.[channel] : undefined);

  const changed = changedChannels();
  $<HTMLButtonElement>("accept").disabled = !fresh || changed?.length === 0;
  $<HTMLButtonElement>("reset").disabled = !accepted || recipeKey(accepted.recipe) === recipeKey(history.current);
  if (!current) approval.textContent = "Technical: building…";
  else if (!accepted) approval.textContent = "Technical: valid recipe, all four channels built. Not accepted yet.";
  else if (changed!.length === 0) approval.textContent = "Accepted: these exact channel bytes are the accepted baseline.";
  else approval.textContent = `Changed since accepted: ${changed!.join(", ")} differ from the accepted baseline. Accept again or reset.`;
  approval.dataset.state = !current ? "" : !accepted ? "valid" : changed!.length === 0 ? "accepted" : "changed";

  identityList.innerHTML = current ? TEXTURE_CHANNELS.map((name) => {
    const image = current![name];
    const differs = accepted && accepted.sha256[name] !== image.sha256 ? " · changed" : "";
    return `<dt>${name}</dt><dd><code title="${image.sha256}">sha256:${image.sha256.slice(0, 16)}…</code> ${image.width}×${image.height} px, ${image.byteLength.toLocaleString("en-US")} bytes${differs}</dd>`;
  }).join("") : "";
  $("cli").textContent = `bun scripts/build-surface-texture.ts recipe.json .artifacts/texture-workbench`;
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
  let recipe: SurfaceTextureRecipe | undefined;
  if (value.startsWith("builtin:")) recipe = builtInPresets[value.slice(8)];
  if (value.startsWith("saved:")) recipe = readJson<Record<string, SurfaceTextureRecipe>>(STORAGE_PRESETS)?.[decodeURIComponent(value.slice(6))];
  if (!recipe) return;
  try {
    const next = workbenchRecipe({ ...structuredClone(recipe), ...(seedLock.checked ? { seed: history.current.seed } : {}) });
    commit(next);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

function reseed() {
  if (seedLock.checked) return;
  const seed = String(crypto.getRandomValues(new Uint32Array(1))[0]);
  commit(workbenchRecipe({ ...history.current, seed }));
}

let editTimer: ReturnType<typeof setTimeout> | undefined;
form.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.id.endsWith("-swatch")) field(target.id.replace("-swatch", "") as WorkbenchField).value = target.value;
  if ((target.name === "low" || target.name === "high") && Array.isArray(rgbFromHex(target.value))) {
    $<HTMLInputElement>(`${target.name}-swatch`).value = hex(rgbFromHex(target.value) as number[]);
  }
  if (target === furrowsToggle) syncFurrows();
  clearTimeout(editTimer);
  editTimer = setTimeout(editFromForm, 120);
});
form.addEventListener("submit", (event) => { event.preventDefault(); clearTimeout(editTimer); editFromForm(); });
presetSelect.addEventListener("change", () => {
  $<HTMLButtonElement>("delete-preset").disabled = !presetSelect.value.startsWith("saved:");
  loadPreset(presetSelect.value);
});
seedLock.addEventListener("change", () => { reseedButton.disabled = seedLock.checked; field("seed").readOnly = seedLock.checked; });
reseedButton.addEventListener("click", reseed);
undoButton.addEventListener("click", () => { const recipe = history.undo(); if (recipe) commit(recipe, { record: false }); });
redoButton.addEventListener("click", () => { const recipe = history.redo(); if (recipe) commit(recipe, { record: false }); });
cancelButton.addEventListener("click", () => {
  currentRunner.cancel();
  status.textContent = "Cancelled. The last finished result stays; edit or press Rebuild to run again.";
});
$<HTMLButtonElement>("rebuild").addEventListener("click", () => currentRunner.run({ recipe: history.current }));
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-channel]")) {
  button.addEventListener("click", () => { channel = button.dataset.channel as TextureChannel; syncUrl(); render(); });
}
$<HTMLButtonElement>("tile").addEventListener("click", () => { tiled = !tiled; syncUrl(); render(); });
compareToggle.addEventListener("change", render);
$<HTMLButtonElement>("accept").addEventListener("click", () => {
  if (!current) return;
  accepted = { recipe: history.current, sha256: Object.fromEntries(TEXTURE_CHANNELS.map((name) => [name, current![name].sha256])) as Accepted["sha256"] };
  acceptedChannels = current;
  savedKey = recipeKey(history.current);
  writeJson(STORAGE_ACCEPTED, accepted);
  render();
});
$<HTMLButtonElement>("reset").addEventListener("click", () => { if (accepted) commit(accepted.recipe); });
$<HTMLButtonElement>("save-preset").addEventListener("click", () => {
  const name = prompt("Preset name", "")?.trim();
  if (!name) return;
  const saved = readJson<Record<string, SurfaceTextureRecipe>>(STORAGE_PRESETS) ?? {};
  saved[name] = history.current;
  writeJson(STORAGE_PRESETS, saved);
  presetOptions();
});
$<HTMLButtonElement>("delete-preset").addEventListener("click", () => {
  if (!presetSelect.value.startsWith("saved:")) return;
  const saved = readJson<Record<string, SurfaceTextureRecipe>>(STORAGE_PRESETS) ?? {};
  delete saved[decodeURIComponent(presetSelect.value.slice(6))];
  writeJson(STORAGE_PRESETS, saved);
  presetOptions();
});
$<HTMLButtonElement>("export-recipe").addEventListener("click", () => {
  savedKey = recipeKey(history.current);
  download("recipe.json", new Blob([JSON.stringify(history.current, null, 2) + "\n"], { type: "application/json" }));
});
$<HTMLButtonElement>("export-png").addEventListener("click", () => {
  if (!current) return;
  const image = current[channel];
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height), 0, 0);
  canvas.toBlob((blob) => blob && download(`${channel}-preview.png`, blob), "image/png");
});

document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  const typing = target instanceof HTMLInputElement && target.type !== "checkbox" || target instanceof HTMLTextAreaElement;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && !typing && event.key.toLowerCase() === "z") {
    event.preventDefault();
    (event.shiftKey ? redoButton : undoButton).click();
  } else if (mod && !typing && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redoButton.click();
  } else if (!mod && !typing && !event.altKey) {
    const index = ["1", "2", "3", "4"].indexOf(event.key);
    if (index >= 0) { channel = TEXTURE_CHANNELS[index]!; syncUrl(); render(); }
    else if (event.key === "r") reseed();
    else if (event.key === "t") $<HTMLButtonElement>("tile").click();
    else if (event.key === "Escape") cancelButton.click();
  }
});
window.addEventListener("beforeunload", (event) => {
  if (recipeKey(history.current) !== savedKey && recipeKey(history.current) !== (accepted && recipeKey(accepted.recipe))) {
    event.preventDefault();
  }
});

presetOptions();
commit(history.current, { record: false });
if (accepted) acceptedRunner.run({ recipe: accepted.recipe });
