// Texture workbench (#127, docs/texture-workbench.md): the browser preview runs the surface recipe's own kernels, so
// its channel identities equal the CLI build's AssetRefs; stages are reused only when their inputs are unchanged.
import { expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { encodeRgba8Image } from "../src/image-rgba8.js";
import { sha256Bytes } from "../src/hash.js";
import { executeSurfaceTextureRecipe, SURFACE_TEXTURE_PRESETS, type SurfaceTextureRecipe } from "../src/surface-texture-recipes.js";
import { TEXTURE_CHANNELS, TextureWorkbenchSession } from "../src/browser/texture-workbench-compute.js";
import {
  decodeRecipeParam, encodeRecipeParam, fieldForError, LatestRequest, RecipeHistory, WORKBENCH_FIELDS, workbenchRecipe,
} from "../src/browser/texture-workbench-state.js";
import { renderTextureWorkbenchHtml, writeTextureWorkbenchPage } from "../src/texture-workbench-page.js";

const small = (name: keyof typeof SURFACE_TEXTURE_PRESETS, overrides: Partial<SurfaceTextureRecipe> = {}): SurfaceTextureRecipe => {
  const preset = structuredClone(SURFACE_TEXTURE_PRESETS[name]) as SurfaceTextureRecipe;
  const clamp = (value: number) => Math.min(value, 48);
  return workbenchRecipe({ ...preset, width: 48, height: 48, gridX: clamp(preset.gridX), gridY: clamp(preset.gridY),
    detailGridX: clamp(preset.detailGridX), detailGridY: clamp(preset.detailGridY), ...overrides });
};

test("workbench channels hash like the CLI recipe's AssetRefs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "texture-workbench-"));
  try {
    for (const recipe of [small("soil-tilled-deep"), small("wood-long-grain"), small("sand-rippled", { detailWeight: 0, heightMin: 40 })]) {
      const cli = await executeSurfaceTextureRecipe(root, recipe);
      const { images } = new TextureWorkbenchSession().run(recipe);
      for (const channel of TEXTURE_CHANNELS) {
        expect(sha256Bytes(encodeRgba8Image(images[channel]))).toBe(cli.outputs[channel]!.sha256);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only stages whose inputs changed run again", () => {
  const session = new TextureWorkbenchSession();
  const base = small("rock-grainy");
  const executed = (recipe: SurfaceTextureRecipe) =>
    session.run(recipe).stages.filter((stage) => stage.status === "executed").map((stage) => stage.channel);
  expect(executed(base)).toEqual(["height", "color", "normal", "roughness"]);
  expect(executed(base)).toEqual([]);
  expect(executed({ ...base, low: [10, 20, 30] })).toEqual(["color"]);
  expect(executed({ ...base, low: [10, 20, 30], normalStrength: 7 })).toEqual(["normal"]);
  expect(executed({ ...base, low: [10, 20, 30], normalStrength: 7, roughnessMax: 250 })).toEqual(["roughness"]);
  expect(executed({ ...base, low: [10, 20, 30], normalStrength: 7, roughnessMax: 250, seed: "43" })).toEqual(["height", "color", "normal", "roughness"]);
});

test("recipe URL state round-trips and rejects invalid values", () => {
  const recipe = small("soil-tilled-crosswise");
  const encoded = encodeRecipeParam(recipe);
  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(decodeRecipeParam(encoded)).toEqual(recipe);
  expect(decodeRecipeParam(null)).toBeUndefined();
  expect(decodeRecipeParam("not-base64!")).toBeUndefined();
  expect(decodeRecipeParam(encodeRecipeParam({ ...recipe, gridX: 0 }))).toBeUndefined();
  expect(() => workbenchRecipe({ ...recipe, width: 4096, gridX: 8, detailGridX: 8 })).toThrow(/at most 2048/);
});

test("undo and redo walk valid recipes; a new edit drops the redo branch", () => {
  const a = small("soil-fine"), b = { ...a, seed: "1" }, c = { ...a, seed: "2" }, d = { ...a, seed: "3" };
  const history = new RecipeHistory(a);
  expect(history.push(structuredClone(a))).toBe(false);
  history.push(b);
  history.push(c);
  expect(history.undo()).toEqual(b);
  expect(history.undo()).toEqual(a);
  expect(history.canUndo).toBe(false);
  expect(history.redo()).toEqual(b);
  history.push(d);
  expect(history.canRedo).toBe(false);
  expect(history.undo()).toEqual(b);
});

test("validation messages point at their field", () => {
  const cases: [Partial<SurfaceTextureRecipe> | Record<string, unknown>, string][] = [
    [{ gridX: 0 }, "gridX"], [{ detailGridY: 999 }, "detailGridY"], [{ heightMin: 200, heightMax: 100 }, "heightMin"],
    [{ height: 0 }, "height"], [{ seed: "-1" }, "seed"], [{ low: [1, 2, 300] }, "low"],
    [{ furrows: { axis: "x", count: 40, depth: 1, softness: 1 } }, "furrowCount"],
    [{ furrows: { axis: "x", count: 2, depth: 1, softness: 9 } }, "furrowSoftness"],
    [{ roughnessMin: 250, roughnessMax: 10 }, "roughnessMin"], [{ normalStrength: 0 }, "normalStrength"],
  ];
  for (const [overrides, field] of cases) {
    let message = "";
    try { workbenchRecipe({ ...small("soil-fine"), ...overrides }); } catch (error) { message = (error as Error).message; }
    expect(fieldForError(message)).toBe(field);
  }
});

test("only the latest request may update the page", () => {
  const latest = new LatestRequest();
  const first = latest.next(), second = latest.next();
  expect(latest.isCurrent(first)).toBe(false);
  expect(latest.isCurrent(second)).toBe(true);
});

test("the page has a control and an error slot for every field, and its bundles build", async () => {
  const html = renderTextureWorkbenchHtml();
  for (const field of WORKBENCH_FIELDS) {
    expect(html).toContain(`name="${field}"`);
    expect(html).toContain(`id="error-${field}"`);
  }
  const outDir = await mkdtemp(path.join(os.tmpdir(), "texture-workbench-page-"));
  try {
    await writeTextureWorkbenchPage({ repositoryRoot: path.resolve(import.meta.dir, ".."), outDir });
    for (const name of ["index.html", "app.js", "worker.js"]) expect((await stat(path.join(outDir, name))).size).toBeGreaterThan(0);
    expect(await readFile(path.join(outDir, "worker.js"), "utf8")).not.toMatch(/(from\s*|import\s*\(\s*)"node:/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
