// Acceptance tests for the rigged source animation viewer, first slice of #111.
// Contract: docs/animation-viewer.md. Runs in real Chromium against the built
// Pages site (see playwright.config.ts); no test touches the real network.
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  MALFORMED_ID,
  NON_ELIGIBLE_GLTF_ID,
  NON_ELIGIBLE_ID,
  NO_CLIPS_ID,
  ODD_DURATION_CLAMPED,
  ODD_DURATION_ID,
  RIGGED_DURATION,
  RIGGED_ID,
  SECOND_CLIP_DURATION,
  SECOND_CLIP_NAME,
  SIMPLE_DURATION,
  SIMPLE_ID,
  TWO_CLIPS_ID,
  UNKNOWN_ID,
  Viewer,
  collectPageErrors,
  delay,
  ensureEvidenceDir,
  fulfillBytes,
  hasVisibleFocusIndicator,
  installNetwork,
  rigged,
  riggedBytes,
  sameBytes,
  simple,
  simpleBytes,
  tabTo,
  viewerUrl,
  type SourceResponder,
} from "./viewer-harness.ts";

const durationText = (seconds: number): RegExp =>
  new RegExp(String(seconds).replace(".", "\\.") + "0*\\s?(s|sec|seconds)\\b");
const UNNAMED_FIRST_CLIP = /^\s*Clip [01]\b/;

