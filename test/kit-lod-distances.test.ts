import { describe, expect, test } from "bun:test";
import { KIT_LOD_SCALE_CAP, scaledLodDistances } from "../src/kit-bundle.ts";

const across = (width: number, height = 0.5, depth = 0.5) => ({ min: [-width / 2, 0, -depth / 2], max: [width / 2, height, depth / 2] });

describe("kit LOD distances", () => {
  test("a piece up to 1 m across keeps the base distances", () => {
    expect(scaledLodDistances([60, 180], across(0.3))).toEqual([60, 180]);
    expect(scaledLodDistances([60, 180], across(1))).toEqual([60, 180]);
  });

  test("a larger piece switches further out, in proportion to its widest side", () => {
    expect(scaledLodDistances([60, 180], across(3))).toEqual([180, 540]);
    expect(scaledLodDistances([60, 180], across(0.5, 2.5))).toEqual([150, 450]);
    expect(scaledLodDistances([60, 180], across(0.5, 0.5, 1.5))).toEqual([90, 270]);
  });

  test("the growth stops at the cap", () => {
    expect(scaledLodDistances([60, 180], across(5))).toEqual([60 * KIT_LOD_SCALE_CAP, 180 * KIT_LOD_SCALE_CAP]);
    expect(scaledLodDistances([60, 180], across(20))).toEqual(scaledLodDistances([60, 180], across(5)));
  });
});
