// Ranger source-versus-processed comparison (#111, docs/animation-viewer.md#ranger-comparison) in real
// Chromium against the built Pages site. The page's data needs the hydrated humanoid payloads and the
// pinned release tar at build time (ASSET_TOOLING_RANGER_BUNDLE_TAR); without them these tests skip.
import { expect, test, type Page } from "@playwright/test";
import { canvasFrame, ensureEvidenceDir } from "./viewer-harness.ts";
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
  return canvasFrame(page.locator(`#canvas-${panel}`));
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
    await expect(page.locator("#caption-processed")).toContainText("Processed ·");
    await expect(page.locator("#caption-motion")).toContainText("UAL1 mannequin");
    await expect(page.locator("#caption-archer")).toContainText("debug fallback");
    const clips = await page.locator("#clip option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(clips.length).toBeGreaterThanOrEqual(43);
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
    // A Mixamo clip has no published source, so the source-motion view is hidden and the other three remain.
    await page.locator("#clip").selectOption("Walk_Strafe_Left_Loop");
    await expect(page.locator("#canvas-motion")).toBeHidden();
    for (const panel of ["source", "processed", "archer"]) await expect(page.locator(`#canvas-${panel}`)).toBeVisible();
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

  test("editing journey: outfit, skin, hood, hair and tint, faction colour and LOD recompose the processed character", async ({ page }) => {
    const evidence = ensureEvidenceDir();
    const errors = await open(page, "?clip=Idle_Loop&t=0.5&view=front");
    const caption = page.locator("#caption-processed");
    await expect(caption).toContainText("humanoid.ranger.male/default");
    const archer = await pixels(page, "processed");
    const motion = await pixels(page, "motion");

    await page.getByLabel("Outfit", { exact: true }).selectOption("outfit.knight");
    await expect(caption).toContainText("humanoid.ranger.male/outfit.knight ·");
    await expect(page).toHaveURL(/outfit=outfit\.knight/);
    const knight = await pixels(page, "processed");
    expect(knight.equals(archer)).toBe(false);
    expect((await pixels(page, "motion")).equals(motion), "other views are unchanged").toBe(true);
    // The variant has no hood, so the hood control is off and disabled.
    await expect(page.getByLabel("Hood", { exact: true })).toBeDisabled();

    await page.getByLabel("Faction colour", { exact: true }).fill("#1040c0");
    await expect(page).toHaveURL(/faction=1040c0/);
    const blue = await pixels(page, "processed");
    expect(blue.equals(knight)).toBe(false);

    await page.getByLabel("Skin", { exact: true }).selectOption("skin.light");
    await expect(caption).toContainText("outfit.knight.skin.light");
    await page.getByLabel("Level of detail", { exact: true }).selectOption("lod2");
    await expect(caption).toContainText("outfit.knight.skin.light.lod2");
    await page.getByLabel("Level of detail", { exact: true }).selectOption("lod0");

    // A clip still drives the recomposed character (the clips ship once, in the default variant).
    await page.locator("#time").fill("1.2");
    await page.locator("#time").press("Enter");
    expect((await pixels(page, "processed")).equals(await (async () => { await page.locator("#time").fill("0.5"); await page.locator("#time").press("Enter"); return pixels(page, "processed"); })())).toBe(false);
    await page.screenshot({ path: path.join(evidence, "ranger-edit-knight.png"), fullPage: true });

    // Back to the archer: hair needs the hood off, so choosing it with the hood on is refused and nothing changes.
    await page.getByLabel("Outfit", { exact: true }).selectOption("outfit.archer");
    await page.getByLabel("Skin", { exact: true }).selectOption("skin.dark");
    await expect(page.getByLabel("Hood", { exact: true })).toBeChecked();
    const hooded = await pixels(page, "processed");
    await page.getByLabel("Hair", { exact: true }).selectOption("hair.long");
    await expect(page.locator("#compose-error")).toContainText("hair.long requires outfit.hood off");
    await expect(page.getByLabel("Hair", { exact: true })).toHaveValue("");
    expect((await pixels(page, "processed")).equals(hooded)).toBe(true);

    await page.getByLabel("Hood", { exact: true }).uncheck();
    await expect(page.locator("#compose-error")).toBeHidden();
    await page.getByLabel("Hair", { exact: true }).selectOption("hair.long");
    await expect(caption).toContainText("hair.long (tint.black)");
    const black = await pixels(page, "processed");
    await page.getByLabel("Hair colour", { exact: true }).selectOption("tint.blond");
    await expect(caption).toContainText("hair.long (tint.blond)");
    expect((await pixels(page, "processed")).equals(black)).toBe(false);
    await page.screenshot({ path: path.join(evidence, "ranger-edit-archer-hair.png"), fullPage: true });

    // The look is in the URL and survives a reload.
    await expect(page).toHaveURL(/hood=0&hair=hair\.long&color=tint\.blond/);
    const look = await pixels(page, "processed");
    await page.reload();
    await expect(page.locator("#workspace")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByLabel("Hair colour", { exact: true })).toHaveValue("tint.blond");
    await expect(caption).toContainText("hair.long (tint.blond)");
    expect((await pixels(page, "processed")).equals(look)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("face, eyes, nose and mouth change the processed face independently; a level of detail refuses them", async ({ page }) => {
    const evidence = ensureEvidenceDir();
    const errors = await open(page, "?clip=Walk_Loop&t=0.3&view=front");
    const caption = page.locator("#caption-processed");
    await expect(caption).toContainText("humanoid.ranger.male/default");
    let previous = await pixels(page, "processed");
    for (const [label, option] of [["Face shape", "face.broad"], ["Eyes", "eyes.large"], ["Nose", "nose.long"], ["Mouth", "mouth.full"]] as const) {
      await page.getByLabel(label, { exact: true }).selectOption(option);
      await expect(caption).toContainText(option);
      const next = await pixels(page, "processed");
      expect(next.equals(previous), `${option} changes the face`).toBe(false);
      previous = next;
    }
    await expect(page).toHaveURL(/face=face\.broad&eyes=eyes\.large&nose=nose\.long&mouth=mouth\.full/);
    await page.screenshot({ path: path.join(evidence, "ranger-edit-face.png"), fullPage: true });
    await page.getByLabel("Level of detail", { exact: true }).selectOption("lod1");
    await expect(page.locator("#compose-error")).toContainText("face options need a full-detail character");
    await expect(caption).toContainText("mouth.full");
    expect(errors).toEqual([]);
  });

  test("export downloads one GLB of the composed character and reloads it with its clips", async ({ page }) => {
    await open(page, "?clip=Walk_Loop&t=0.3&view=front&outfit=outfit.soldier");
    const caption = page.locator("#caption-processed");
    await expect(caption).toContainText("outfit.soldier");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export GLB" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("humanoid.ranger.male.outfit.soldier.glb");
    const bytes = await (await import("node:fs/promises")).readFile(await file.path());
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("glTF");
    await expect(caption).toContainText("exported GLB, reloaded");
    await expect(caption).toContainText("humanoid.ranger.male.outfit.soldier.glb");
    const clips = await page.locator("#clip option").count();
    await expect(caption).toContainText(`${clips} clips`);
    const at03 = await pixels(page, "processed");
    await page.locator("#time").fill("0.9");
    await page.locator("#time").press("Enter");
    expect((await pixels(page, "processed")).equals(at03), "the reloaded export plays the clip").toBe(false);
    // Any edit recomposes from the bundle again.
    await page.getByRole("button", { name: "Reset" }).click();
    await expect(caption).toContainText("humanoid.ranger.male/default");
  });

  test("a URL look that cannot be composed falls back to the default with the reason shown", async ({ page }) => {
    await open(page, "?outfit=outfit.archer&hood=1&hair=hair.buzzed");
    await expect(page.locator("#compose-error")).toContainText("hair.buzzed requires outfit.hood off");
    await expect(page.locator("#caption-processed")).toContainText("humanoid.ranger.male/default");
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