test.describe("rigged source animation viewer: rendering and controls", () => {
  test("lists clips by name or Clip N with their durations, first clip selected by default", async ({ page }) => {
    await installNetwork(page);
    const viewer = new Viewer(page);

    await viewer.open({ asset: RIGGED_ID });
    await viewer.expectReady();
    const riggedOptions = viewer.clip.locator("option");
    await expect(riggedOptions).toHaveCount(1);
    await expect(riggedOptions.first()).toHaveText(UNNAMED_FIRST_CLIP);
    await expect(riggedOptions.first()).toHaveText(durationText(RIGGED_DURATION));
    expect(await viewer.clip.evaluate((select) => (select as HTMLSelectElement).selectedIndex)).toBe(0);
    await expect(viewer.slider).toHaveAttribute("min", /^0(\.0*)?$/);
    expect(Number(await viewer.slider.getAttribute("max"))).toBeCloseTo(RIGGED_DURATION, 3);
    await expect(viewer.time).toHaveAttribute("step", "0.001");

    await viewer.open({ asset: SIMPLE_ID });
    await viewer.expectReady();
    await expect(viewer.clip.locator("option").first()).toHaveText(UNNAMED_FIRST_CLIP);
    await expect(viewer.clip.locator("option").first()).toHaveText(durationText(SIMPLE_DURATION));
    expect(Number(await viewer.slider.getAttribute("max"))).toBeCloseTo(SIMPLE_DURATION, 3);
  });

  test("selecting another clip changes duration, URL clip index and the rendered pose", async ({ page }) => {
    await installNetwork(page, { injectFixtures: true });
    const viewer = new Viewer(page);
    await viewer.open({ asset: TWO_CLIPS_ID });
    await viewer.expectReady();

    const options = viewer.clip.locator("option");
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toHaveText(UNNAMED_FIRST_CLIP);
    await expect(options.nth(0)).toHaveText(durationText(SIMPLE_DURATION));
    await expect(options.nth(1)).toHaveText(new RegExp(SECOND_CLIP_NAME));
    await expect(options.nth(1)).toHaveText(durationText(SECOND_CLIP_DURATION));

    await viewer.seek("1.1");
    const firstClipFrame = await viewer.shot();

    await viewer.clip.selectOption({ index: 1 });
    await expect.poll(async () => (await viewer.params()).get("clip")).toBe("1");
    expect(Number(await viewer.slider.getAttribute("max"))).toBeCloseTo(SECOND_CLIP_DURATION, 3);
    await viewer.seek("1.1");
    expect(await viewer.timeValue()).toBe(1.1);
    const secondClipFrame = await viewer.shot();
    expect(sameBytes(firstClipFrame, secondClipFrame), "same time in a different clip renders a different pose").toBe(false);

    await viewer.seek("99");
    expect(await viewer.timeValue()).toBe(SECOND_CLIP_DURATION);
  });

  test("play advances time only while playing; pause freezes it", async ({ page }) => {
    await installNetwork(page);
    const viewer = new Viewer(page);
    await viewer.open({ asset: SIMPLE_ID });
    await viewer.expectReady();

    await viewer.seek("0");
    await viewer.play();
    await expect.poll(() => viewer.timeValue(), { timeout: 5_000 }).toBeGreaterThan(0.2);

    await viewer.pause();
    const pausedAt = await viewer.timeValue();
    const pausedFrame = await viewer.shot();
    await delay(800);
    expect(await viewer.timeValue()).toBe(pausedAt);
    expect(sameBytes(pausedFrame, await viewer.shot()), "paused canvas does not change").toBe(true);
    expect(Number((await viewer.params()).get("t"))).toBeCloseTo(pausedAt, 3);

    await viewer.play();
    await expect.poll(() => viewer.timeValue(), { timeout: 5_000 }).not.toBe(pausedAt);
    await viewer.pause();
  });

  test("playback loops the selected clip", async ({ page }) => {
    await installNetwork(page);
    const viewer = new Viewer(page);
    await viewer.open({ asset: RIGGED_ID });
    await viewer.expectReady();
    await viewer.seek("1.1");
    await viewer.play();
    // 1.25 s clip: after wrapping, time is back near the start while still playing.
    await expect.poll(() => viewer.timeValue(), { timeout: 5_000 }).toBeLessThan(1.0);
    expect(await viewer.isPlaying()).toBe(true);
    const value = await viewer.timeValue();
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(RIGGED_DURATION);
  });

  test("exact seek shows exactly the entered time, clamps out-of-range input and renders deterministically", async ({ page }) => {
    await installNetwork(page);
    const viewer = new Viewer(page);
    await viewer.open({ asset: RIGGED_ID });
    await viewer.expectReady();
    await viewer.play();

    await viewer.seek("0.437");
    expect(await viewer.isPlaying(), "entering a time pauses playback").toBe(false);
    await expect(viewer.time).toHaveValue("0.437");
    expect(Number(await viewer.slider.inputValue())).toBeCloseTo(0.437, 3);
    expect((await viewer.params()).get("t")).toBe("0.437");
    const frameA = await viewer.shot();

    await viewer.seek("0.9");
    await expect(viewer.time).toHaveValue("0.9");
    const frameB = await viewer.shot();
    expect(sameBytes(frameA, frameB), "distinct times of the animated clip render differently").toBe(false);

    await viewer.seek("0.437");
    const frameA2 = await viewer.shot();
    expect(sameBytes(frameA, frameA2), "the same time re-entered renders identical pixels").toBe(true);

    await viewer.seek("7");
    expect(await viewer.timeValue()).toBe(RIGGED_DURATION);
    expect(Number(await viewer.slider.inputValue())).toBeCloseTo(RIGGED_DURATION, 3);

    await viewer.seek("-3");
    expect(await viewer.timeValue()).toBe(0);
    expect(Number(await viewer.slider.inputValue())).toBe(0);
  });

  test("the time slider seeks and stays in sync with the numeric input", async ({ page }) => {
    await installNetwork(page);
    const viewer = new Viewer(page);
    await viewer.open({ asset: RIGGED_ID, t: "0" });
    await viewer.expectReady();
    await viewer.pause();
    const start = await viewer.shot();

    await viewer.slider.focus();
    for (let index = 0; index < 5; index += 1) await page.keyboard.press("ArrowRight");
    await viewer.settle();
    const sliderValue = Number(await viewer.slider.inputValue());
    expect(sliderValue).toBeGreaterThan(0);
    expect(await viewer.timeValue()).toBeCloseTo(sliderValue, 3);
    expect(sameBytes(start, await viewer.shot())).toBe(false);
  });

  test("rest pose pauses, shows the bind pose and restores the previous time when turned off", async ({ page }) => {
    await installNetwork(page);
    const viewer = new Viewer(page);
    await viewer.open({ asset: RIGGED_ID });
    await viewer.expectReady();

    await viewer.seek("0.6");
    const posed = await viewer.shot();

    await viewer.restPose.click();
    const restFrame = await viewer.shot();
    expect(sameBytes(posed, restFrame), "rest pose (bind pose) differs from the 0.6 s clip frame").toBe(false);
    await delay(400);
    expect(sameBytes(restFrame, await viewer.shot()), "rest pose is static").toBe(true);

    await viewer.restPose.click();
    await viewer.settle();
    expect(await viewer.isPlaying()).toBe(false);
    await expect(viewer.time).toHaveValue("0.6");
    expect(sameBytes(posed, await viewer.shot()), "turning rest pose off restores the 0.6 s frame").toBe(true);

    // Enabling rest pose while playing pauses playback.
    await viewer.play();
    await viewer.restPose.click();
    await expect.poll(() => viewer.isPlaying()).toBe(false);
    const restWhilePlaying = await viewer.shot();
    expect(sameBytes(restFrame, restWhilePlaying), "rest pose is the same bind pose regardless of clip time").toBe(true);
    await viewer.restPose.click();
    await viewer.settle();
    expect(await viewer.isPlaying()).toBe(false);
    const restored = await viewer.timeValue();
    expect(restored).toBeGreaterThanOrEqual(0);
    expect(restored).toBeLessThanOrEqual(RIGGED_DURATION);
  });

  test("camera presets Front, Side, Back and Gameplay render distinct views and are kept in the URL", async ({ page }) => {
    await installNetwork(page);
    const viewer = new Viewer(page);
    await viewer.open({ asset: RIGGED_ID });
    await viewer.expectReady();
    await viewer.seek("0.3");

    const frames = new Map<string, Buffer>();
    for (const preset of ["Front", "Side", "Back", "Gameplay"] as const) {
      await expect(viewer.preset(preset)).toBeVisible();
      await viewer.preset(preset).click();
      await expect.poll(async () => (await viewer.params()).get("view")?.toLowerCase()).toBe(preset.toLowerCase());
      frames.set(preset, await viewer.shot());
    }
    const names = [...frames.keys()];
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const a = frames.get(names[i] ?? "");
        const b = frames.get(names[j] ?? "");
        if (!a || !b) throw new Error("missing preset frame");
        expect(sameBytes(a, b), `${names[i]} and ${names[j]} render differently`).toBe(false);
      }
    }
    await viewer.preset("Front").click();
    expect(sameBytes(frames.get("Front") ?? Buffer.alloc(0), await viewer.shot()), "presets are reproducible").toBe(true);
  });

  test("keyboard only: clip, time, play/pause, presets, rest pose, and canvas orbit/zoom with arrows and +/-", async ({ page }) => {
    await installNetwork(page, { injectFixtures: true });
    const viewer = new Viewer(page);
    await viewer.open({ asset: TWO_CLIPS_ID });
    await viewer.expectReady();

    // Clip select by keyboard.
    await tabTo(page, viewer.clip);
    expect(await hasVisibleFocusIndicator(viewer.clip), "clip select shows visible focus").toBe(true);
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await viewer.params()).get("clip")).toBe("1");

    // Time input by keyboard.
    await tabTo(page, viewer.time);
    expect(await hasVisibleFocusIndicator(viewer.time), "time input shows visible focus").toBe(true);
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("1.5");
    await page.keyboard.press("Enter");
    await viewer.settle();
    await expect(viewer.time).toHaveValue("1.5");

    // Play / Pause by keyboard.
    await tabTo(page, viewer.playPause);
    expect(await hasVisibleFocusIndicator(viewer.playPause), "play/pause shows visible focus").toBe(true);
    await page.keyboard.press("Enter");
    await expect.poll(() => viewer.isPlaying()).toBe(true);
    await page.keyboard.press("Space");
    await expect.poll(() => viewer.isPlaying()).toBe(false);
    await viewer.seek("1.5");

    // Camera preset by keyboard.
    await tabTo(page, viewer.preset("Side"));
    expect(await hasVisibleFocusIndicator(viewer.preset("Side")), "preset shows visible focus").toBe(true);
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await viewer.params()).get("view")?.toLowerCase()).toBe("side");

    // Rest pose by keyboard (toggle on and off).
    await tabTo(page, viewer.restPose);
    await page.keyboard.press("Space");
    await viewer.settle();
    await page.keyboard.press("Space");
    await viewer.settle();
    await expect(viewer.time).toHaveValue("1.5");

    // Canvas: focusable, labelled, orbit with arrows, zoom with +/-.
    const label = await viewer.canvas.evaluate((canvas) => {
      const labelledBy = canvas.getAttribute("aria-labelledby");
      const byRef = labelledBy ? document.getElementById(labelledBy)?.textContent ?? "" : "";
      return (canvas.getAttribute("aria-label") ?? byRef).trim();
    });
    expect(label.length, "canvas has an accessible label").toBeGreaterThan(0);
    await tabTo(page, viewer.canvas);
    await expect(viewer.canvas).toBeFocused();
    expect(await hasVisibleFocusIndicator(viewer.canvas), "canvas shows visible focus").toBe(true);

    const before = await viewer.shot();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    const orbitedLeft = await viewer.shot();
    expect(sameBytes(before, orbitedLeft), "ArrowLeft orbits").toBe(false);
    await page.keyboard.press("ArrowUp");
    const orbitedUp = await viewer.shot();
    expect(sameBytes(orbitedLeft, orbitedUp), "ArrowUp orbits").toBe(false);
    await page.keyboard.press("+");
    const zoomedIn = await viewer.shot();
    expect(sameBytes(orbitedUp, zoomedIn), "+ zooms").toBe(false);
    await page.keyboard.press("-");
    await page.keyboard.press("-");
    const zoomedOut = await viewer.shot();
    expect(sameBytes(zoomedIn, zoomedOut), "- zooms").toBe(false);
    // Arrow keys on the focused canvas must not scroll the page.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await viewer.isPlaying()).toBe(false);
    await expect(viewer.time).toHaveValue("1.5");
  });

  test("pointer drag orbits and wheel zooms on the canvas", async ({ page }) => {
    await installNetwork(page);
    const viewer = new Viewer(page);
    await viewer.open({ asset: RIGGED_ID, t: "0.5" });
    await viewer.expectReady();
    const box = await viewer.canvas.boundingBox();
    if (!box) throw new Error("canvas has no box");
    const before = await viewer.shot();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 10, { steps: 8 });
    await page.mouse.up();
    const dragged = await viewer.shot();
    expect(sameBytes(before, dragged), "drag orbits").toBe(false);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    expect(sameBytes(dragged, await viewer.shot()), "wheel zooms").toBe(false);
  });

  test("URL keeps asset, clip, t and view; reload restores the same paused frame", async ({ page }) => {
    await installNetwork(page, { injectFixtures: true });
    const viewer = new Viewer(page);
    await viewer.open({ asset: TWO_CLIPS_ID });
    await viewer.expectReady();

    const historyLength = await page.evaluate(() => history.length);
    await viewer.clip.selectOption({ index: 1 });
    await viewer.preset("Back").click();
    await viewer.seek("0.75");
    const params = await viewer.params();
    expect(params.get("asset")).toBe(TWO_CLIPS_ID);
    expect(params.get("clip")).toBe("1");
    expect(params.get("t")).toBe("0.75");
    expect(params.get("view")?.toLowerCase()).toBe("back");
    expect(await page.evaluate(() => history.length), "URL updates use history.replaceState").toBe(historyLength);
    const frame = await viewer.shot();

    await page.reload();
    await viewer.expectReady();
    await expect(viewer.clip.locator("option:checked")).toHaveText(new RegExp(SECOND_CLIP_NAME));
    await expect(viewer.time).toHaveValue("0.75");
    expect(await viewer.isPlaying()).toBe(false);
    expect(sameBytes(frame, await viewer.shot()), "reload restores the identical frame, clip and preset").toBe(true);

    // A deep link is honoured on first load too.
    await viewer.open({ asset: RIGGED_ID, clip: "0", t: "0.8", view: (params.get("view") ?? "back") });
    await viewer.expectReady();
    await expect(viewer.time).toHaveValue("0.8");
    expect(await viewer.isPlaying()).toBe(false);
    const deep = await viewer.shot();
    await viewer.preset("Front").click();
    await viewer.preset("Back").click();
    await viewer.seek("0.8");
    expect(sameBytes(deep, await viewer.shot()), "deep link view equals the Back preset at 0.8 s").toBe(true);
  });

  test("repeated navigation between the two eligible assets raises no page errors", async ({ page }) => {
    const errors = collectPageErrors(page);
    const log = await installNetwork(page);
    const viewer = new Viewer(page);
    for (let round = 0; round < 4; round += 1) {
      for (const asset of [rigged, simple]) {
        await viewer.open({ asset: asset.id, t: "0.5" });
        await viewer.expectReady();
        await expect(page.getByText(asset.id, { exact: false }).first()).toBeVisible();
        await expect(viewer.time).toHaveValue("0.5");
      }
    }
    await page.goBack();
    await viewer.expectReady();
    await expect(page.getByText(RIGGED_ID).first()).toBeVisible();
    await page.goForward();
    await viewer.expectReady();
    await expect(page.getByText(SIMPLE_ID).first()).toBeVisible();
    expect(errors).toEqual([]);
    expect(log.blocked, "the viewer needs no CDN or other network host").toEqual([]);
  });

  test("identifies the displayed artifact: catalog id, title, Original source, short SHA-256, license; provenance collapsed", async ({ page }) => {
    await installNetwork(page);
    const viewer = new Viewer(page);

    await viewer.open({ asset: RIGGED_ID });
    await viewer.expectReady();
    const body = page.locator("body");
    await expect(body).toContainText(RIGGED_ID);
    await expect(body).toContainText(rigged.title);
    await expect(body).toContainText("Original source");
    await expect(body).toContainText(rigged.source.sha256.slice(0, 8));
    await expect(body).toContainText(rigged.license.spdx);
    await expect(body).toContainText(rigged.license.attribution ?? "");
    await expect(body).toContainText(/bounds/i);
    await expect(body).toContainText(/\d(\.\d+)?\s?m\b/);
    await expect(body).toContainText(durationText(RIGGED_DURATION));

    const provenance = page.locator("details").filter({ hasText: rigged.source.url });
    await expect(provenance).toHaveCount(1);
    expect(await provenance.evaluate((details) => (details as HTMLDetailsElement).open), "provenance is collapsed").toBe(false);

    await expect(page.getByRole("link", { name: "compare/ranger/" })).toHaveAttribute("href", "../compare/ranger/");

    await viewer.open({ asset: SIMPLE_ID });
    await viewer.expectReady();
    await expect(body).toContainText(SIMPLE_ID);
    await expect(body).toContainText(simple.title);
    await expect(body).toContainText("Original source");
    await expect(body).toContainText(simple.source.sha256.slice(0, 8));
    await expect(body).toContainText(simple.license.spdx);
  });

  test("normal (>=900px) and narrow (390px) layouts without horizontal scrolling; screenshots saved as evidence", async ({ page }) => {
    await installNetwork(page);
    const viewer = new Viewer(page);
    const evidence = ensureEvidenceDir();

    for (const width of [1280, 900]) {
      await page.setViewportSize({ width, height: 800 });
      await viewer.open({ asset: RIGGED_ID, t: "0.6", view: "front" });
      await viewer.expectReady();
      const canvas = await viewer.canvas.boundingBox();
      const clip = await viewer.clip.boundingBox();
      if (!canvas || !clip) throw new Error("missing layout boxes");
      const beside = clip.x >= canvas.x + canvas.width - 1 || clip.x + clip.width <= canvas.x + 1;
      expect(beside, `at ${width}px the controls sit beside the canvas`).toBe(true);
      expect(clip.y).toBeLessThan(canvas.y + canvas.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      if (width === 1280) await page.screenshot({ path: path.join(evidence, "viewer-normal-1280.png"), fullPage: true });
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await viewer.open({ asset: RIGGED_ID, t: "0.6", view: "front" });
    await viewer.expectReady();
    const canvas = await viewer.canvas.boundingBox();
    const clip = await viewer.clip.boundingBox();
    if (!canvas || !clip) throw new Error("missing layout boxes");
    expect(canvas.width).toBeGreaterThan(200);
    expect(canvas.x + canvas.width).toBeLessThanOrEqual(390 + 0.5);
    expect(clip.y, "at 390px the controls stack below the canvas").toBeGreaterThanOrEqual(canvas.y + canvas.height - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    for (const control of [viewer.clip, viewer.playPause, viewer.time, viewer.slider, viewer.restPose, viewer.preset("Gameplay")]) {
      const box = await control.boundingBox();
      if (!box) throw new Error("control not laid out at 390px");
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390 + 0.5);
    }
    await page.screenshot({ path: path.join(evidence, "viewer-narrow-390.png"), fullPage: true });
  });

  test("supports the dark color scheme", async ({ page }) => {
    await installNetwork(page);
    await page.emulateMedia({ colorScheme: "dark" });
    const viewer = new Viewer(page);
    await viewer.open({ asset: RIGGED_ID, t: "0.6" });
    await viewer.expectReady();
    const colors = () => page.evaluate(() => {
      const style = getComputedStyle(document.body);
      return style.backgroundColor + " / " + style.color;
    });
    const dark = await colors();
    await page.emulateMedia({ colorScheme: "light" });
    const light = await colors();
    expect(dark).not.toBe(light);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: path.join(ensureEvidenceDir(), "viewer-dark-1280.png") });
  });
});

