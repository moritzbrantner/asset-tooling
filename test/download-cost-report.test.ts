import { describe, expect, test } from "bun:test";
import { compareDownloadCosts } from "../scripts/report-download-costs.ts";

const entry = (key: string, variant: string, bytes: number, drawCalls: number, compressedBytes = 1000) => ({
  key, variant, bytes, files: [`${key}.${variant}.gltf`], textures: ["shared.ktx2"],
  runtime: { textureMemoryEstimate: { compressedBytes, rgba8FallbackBytes: compressedBytes * 4 },
    materials: 2, drawCalls, triangles: drawCalls * 400 },
});
const index = (...entries: ReturnType<typeof entry>[]) => ({ schema: "asset-downloads-v1", release: "ranger",
  decoders: {}, textureEncodings: {}, entries });

describe("read-only download cost reports", () => {
  test("reports per-variant cost, largest consumers and exact matched-variant deltas", () => {
    const before = index(entry("body", "default", 100, 4), entry("body", "lod1", 60, 2));
    const after = index(entry("body", "default", 120, 5, 1500), entry("body", "lod2", 20, 1));
    const report = compareDownloadCosts(after, before);
    expect(report.schema).toBe("asset-download-cost-report-v1");
    expect(report.release).toBe("ranger");
    expect(report.entryCount).toBe(2);
    expect(report.maxima.downloadBytes).toEqual({ id: "body/default", value: 120 });
    expect(report.maxima.drawCalls).toEqual({ id: "body/default", value: 5 });
    expect(report.changes).toEqual([{ id: "body/default", deltas: {
      downloadBytes: 20, textureCompressedBytes: 500, textureRgba8FallbackBytes: 2000,
      materials: 0, drawCalls: 1, triangles: 400,
    } }]);
    expect(report.added).toEqual(["body/lod2"]);
    expect(report.removed).toEqual(["body/lod1"]);
    // Each variant is an alternative; never sum shared textures/bytes into a fake simultaneous load budget.
    expect(report.maxima.textureCompressedBytes).toEqual({ id: "body/default", value: 1500 });
  });

  test("rejects malformed, duplicate and negative cost indexes before reporting", () => {
    expect(() => compareDownloadCosts({ ...index(entry("body", "default", 1, 1)), schema: "wrong" })).toThrow(/index schema/);
    expect(() => compareDownloadCosts(index(entry("body", "default", 1, 1), entry("body", "default", 2, 2)))).toThrow(/duplicate/);
    expect(() => compareDownloadCosts(index(entry("body", "default", -1, 1)))).toThrow(/download bytes/);
    expect(() => compareDownloadCosts(index(entry("body", "default", 1, -1)))).toThrow(/draw calls/);
    expect(() => compareDownloadCosts(index(entry("body", "default", 1, 1)), { ...index(), release: "other" })).toThrow(/same release/);
  });

  test("identical measurements yield no apparent regressions", () => {
    const current = index(entry("body", "lod1", 50, 2), entry("body", "default", 100, 4));
    const report = compareDownloadCosts(current, current);
    expect(report.entries.map(x => x.id)).toEqual(["body/default", "body/lod1"]);
    expect(report.changes).toEqual([]);
    expect(report.added).toEqual([]);
    expect(report.removed).toEqual([]);
  });
});
