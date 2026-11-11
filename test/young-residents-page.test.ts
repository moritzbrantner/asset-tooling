// The young residents face page (#556): the shell has every control the client fills, and the data step reports that it
// has nothing to show until the first release exists.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdtemp, rm } from "node:fs/promises";
import { renderYoungResidentsHtml, writeYoungResidentsData } from "../src/young-residents-page.js";

test("the shell carries the controls the client fills", () => {
  const html = renderYoungResidentsHtml();
  for (const id of ["view", "status", "characters", "peoples", "skins", "hairs", "dials", "reset", "copy", "json", "clip-Walk_Loop", "clip-Idle_Loop"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes('src="app.js"'));
});

test("without a bundle tar the data step writes nothing and says why", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "young-page-"));
  try {
    const outDir = path.join(dir, "young");
    const result = await writeYoungResidentsData({ repositoryRoot: dir, outDir });
    assert.equal(result.status, "unavailable");
    await assert.rejects(access(outDir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