test.describe("rigged source animation viewer: entry points", () => {
  for (const asset of [RIGGED_ID, SIMPLE_ID]) {
    test(`asset page ${asset} links to its viewer as Inspect animation`, async ({ page }) => {
      await installNetwork(page);
      await page.goto(`assets/${encodeURIComponent(asset)}/`);
      const link = page.getByRole("link", { name: "Inspect animation", exact: true });
      await expect(link).toHaveCount(1);
      const href = await link.getAttribute("href");
      const target = new URL(href ?? "", page.url());
      expect(target.pathname).toMatch(/^\/viewer\/?(index\.html)?$/);
      expect(target.searchParams.get("asset")).toBe(asset);
      await link.click();
      const viewer = new Viewer(page);
      await viewer.expectReady();
      await expect(page.locator("body")).toContainText(asset);
    });
  }

  for (const asset of [NON_ELIGIBLE_ID, NON_ELIGIBLE_GLTF_ID]) {
    test(`non-eligible asset page ${asset} has no Inspect animation link`, async ({ page }) => {
      await installNetwork(page);
      await page.goto(`assets/${encodeURIComponent(asset)}/`);
      await expect(page.locator("h1")).toBeVisible();
      await expect(page.getByRole("link", { name: /inspect animation/i })).toHaveCount(0);
    });
  }

  test("the gallery is unchanged: no Inspect animation links", async ({ page }) => {
    await installNetwork(page);
    await page.goto("");
    await expect(page.getByRole("link", { name: /inspect animation/i })).toHaveCount(0);
  });
});

