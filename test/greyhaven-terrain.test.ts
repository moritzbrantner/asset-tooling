import { describe, expect, test } from "bun:test";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { TERRAIN_LAYERS, TERRAIN_MAPS, linearMeanColor, terrainHeightAlpha, terrainSourceId } from "../scripts/build-greyhaven-terrain.ts";

const root = path.resolve(import.meta.dir, "..");

describe("greyhaven terrain", () => {
  test("every layer map is a pinned, CC0, LFS-stored catalog source", async () => {
    const sources: { id: string; license: { spdx: string }; tags: string[]; source: { upstreamId: string; sha256?: string } }[] =
      JSON.parse(await readFile(path.join(root, "catalog/sources.json"), "utf8")).sources;
    const storage: { sourceId: string }[] = JSON.parse(await readFile(path.join(root, "catalog/storage.json"), "utf8")).entries;
    for (const { polyHavenId } of TERRAIN_LAYERS) {
      for (const map of TERRAIN_MAPS) {
        const id = terrainSourceId(polyHavenId, map);
        const source = sources.find((item) => item.id === id);
        expect(source, id).toBeDefined();
        expect(source!.license.spdx).toBe("CC0-1.0");
        expect(source!.tags).toContain("greyhaven-terrain");
        expect(source!.source.upstreamId).toBe(polyHavenId);
        expect(source!.source.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(storage.some((entry) => entry.sourceId === id)).toBe(true);
      }
    }
  });

  test("height alpha spans 128..255 between the 1st and 99th percentile", () => {
    // Heights 0..199, one texel each: the 1st percentile is 1, the 99th is 197.
    const rgba = new Uint8Array(200 * 4);
    for (let index = 0; index < 200; index += 1) rgba[index * 4] = index;
    const { alpha, low, high } = terrainHeightAlpha(rgba);
    expect([low, high]).toEqual([1, 197]);
    expect(alpha[0]).toBe(128);
    expect(alpha[1]).toBe(128);
    expect(alpha[99]).toBe(Math.round(255 * (0.5 + 0.5 * (98 / 196))));
    expect(alpha[197]).toBe(255);
    expect(alpha[199]).toBe(255);
  });

  test("mean colour averages in linear light", () => {
    const pixels = new Uint8Array([255, 0, 128, 255, 0, 0, 128, 255]);
    expect(linearMeanColor({ width: 2, height: 1, pixels })).toEqual([0.5, 0, 0.2159]);
  });
});
