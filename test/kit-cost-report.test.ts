import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { KIT_BUDGETS, KIT_COST_SCHEMA, kitBudgetViolations, kitCost } from "../scripts/report-kit-costs.ts";

/** The first 28 bytes of a KTX2 file: its identifier and, at 20 and 24, the width and height. */
function ktx2Header(width: number, height: number) {
  const bytes = new Uint8Array(28);
  bytes.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  return bytes;
}

const gltf = (materials: string[], primitives: number, indices: number) => JSON.stringify({
  materials: materials.map((name) => ({ name })), accessors: [{ count: indices }],
  meshes: [{ primitives: Array.from({ length: primitives }, () => ({ indices: 0, attributes: {} })) }], nodes: [{ mesh: 0 }, {}],
});

async function bundle() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-cost-"));
  await mkdir(path.join(dir, "resources"));
  await writeFile(path.join(dir, "resources", "a.ktx2"), ktx2Header(1024, 512));
  await writeFile(path.join(dir, "a.gltf"), gltf(["rock"], 1, 300));
  await writeFile(path.join(dir, "a.lod1.gltf"), gltf(["rock"], 1, 30));
  await writeFile(path.join(dir, "b.gltf"), gltf(["rock", "iron"], 2, 60));
  const shared = { path: "resources/a.ktx2", mediaType: "image/ktx2" };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ assets: [
    { key: "a", variant: "default", path: "a.gltf", resources: [shared] },
    { key: "a", variant: "lod1", path: "a.lod1.gltf", resources: [shared] },
    { key: "b", variant: "default", path: "b.gltf", resources: [shared] },
  ] }));
  return dir;
}

describe("kit cost report", () => {
  test("counts each material and texture once across entries, and draws and triangles per entry", async () => {
    const dir = await bundle();
    try {
      const cost = await kitCost(dir);
      expect(cost.schema).toBe(KIT_COST_SCHEMA);
      expect(cost.materials).toEqual(["iron", "rock"]);
      expect(cost.textures).toBe(1);
      expect(cost.textureMemoryBytes).toBe(Math.round((1024 * 512 * 4) / 3));
      expect(cost.entries).toEqual([
        { key: "a", variant: "default", materials: 1, drawCalls: 1, triangles: 100 },
        { key: "a", variant: "lod1", materials: 1, drawCalls: 1, triangles: 10 },
        { key: "b", variant: "default", materials: 2, drawCalls: 2, triangles: 40 },
      ]);
      expect(cost.maxima).toEqual({ drawCalls: 2, triangles: 100 });
      expect(cost.downloadBytes).toBeGreaterThan(28);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("names every limit a kit exceeds", async () => {
    const dir = await bundle();
    try {
      const cost = await kitCost(dir);
      expect(kitBudgetViolations(cost, { materials: 2, textureMemoryBytes: 1 << 30, downloadBytes: 1 << 30 })).toEqual([]);
      expect(kitBudgetViolations(cost, { materials: 1, textureMemoryBytes: 1, downloadBytes: 1 }).map((line) => line.split(" ").slice(1, 2)[0])).toEqual(["materials", "MB", "MB"]);
      expect(kitBudgetViolations(cost, { materials: 1, textureMemoryBytes: 1 << 30, downloadBytes: 1 << 30 })[0]).toContain("iron, rock");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("budgets the kits packed into atlases", () => {
    expect(KIT_BUDGETS["sandstone-kit"]!.materials).toBe(1);
    expect(KIT_BUDGETS["crag-kit"]!.materials).toBe(3);
  });
});