test.describe("rigged source animation viewer: failures", () => {
  test("unknown asset id shows an alert, renders nothing and fetches nothing", async ({ page }) => {
    const log = await installNetwork(page);
    const viewer = new Viewer(page);
    await viewer.open({ asset: UNKNOWN_ID });
    await viewer.expectFailure();
    expect(log.sourceRequests).toEqual([]);
  });

  test("missing asset parameter shows an alert and renders nothing", async ({ page }) => {
    const log = await installNetwork(page);
    const viewer = new Viewer(page);
    await page.goto("viewer/");
    await viewer.expectFailure();
    expect(log.sourceRequests).toEqual([]);
  });

  for (const asset of [NON_ELIGIBLE_ID, NON_ELIGIBLE_GLTF_ID]) {
    test(`non-eligible catalog asset ${asset} shows an alert and is never fetched`, async ({ page }) => {
      const log = await installNetwork(page);
      const viewer = new Viewer(page);
      await viewer.open({ asset });
      await viewer.expectFailure();
      expect(log.sourceRequests).toEqual([]);
    });
  }

  test("HTTP 404 shows an alert with Retry; Retry loads the asset once the source answers", async ({ page }) => {
    let failing = true;
    const respond: SourceResponder = async (route, url) => {
      if (failing) {
        await route.fulfill({ status: 404, body: "Not found", headers: { "access-control-allow-origin": "*" } });
        return;
      }
      await fulfillBytes(route, riggedBytes, url);
    };
    const log = await installNetwork(page, { override: new Map([[rigged.source.url, respond]]) });
    const viewer = new Viewer(page);
    await viewer.open({ asset: RIGGED_ID });
    await viewer.expectFailure();
    await expect(viewer.retry).toBeVisible();
    await expect(viewer.alert.first()).toContainText(/404|not found|http/i);

    failing = false;
    await viewer.retry.click();
    await viewer.expectReady();
    await expect(page.locator("body")).toContainText(RIGGED_ID);
    expect(log.sourceRequests.filter((url) => url === rigged.source.url).length).toBeGreaterThanOrEqual(2);
  });

  test("network failure shows an alert with Retry; Retry recovers", async ({ page }) => {
    let failing = true;
    const respond: SourceResponder = async (route, url) => {
      if (failing) {
        await route.abort("failed");
        return;
      }
      await fulfillBytes(route, simpleBytes, url);
    };
    await installNetwork(page, { override: new Map([[simple.source.url, respond]]) });
    const viewer = new Viewer(page);
    await viewer.open({ asset: SIMPLE_ID });
    await viewer.expectFailure();
    await expect(viewer.retry).toBeVisible();
    failing = false;
    await viewer.retry.click();
    await viewer.expectReady();
  });

  test("hash mismatch (same length, altered byte) is reported and never rendered", async ({ page }) => {
    const altered = new Uint8Array(riggedBytes);
    const index = altered.length - 9;
    altered[index] = (altered[index] ?? 0) ^ 0xff;
    const respond: SourceResponder = (route, url) => fulfillBytes(route, altered, url);
    await installNetwork(page, { override: new Map([[rigged.source.url, respond]]) });
    const viewer = new Viewer(page);
    await viewer.open({ asset: RIGGED_ID });
    await viewer.expectFailure(/sha-?256|hash|mismatch|integrity/i);
    await delay(500);
    await expect(page.locator("canvas:visible")).toHaveCount(0);
  });

  test("byte-length mismatch is reported and never rendered", async ({ page }) => {
    const longer = new Uint8Array(riggedBytes.length + 4);
    longer.set(riggedBytes);
    const respond: SourceResponder = (route, url) => fulfillBytes(route, longer, url);
    await installNetwork(page, { override: new Map([[rigged.source.url, respond]]) });
    const viewer = new Viewer(page);
    await viewer.open({ asset: RIGGED_ID });
    await viewer.expectFailure(/length|size|bytes|sha-?256|hash|mismatch|integrity/i);
  });

  test("renderer parse failure on correctly pinned bytes shows an alert and renders nothing", async ({ page }) => {
    const log = await installNetwork(page, { injectFixtures: true });
    const viewer = new Viewer(page);
    await viewer.open({ asset: MALFORMED_ID });
    await viewer.expectFailure();
    expect(log.sourceRequests.length, "the malformed source was fetched (it passed eligibility)").toBeGreaterThan(0);
    await expect(viewer.alert.first()).not.toContainText(/sha-?256|hash mismatch|integrity/i);
  });

  test("a source with no animation clips is reported as unsupported and no rest pose is shown", async ({ page }) => {
    const log = await installNetwork(page, { injectFixtures: true });
    const viewer = new Viewer(page);
    await viewer.open({ asset: NO_CLIPS_ID });
    await viewer.expectFailure(/no animation|unsupported|no clips/i);
    expect(log.sourceRequests.length).toBeGreaterThan(0);
  });
});

