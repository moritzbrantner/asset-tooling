// Ranger source-versus-processed comparison (#111, docs/animation-viewer.md#ranger-comparison) in real
// Chromium against the built Pages site. The page's data needs the hydrated humanoid payloads and the
// pinned release tar at build time (ASSET_TOOLING_RANGER_BUNDLE_TAR); without them these tests skip.
import { expect, test, type Page } from "@playwright/test";
import { ensureEvidenceDir } from "./viewer-harness.ts";
import path from "node:path";

const ROUTE = "compare/ranger/";
const PANELS = ["source", "motion", "processed", "archer"] as const;

async function hasData(page: Page): Promise<boolean> {
  const response = await page.request.get(`${ROUTE}data.json`);
  return response.ok();
}

async function open(page: Page, query = ""): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${ROUTE}${query}`);
  await expect(page.locator("#workspace")).toBeVisible({ timeout: 120_000 });
  return errors;
}

async function pixels(page: Page, panel: (typeof PANELS)[number]): Promise<Buffer> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.locator(`#canvas-${panel}`).screenshot();
}

test.describe("Ranger comparison", () => {
  test.setTimeout(240_000);
  test.beforeEach(async ({ page }) => {
    test.skip(!(await hasData(page)), "the Pages build has no Ranger comparison data (hydrate LFS and set ASSET_TOOLING_RANGER_BUNDLE_TAR)");
  });

  test("shows the four identified views and every bundle clip", async ({ page }) => {
    const errors = await open(page);
    for (const panel of PANELS) await expect(page.locator(`#canvas-${panel}`)).toBeVisible();
    await expect(page.locator("#caption-source")).toContainText("source ships no clips");
    await expect(page.locator("#caption-processed")).toContainText("humanoid-ranger-male-v7");
    await expect(page.locator("#caption-motion")).toContainText("UAL1 mannequin");
    await expect(page.locator("#caption-archer")).toContainText("debug fallback");
    const clips = await page.locator("#clip option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(clips).toHaveLength(35);
    expect(clips).toEqual(expect.arrayContaining(["Idle_Loop", "Walk_Loop", "Jump_Start", "Jump_Loop", "Jump_Land", "ClimbUp_1m_RM", "Slide_Loop"]));
    expect(errors).toEqual([]);
  });

  test("one clip and time drive the source motion and the processed bundle; the source stays at rest", async ({ page }) => {
    await open(page);
    await page.locator("#clip").selectOption("Jump_Start");
    await page.locator("#time").fill("0");
    await page.locator("#time").press("Enter");
    const before = Object.fromEntries(await Promise.all(PANELS.map(async (panel) => [panel, await pixels(page, panel)] as const)));
    await page.locator("#time").fill("0.6");
    await page.locator("#time").press("Enter");
    await expect(page.locator("#time")).toHaveValue("0.6");
    expect((await pixels(page, "motion")).equals(before.motion!)).toBe(false);
    expect((await pixels(page, "processed")).equals(before.processed!)).toBe(false);
    expect((await pixels(page, "source")).equals(before.source!)).toBe(true);
    expect((await pixels(page, "archer")).equals(before.archer!)).toBe(true);
    // A UAL2 clip switches the source-motion panel to the UAL2 mannequin.
    await page.locator("#clip").selectOption("Slide_Loop");
    await expect(page.locator("#caption-motion")).toContainText("UAL2 mannequin");
  });

  test("camera presets move every view; the URL keeps clip, time and view across a reload", async ({ page }) => {
    await open(page, "?clip=Walk_Loop&t=0.4&view=front");
    await expect(page.locator("#clip")).toHaveValue("Walk_Loop");
    await expect(page.locator("#time")).toHaveValue("0.4");
    const front = await pixels(page, "archer");
    await page.getByRole("button", { name: "Gameplay" }).click();
    expect((await pixels(page, "archer")).equals(front)).toBe(false);
    await expect(page).toHaveURL(/clip=Walk_Loop&t=0\.4&view=gameplay/);
    await page.reload();
    await expect(page.locator("#workspace")).toBeVisible({ timeout: 120_000 });
    await expect(page.locator("#clip")).toHaveValue("Walk_Loop");
    await expect(page.locator("#time")).toHaveValue("0.4");
    await expect(page.getByRole("button", { name: "Gameplay" })).toHaveAttribute("aria-pressed", "true");
  });

  test("play advances the shared time; pause freezes it", async ({ page }) => {
    await open(page, "?clip=Walk_Loop&t=0");
    await page.locator("#play").click();
    await page.waitForTimeout(500);
    await page.locator("#play").click();
    const paused = Number(await page.locator("#time").inputValue());
    expect(paused).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    expect(Number(await page.locator("#time").inputValue())).toBe(paused);
  });

  test("wireframe, skeleton and socket views change only the views they apply to", async ({ page }) => {
    const evidence = ensureEvidenceDir();
    await open(page, "?clip=Idle_Loop&t=0.5&view=front");
    const snapshot = async () => Object.fromEntries(await Promise.all(PANELS.map(async (panel) => [panel, await pixels(page, panel)] as const)));
    const base = await snapshot();
    await page.getByLabel("Skeleton (source motion and processed)").check();
    let now = await snapshot();
    expect(now.motion!.equals(base.motion!)).toBe(false);
    expect(now.processed!.equals(base.processed!)).toBe(false);
    expect(now.source!.equals(base.source!)).toBe(true);
    await page.getByLabel("Skeleton (source motion and processed)").uncheck();
    await page.getByLabel("Sockets (processed)").check();
    now = await snapshot();
    expect(now.processed!.equals(base.processed!)).toBe(false);
    expect(now.motion!.equals(base.motion!)).toBe(true);
    await page.getByLabel("Sockets (processed)").uncheck();
    await page.getByLabel("Wireframe (all views)").check();
    now = await snapshot();
    for (const panel of PANELS) expect(now[panel]!.equals(base[panel]!), panel).toBe(false);
    await page.screenshot({ path: path.join(evidence, "ranger-comparison-wireframe.png"), fullPage: true });
    await page.getByLabel("Wireframe (all views)").uncheck();
    now = await snapshot();
    for (const panel of PANELS) expect(now[panel]!.equals(base[panel]!), panel).toBe(true);
  });

  test("normal and narrow layouts have no horizontal scrolling; screenshots saved as evidence", async ({ page }) => {
    const evidence = ensureEvidenceDir();
    await open(page, "?clip=Jump_Start&t=0.6&view=front");
    await page.screenshot({ path: path.join(evidence, "ranger-comparison-normal.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(evidence, "ranger-comparison-narrow.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
