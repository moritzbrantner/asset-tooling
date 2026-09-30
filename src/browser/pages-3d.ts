import {
  BrowserSf3dPipeline,
  clearBrowserSf3dCache,
  exportBrowserMeshGlb,
} from "./sf3d-webgpu.js";
import { BROWSER_SF3D_MODEL } from "./sf3d-model-manifest.js";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector(selector);
  if (!element) throw new Error("Missing browser studio element " + selector);
  return element as T;
}

const fileInput = requiredElement<HTMLInputElement>("#source-image");
const prepareButton = requiredElement<HTMLButtonElement>("#prepare-model");
const generateButton = requiredElement<HTMLButtonElement>("#generate");
const clearCacheButton = requiredElement<HTMLButtonElement>("#clear-model-cache");
const sourcePreview = requiredElement<HTMLImageElement>("#source-preview");
const sourceEmpty = requiredElement<HTMLElement>("#source-empty");
const modelProgress = requiredElement<HTMLProgressElement>("#model-progress");
const status = requiredElement<HTMLElement>("#status");
const runtime = requiredElement<HTMLElement>("#runtime");
const resultViewer = requiredElement<HTMLElement>("model-viewer#result-viewer") as HTMLElement & {
  src: string;
};
const resultEmpty = requiredElement<HTMLElement>("#result-empty");
const resultSummary = requiredElement<HTMLElement>("#result-summary");
const download = requiredElement<HTMLAnchorElement>("#download-glb");

const pipeline = new BrowserSf3dPipeline();
let sourceFile: File | undefined;
let sourceUrl: string | undefined;
let resultUrl: string | undefined;
let preparing = false;
let generating = false;

function setStatus(message: string, error = false): void {
  status.textContent = message;
  status.dataset.state = error ? "error" : "normal";
}

function updateActions(): void {
  prepareButton.disabled = preparing || generating || pipeline.loaded;
  generateButton.disabled = preparing || generating || !pipeline.loaded || !sourceFile;
  clearCacheButton.disabled = preparing || generating;
}

function setSource(file: File): void {
  if (!file.type.startsWith("image/")) {
    setStatus("Choose a PNG, JPEG, or other browser-readable image.", true);
    return;
  }
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceFile = file;
  sourceUrl = URL.createObjectURL(file);
  sourcePreview.src = sourceUrl;
  sourcePreview.hidden = false;
  sourceEmpty.hidden = true;
  setStatus(
    "Image ready. Transparent alpha is preserved; opaque near-white borders use the shared deterministic matte.",
  );
  updateActions();
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) setSource(file);
});

const dropZone = requiredElement<HTMLElement>("#source-zone");
for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.dataset.drag = "true";
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    delete dropZone.dataset.drag;
  });
}
dropZone.addEventListener("drop", (event) => {
  const dropped = (event as DragEvent).dataTransfer?.files?.[0];
  if (dropped) setSource(dropped);
});

prepareButton.addEventListener("click", async () => {
  if (preparing || pipeline.loaded) return;
  preparing = true;
  updateActions();
  modelProgress.hidden = false;
  modelProgress.value = 0;
  try {
    await pipeline.load((stage, fraction, detail) => {
      modelProgress.value = Math.max(0, Math.min(1, fraction));
      setStatus(stage + (detail ? " · " + detail : ""));
    });
    const diagnostics = pipeline.gpuDiagnostics;
    runtime.textContent =
      (diagnostics?.adapterInfo ?? "WebGPU") +
      " · shader-f16 · model " +
      BROWSER_SF3D_MODEL.revision.slice(0, 12);
    setStatus("Model prepared. Future visits reuse only hash-verified cached artifacts.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    preparing = false;
    updateActions();
  }
});

generateButton.addEventListener("click", async () => {
  if (!sourceFile || !pipeline.loaded || generating) return;
  generating = true;
  updateActions();
  download.hidden = true;
  resultSummary.textContent = "";
  try {
    const generated = await pipeline.generate(sourceFile, (stage, fraction, detail) => {
      modelProgress.hidden = false;
      modelProgress.value = Math.max(0, Math.min(1, fraction));
      setStatus(stage + (detail ? " · " + detail : ""));
    });
    setStatus("Encoding GLB locally…");
    const glb = await exportBrowserMeshGlb(generated.mesh);
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(
      new Blob([glb], { type: "model/gltf-binary" }),
    );
    resultViewer.src = resultUrl;
    resultViewer.hidden = false;
    resultEmpty.hidden = true;
    const triangleCount = Number(generated.observations.triangleCount ?? 0);
    const vertexCount = Number(generated.observations.vertexCount ?? 0);
    resultSummary.textContent =
      vertexCount.toLocaleString() +
      " vertices · " +
      triangleCount.toLocaleString() +
      " triangles · " +
      String(generated.observations.preprocessMode);
    const baseName = sourceFile.name.replace(/\.[^.]+$/, "") || "asset";
    download.href = resultUrl;
    download.download = baseName + ".glb";
    download.hidden = false;
    setStatus("Generation complete. No source image or generated mesh was uploaded.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    generating = false;
    updateActions();
  }
});

clearCacheButton.addEventListener("click", async () => {
  clearCacheButton.disabled = true;
  try {
    const cleared = await clearBrowserSf3dCache();
    setStatus(
      cleared
        ? "Cached SF3D model artifacts cleared. The in-memory model remains usable until this page is reloaded."
        : "No browser model cache was present.",
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    updateActions();
  }
});

updateActions();