test.describe("rigged source animation viewer: cancellation and late responses", () => {
  test("a slow response for the previous asset never replaces the current asset", async ({ page }) => {
    const errors = collectPageErrors(page);
    let releaseSlow: () => void = () => undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let slowArrived: () => void = () => undefined;
    const slowRequested = new Promise<void>((resolve) => {
      slowArrived = resolve;
    });
    const slowRigged: SourceResponder = async (route, url) => {
      slowArrived();
      await slowGate;
      await fulfillBytes(route, riggedBytes, url).catch(() => undefined);
    };
    await installNetwork(page, { override: new Map([[rigged.source.url, slowRigged]]) });
    const viewer = new Viewer(page);

    await page.goto(viewerUrl({ asset: RIGGED_ID }), { waitUntil: "domcontentloaded" });
    await slowRequested;
    await viewer.open({ asset: SIMPLE_ID, t: "1" });
    await viewer.expectReady();
    const current = await viewer.shot();
    releaseSlow();
    await delay(1_000);
    await viewer.expectReady();
    await expect(page.locator("body")).toContainText(SIMPLE_ID);
    await expect(page.locator("body")).toContainText(simple.title);
    await expect(viewer.time).toHaveValue("1");
    expect(sameBytes(current, await viewer.shot()), "the current asset's frame is unchanged").toBe(true);
    expect(errors).toEqual([]);
  });

  test("a slow failing response for the previous asset never surfaces as an alert on the current one", async ({ page }) => {
    let releaseSlow: () => void = () => undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let slowArrived: () => void = () => undefined;
    const slowRequested = new Promise<void>((resolve) => {
      slowArrived = resolve;
    });
    const slowBroken: SourceResponder = async (route) => {
      slowArrived();
      await slowGate;
      await route.fulfill({ status: 500, body: "boom", headers: { "access-control-allow-origin": "*" } }).catch(() => undefined);
    };
    await installNetwork(page, { override: new Map([[simple.source.url, slowBroken]]) });
    const viewer = new Viewer(page);
    await page.goto(viewerUrl({ asset: SIMPLE_ID }), { waitUntil: "domcontentloaded" });
    await slowRequested;
    await viewer.open({ asset: RIGGED_ID, t: "0.5" });
    await viewer.expectReady();
    releaseSlow();
    await delay(1_000);
    await expect(viewer.alert).toHaveCount(0);
    await expect(page.locator("body")).toContainText(RIGGED_ID);
  });

  test("reload while a load is in flight shows only the reloaded result", async ({ page }) => {
    let calls = 0;
    let firstArrived: () => void = () => undefined;
    const firstRequested = new Promise<void>((resolve) => {
      firstArrived = resolve;
    });
    const respond: SourceResponder = async (route, url) => {
      calls += 1;
      if (calls === 1) {
        firstArrived();
        await delay(2_000);
        const altered = new Uint8Array(riggedBytes);
        altered[100] = (altered[100] ?? 0) ^ 0xff;
        await fulfillBytes(route, altered, url).catch(() => undefined);
        return;
      }
      await fulfillBytes(route, riggedBytes, url);
    };
    await installNetwork(page, { override: new Map([[rigged.source.url, respond]]) });
    const viewer = new Viewer(page);
    await page.goto(viewerUrl({ asset: RIGGED_ID, t: "0.4" }), { waitUntil: "domcontentloaded" });
    await firstRequested;
    await page.reload();
    await viewer.expectReady();
    await delay(2_500);
    await expect(viewer.alert).toHaveCount(0);
    await expect(viewer.time).toHaveValue("0.4");
  });
});

