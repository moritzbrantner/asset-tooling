// Pure state helpers of the texture workbench (#127, docs/texture-workbench.md): URL state, undo/redo, field errors
// and the latest-request gate. No DOM access, so tests import them directly.
import { canonicalJson } from "../canonical.js";
import { normalizeSurfaceTextureRecipe, type SurfaceTextureRecipe } from "../surface-texture-kernels.js";

/** The workbench previews up to this many texels per axis; the recipe itself allows 4096 (build those with the CLI). */
export const WORKBENCH_MAX_DIMENSION = 2048;

export function recipeKey(recipe: SurfaceTextureRecipe): string {
  return canonicalJson(recipe);
}

/** Normalizes a recipe and applies the workbench's preview bound. Throws with the recipe's own messages. */
export function workbenchRecipe(value: unknown): SurfaceTextureRecipe {
  const recipe = normalizeSurfaceTextureRecipe(value);
  for (const axis of ["width", "height"] as const) {
    if (recipe[axis] > WORKBENCH_MAX_DIMENSION) {
      throw new Error(`${axis} must be at most ${WORKBENCH_MAX_DIMENSION} in the workbench preview; build larger tiles with the CLI`);
    }
  }
  return recipe;
}

export function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function fromBase64Url(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/** The recipe as one URL-safe query value. */
export function encodeRecipeParam(recipe: SurfaceTextureRecipe): string {
  return toBase64Url(recipeKey(recipe));
}

/** The recipe in a query value, or undefined when it is missing, malformed or invalid. */
export function decodeRecipeParam(value: string | null): SurfaceTextureRecipe | undefined {
  if (!value) return undefined;
  try {
    return workbenchRecipe(JSON.parse(fromBase64Url(value)));
  } catch {
    return undefined;
  }
}

/** Linear undo/redo over valid recipes (canonical JSON identity); pushing after an undo drops the redo branch. */
export class RecipeHistory<Recipe = SurfaceTextureRecipe> {
  #entries: Recipe[];
  #index = 0;
  constructor(initial: Recipe) {
    this.#entries = [initial];
  }
  get current(): Recipe {
    return this.#entries[this.#index]!;
  }
  get canUndo(): boolean {
    return this.#index > 0;
  }
  get canRedo(): boolean {
    return this.#index < this.#entries.length - 1;
  }
  /** Records a new current recipe; returns false when it equals the current one. */
  push(recipe: Recipe): boolean {
    if (canonicalJson(recipe) === canonicalJson(this.current)) return false;
    this.#entries = [...this.#entries.slice(0, this.#index + 1), recipe].slice(-200);
    this.#index = this.#entries.length - 1;
    return true;
  }
  undo(): Recipe | undefined {
    if (!this.canUndo) return undefined;
    this.#index -= 1;
    return this.current;
  }
  redo(): Recipe | undefined {
    if (!this.canRedo) return undefined;
    this.#index += 1;
    return this.current;
  }
}

/** Form field ids, in the order the page shows them. Furrow fields are flattened. */
export const WORKBENCH_FIELDS = [
  "seed", "width", "height", "gridX", "gridY", "detailGridX", "detailGridY", "detailWeight", "heightMin", "heightMax",
  "furrowAxis", "furrowCount", "furrowDepth", "furrowSoftness", "low", "high", "normalStrength", "roughnessMin", "roughnessMax",
] as const;
export type WorkbenchField = (typeof WORKBENCH_FIELDS)[number];

const ERROR_PREFIXES: [string, WorkbenchField][] = [
  ["furrow axis", "furrowAxis"], ["furrow count", "furrowCount"], ["furrow depth", "furrowDepth"],
  ["furrow softness", "furrowSoftness"],
  ...WORKBENCH_FIELDS.filter((field) => !field.startsWith("furrow")).map((field) => [field, field] as [string, WorkbenchField]),
];

/** The field a recipe validation message is about, so the page can show it next to that control. */
export function fieldForError(message: string): WorkbenchField | undefined {
  const match = ERROR_PREFIXES
    .filter(([prefix]) => message.startsWith(`${prefix} `) || message.startsWith(`${prefix}[`))
    .sort((left, right) => right[0].length - left[0].length)[0];
  return match?.[1];
}

/** Hands out request ids; only the latest one may update the page, so a late result never replaces a newer one. */
export class LatestRequest {
  #latest = 0;
  next(): number {
    this.#latest += 1;
    return this.#latest;
  }
  isCurrent(id: number): boolean {
    return id === this.#latest;
  }
}
