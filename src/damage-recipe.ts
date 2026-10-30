import path from "node:path";
import { resolveAssetObject } from "./asset-store.js";
import { blenderScriptSpec, runBlenderRecipe } from "./blender-recipe-run.js";
import { readBlenderRecipeSource } from "./blender-recipe-source.js";
import { sha256Bytes } from "./hash.js";
import type { DebrisPlane } from "./debris-recipe.js";
import type { AssetRef } from "./operations.js";

/**
 * Staged destruction of the modular building pieces (#318 for mmorpg destructible buildings, owner decisions
 * 2026-10-18): besides the intact piece, adapters/blender/damage.py authors a `damaged` state (ragged breaches cut
 * with exact Booleans) and a `destroyed` stub (the piece below a few tilted planes). The pre-fractured chunks are the
 * #319 `debris` variant. Every state keeps the piece's materials and shared textures and ships its own lod1/lod2.
 */
export type DamageState = "damaged" | "destroyed";
export const DAMAGE_STATES: readonly DamageState[] = ["damaged", "destroyed"];
/** A breach's centre is in fractions of the piece's bounds; its radii are metres along the placed glTF axes. */
export type Breach = { center: [number, number, number]; radius: [number, number, number] };
export type DamageRecipe = { damaged: Breach[]; destroyed: DebrisPlane[] };
export type Vec3 = [number, number, number];
export type Box = { min: Vec3; max: Vec3 };

/** The destructible pieces and their cuts (reviewed in examples/greyhaven-kit/destruction.json). */
export const DAMAGE_RECIPES = Object.freeze({
  // Door wall: a bite out of the lintel and one through the left jamb; the stub keeps both jambs' lower parts.
  wall: {
    damaged: [{ center: [0.62, 0.82, 0.5], radius: [0.42, 0.35, 0.5] }, { center: [0.14, 0.55, 0.5], radius: [0.22, 0.4, 0.5] }],
    destroyed: [{ point: [0.2, 0.38, 0.5], normal: [-0.4, 1, 0] }, { point: [0.75, 0.25, 0.5], normal: [0.6, 1, 0] }],
  },
  // Plain wall: two overlapping lumps make one ragged hole; three tilted planes leave a stepped stub.
  "wall-plain": {
    damaged: [{ center: [0.45, 0.55, 0.5], radius: [0.45, 0.5, 0.5] }, { center: [0.63, 0.42, 0.5], radius: [0.35, 0.38, 0.5] }],
    destroyed: [{ point: [0.25, 0.42, 0.5], normal: [-0.5, 1, 0] }, { point: [0.6, 0.3, 0.5], normal: [0.25, 1, 0] }, { point: [0.85, 0.2, 0.5], normal: [0.9, 1, 0] }],
  },
  // Corner post: a gouge out of one side at mid height; snapped at about a third of its height.
  corner: {
    damaged: [{ center: [0.85, 0.55, 0.8], radius: [0.12, 0.3, 0.12] }],
    destroyed: [{ point: [0.5, 0.32, 0.5], normal: [0.6, 1, 0.3] }],
  },
  // Roof: two holes punched through the slopes (tall lumps reach both); collapsed to its two eaves.
  roof: {
    damaged: [{ center: [0.3, 0.5, 0.45], radius: [0.8, 2.5, 0.9] }, { center: [0.7, 0.5, 0.62], radius: [0.5, 2.5, 0.6] }],
    destroyed: [{ point: [0.5, 0.32, 0.3], normal: [0.15, 1, 0.25] }, { point: [0.5, 0.26, 0.8], normal: [-0.1, 1, -0.35] }],
  },
  // Floor: a hole broken through the planks; only a ragged strip along one edge is left.
  floor: {
    damaged: [{ center: [0.42, 0.5, 0.55], radius: [0.5, 1, 0.45] }],
    destroyed: [{ point: [0.4, 0.5, 0.5], normal: [1, 0, 0.3] }, { point: [0.5, 0.5, 0.8], normal: [0.25, 0, 1] }],
  },
} satisfies Record<string, DamageRecipe>) as Readonly<Record<string, DamageRecipe>>;

/** The `<state>-<level>` bundle variant of a damage state's LOD. */
export const damageLodVariant = (state: DamageState, level: string) => `${state}-${level}`;

/** Remove the overlap with `hole` from `box`: up to six boxes, split along x, then y, then z. Thin slivers are dropped. */
export function subtractBox(box: Box, hole: Box, minimum = 0.02): Box[] {
  const overlap = [0, 1, 2].every((axis) => hole.min[axis]! < box.max[axis]! && hole.max[axis]! > box.min[axis]!);
  if (!overlap) return [box];
  const pieces: Box[] = [];
  let rest: Box = { min: [...box.min] as Vec3, max: [...box.max] as Vec3 };
  for (const axis of [0, 1, 2]) {
    if (hole.min[axis]! > rest.min[axis]!) {
      const max = [...rest.max] as Vec3; max[axis] = hole.min[axis]!;
      pieces.push({ min: [...rest.min] as Vec3, max });
    }
    if (hole.max[axis]! < rest.max[axis]!) {
      const min = [...rest.min] as Vec3; min[axis] = hole.max[axis]!;
      pieces.push({ min, max: [...rest.max] as Vec3 });
    }
    rest = { min: [...rest.min] as Vec3, max: [...rest.max] as Vec3 };
    rest.min[axis] = Math.max(rest.min[axis]!, hole.min[axis]!);
    rest.max[axis] = Math.min(rest.max[axis]!, hole.max[axis]!);
  }
  return pieces.filter((piece) => [0, 1, 2].every((axis) => piece.max[axis]! - piece.min[axis]! >= minimum));
}

/** Clip `box` to `limit`; undefined when nothing thicker than `minimum` is left. */
export function clipBox(box: Box, limit: Box, minimum = 0.02): Box | undefined {
  const min = [0, 1, 2].map((axis) => Math.max(box.min[axis]!, limit.min[axis]!)) as Vec3;
  const max = [0, 1, 2].map((axis) => Math.min(box.max[axis]!, limit.max[axis]!)) as Vec3;
  return [0, 1, 2].every((axis) => max[axis]! - min[axis]! >= minimum) ? { min, max } : undefined;
}

/** Author one damage state of a placed piece through the pinned Blender backend; returns the GLB and the observations. */
export async function generateDamageState(root: string, source: AssetRef, name: string, state: DamageState, recipe: DamageRecipe) {
  const script = await readBlenderRecipeSource("damage.py");
  const bytes = await resolveAssetObject(root, source);
  const cut = state === "damaged" ? { breaches: recipe.damaged } : { planes: recipe.destroyed };
  const spec = blenderScriptSpec({
    assetId: `damage.${name}.${state}`, inputs: { script: { path: "damage.py", sha256: script.sha256 }, source: { path: "source.glb", sha256: sha256Bytes(bytes) } },
    blenderVersion: script.blenderVersion, arguments: { schemaVersion: 1, name, state, ...cut }, output: "damage.glb",
  });
  return runBlenderRecipe(root, {
    workspace: path.join(root, "damage", `${name}.${state}`), spec, files: { "damage.py": script.bytes, "source.glb": bytes },
    metadata: { damage: name, state, source: source.sha256 },
  });
}