// Harness self-check: passes before the viewer exists. It proves the routed
// sources match their catalog pins byte for byte in the browser, the fixture
// entries are injected into the runtime catalog.json with valid pins, and CDNs
// are blocked, so viewer failures above are real.
test.describe("harness self-check", () => {
  test("routed sources match their pins in the browser and external hosts are blocked", async ({ page }) => {
    const log = await installNetwork(page, { injectFixtures: true });
    await page.goto("");
    const results = await page.evaluate(async () => {
      const hex = (buffer: ArrayBuffer) =>
        [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const catalog = (await (await fetch("catalog.json")).json()) as {
        assets: { id: string; source: { url: string; sha256: string; byteLength: number } }[];
      };
      const ids = [
        "khronos.riggedfigure-glb",
        "khronos.simpleskin-embedded-gltf",
        "test.simpleskin-two-clips-gltf",
        "test.simpleskin-no-clips-gltf",
        "test.malformed-glb",
        "test.simpleskin-odd-duration-gltf",
      ];
      const checked = [];
      for (const id of ids) {
        const asset = catalog.assets.find((entry) => entry.id === id);
        if (!asset) {
          checked.push({ id, ok: false, reason: "missing from catalog.json" });
          continue;
        }
        const bytes = await (await fetch(asset.source.url)).arrayBuffer();
        const digest = hex(await crypto.subtle.digest("SHA-256", bytes));
        checked.push({ id, ok: digest === asset.source.sha256 && bytes.byteLength === asset.source.byteLength, reason: digest });
      }
      const cdn = await fetch("https://cdn.jsdelivr.net/npm/@google/model-viewer@4.3.1/dist/model-viewer.min.js").then(
        () => "reached",
        () => "blocked",
      );
      return { checked, cdn };
    });
    for (const entry of results.checked) expect(entry, entry.id).toMatchObject({ ok: true });
    expect(results.cdn).toBe("blocked");
    expect(log.blocked.some((url) => url.startsWith("https://cdn.jsdelivr.net/"))).toBe(true);
  });
});

// Regressions from the #196 review. Each one failed on the code before its fix.
test.describe("rigged source animation viewer: review regressions", () => {
  test("clamping to a duration that is not a whole millisecond shows, keeps and seeks the same value", async ({ page }) => {
    await installNetwork(page, { injectFixtures: true });
    const viewer = new Viewer(page);
    await viewer.open({ asset: ODD_DURATION_ID });
    await viewer.expectReady();

    await viewer.seek("99");
    await expect(viewer.time).toHaveValue(ODD_DURATION_CLAMPED);
    expect(Number(await viewer.slider.inputValue())).toBe(Number(ODD_DURATION_CLAMPED));
    expect((await viewer.params()).get("t")).toBe(ODD_DURATION_CLAMPED);
    const clamped = await viewer.shot();

    await viewer.seek("0.5");
    expect(sameBytes(clamped, await viewer.shot()), "the fixture clip is animated near its end").toBe(false);
    await viewer.seek(ODD_DURATION_CLAMPED);
    await expect(viewer.time).toHaveValue(ODD_DURATION_CLAMPED);
    expect(sameBytes(clamped, await viewer.shot()), "a clamped seek renders the displayed time exactly").toBe(true);
  });

  test("a renderer exception while drawing a frame shows a failure with Retry, and Retry recovers", async ({ page }) => {
    // Test-side fault injection, no production hook: WebGL draw calls throw while
    // the page-global flag is set.
    await page.addInitScript(() => {
      const flags = window as unknown as { __assetToolingFailDraw?: boolean };
      const names = ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced", "drawRangeElements"];
      for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
        const methods = proto as unknown as Record<string, unknown>;
        for (const name of names) {
          const original = methods[name];
          if (typeof original !== "function") continue;
          methods[name] = function (this: unknown, ...args: unknown[]) {
            if (flags.__assetToolingFailDraw) throw new Error("injected draw failure (test)");
            return (original as (...inner: unknown[]) => unknown).apply(this, args);
          };
        }
      }
    });
    const errors = collectPageErrors(page);
    await installNetwork(page);
    const viewer = new Viewer(page);
    await viewer.open({ asset: RIGGED_ID, t: "0.5" });
    await viewer.expectReady();

    await page.evaluate(() => {
      (window as unknown as { __assetToolingFailDraw?: boolean }).__assetToolingFailDraw = true;
    });
    await viewer.preset("Side").click();
    await viewer.expectFailure();
    await expect(viewer.retry).toBeVisible();
    expect(errors, "the renderer exception is handled, not left uncaught").toEqual([]);

    await page.evaluate(() => {
      (window as unknown as { __assetToolingFailDraw?: boolean }).__assetToolingFailDraw = false;
    });
    await viewer.retry.click();
    await viewer.expectReady();
    const before = await viewer.shot();
    await viewer.seek("0.9");
    expect(sameBytes(before, await viewer.shot()), "the render loop is alive after Retry").toBe(false);
    expect(errors).toEqual([]);
  });

  test("a persisted pagehide (back-forward cache) releases renderer resources and a persisted pageshow rebuilds", async ({ page }) => {
    // Playwright's Chromium never restores pages from the back-forward cache
    // (notRestoredReasons is "masked" even with --disable-back-forward-cache
    // removed), so this dispatches the same PageTransitionEvents the browser
    // would fire, and counts WebGL deletions with test-side wrappers.
    await page.addInitScript(() => {
      const counter = window as unknown as { __assetToolingGlDeletes?: number };
      counter.__assetToolingGlDeletes = 0;
      const names = ["deleteBuffer", "deleteProgram", "deleteTexture", "deleteVertexArray", "deleteFramebuffer", "deleteRenderbuffer", "deleteShader"];
      for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
        const methods = proto as unknown as Record<string, unknown>;
        for (const name of names) {
          const original = methods[name];
          if (typeof original !== "function") continue;
          methods[name] = function (this: unknown, ...args: unknown[]) {
            counter.__assetToolingGlDeletes = (counter.__assetToolingGlDeletes ?? 0) + 1;
            return (original as (...inner: unknown[]) => unknown).apply(this, args);
          };
        }
      }
    });
    const errors = collectPageErrors(page);
    await installNetwork(page);
    const viewer = new Viewer(page);
    await viewer.open({ asset: RIGGED_ID, t: "0.5" });
    await viewer.expectReady();
    const before = await viewer.shot();

    const released = await page.evaluate(() => {
      const counter = window as unknown as { __assetToolingGlDeletes?: number };
      const start = counter.__assetToolingGlDeletes ?? 0;
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      return (counter.__assetToolingGlDeletes ?? 0) - start;
    });
    expect(released, "pagehide into the back-forward cache releases WebGL resources").toBeGreaterThan(0);

    const reloaded = page.waitForEvent("load");
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await reloaded;
    await viewer.expectReady();
    await expect(viewer.time).toHaveValue("0.5");
    expect(sameBytes(before, await viewer.shot()), "the rebuilt viewer renders the same frame").toBe(true);
    expect(errors).toEqual([]);
  });
});
