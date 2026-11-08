// Zoo's zebra and giraffe play idle and walk in the existing animation viewer (#128, docs/quadruped-rigid.md). Their
// bytes come from the hydrated canonical payloads under their catalog pins; without hydration the tests skip.
import { statSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { Viewer, catalogAsset, collectPageErrors, ensureEvidenceDir, fulfillBytes, installNetwork, repoRoot, sameBytes, type SourceResponder } from "./viewer-harness.ts";

const ANIMALS = [{ id: "zoo.zebra-glb", file: "zebra.glb" }, { id: "zoo.giraffe-glb", file: "giraffe.glb" }];

for (const { id, file } of ANIMALS) {
  const asset = catalogAsset(id);
  const payload = path.join(repoRoot, "assets", "canonical", id, file);
  const hydrated = (() => { try { return statSync(payload).size === asset.source.byteLength; } catch { return false; } })();

  test.describe(id, () => {
    test.skip(!hydrated, "Git LFS payload not hydrated");

    test("plays idle and walk with its authored rig, under its catalog pin", async ({ page }) => {
      const errors = collectPageErrors(page);
      const bytes = new Uint8Array(readFileSync(payload));
      const override = new Map<string, SourceResponder>([[asset.source.url, (route, url) => fulfillBytes(route, bytes, url)]]);
      const log = await installNetwork(page, { override });
      const viewer = new Viewer(page);
      await viewer.open({ asset: id });
      await viewer.expectReady();

      await expect(viewer.clip.locator("option")).toHaveText([/^idle/, /^walk/]);
      await expect(page.locator("#identity")).toContainText("quadruped-rigid");
      await expect(page.locator("#identity")).toContainText("MIT");
      await expect(page.locator("#identity")).toContainText(/Copyright \(c\) 2026 moritzbrantner/);

      const evidence = ensureEvidenceDir();
      for (const [clipIndex, clipName] of [[0, "idle"], [1, "walk"]] as const) {
        await viewer.clip.selectOption({ index: clipIndex });
        await viewer.preset("Front").click();
        const frames = [];
        for (const t of ["0", "0.26", "0.52", "0.78"]) {
          await viewer.seek(t);
          expect(await viewer.timeValue()).toBe(Number(t));
          const frame = await viewer.shot();
          frames.push(frame);
          await page.screenshot({ path: path.join(evidence, `${id}-${clipName}-${t}.png`), fullPage: false });
        }
        expect(frames.some((frame) => !sameBytes(frames[0]!, frame)), `${clipName} moves the model`).toBe(true);
      }

      await viewer.preset("Gameplay").click();
      await viewer.seek("0.26");
      await page.screenshot({ path: path.join(evidence, `${id}-walk-gameplay.png`), fullPage: false });

      expect(errors).toEqual([]);
      expect(log.blocked).toEqual([]);
    });
  });
}
