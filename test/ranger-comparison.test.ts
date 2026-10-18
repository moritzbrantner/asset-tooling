// The Ranger comparison data (#111, docs/animation-viewer.md#ranger-comparison) is optional in ordinary
// builds and required in the Pages workflow; malformed working archives fail visibly.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { writeRangerComparisonData } from "../src/ranger-comparison.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("without a bundle tar the data is unavailable, or a build failure when required", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "ranger-comparison-"));
  try {
    const result = await writeRangerComparisonData({ repositoryRoot: ROOT, outDir });
    assert.equal(result.status, "unavailable");
    assert.deepEqual(await readdir(outDir), [], "nothing is written");
    await assert.rejects(writeRangerComparisonData({ repositoryRoot: ROOT, outDir, require: true }), /Ranger comparison data unavailable/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("a malformed working tar is rejected once the sources are hydrated", async (t) => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "ranger-comparison-"));
  const tar = path.join(outDir, "fake.tar");
  await writeFile(tar, Buffer.alloc(1024));
  try {
    const result = await writeRangerComparisonData({ repositoryRoot: ROOT, outDir: path.join(outDir, "out"), bundleTar: tar }).catch((error: Error) => error);
    if (!(result instanceof Error) && result.status === "unavailable") return t.skip(result.reason);
    assert.ok(result instanceof Error && /manifest.json/.test(result.message), String(result));
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
