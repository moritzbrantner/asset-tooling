import { afterEach, describe, expect, test } from "bun:test";
import { kitTextureTarget, setKitTextureMode, takeKitTextureMode } from "../src/kit-bundle.ts";

afterEach(() => setKitTextureMode("full"));

describe("kit texture modes", () => {
  test("full keeps power-of-two sizes and rounds others to the nearest power of two", () => {
    expect(kitTextureTarget(2048, 1024)).toEqual({ width: 2048, height: 1024 });
    expect(kitTextureTarget(1008, 981)).toEqual({ width: 1024, height: 1024 });
  });

  test("half halves every edge", () => {
    setKitTextureMode("half");
    expect(kitTextureTarget(4096, 4096)).toEqual({ width: 2048, height: 2048 });
    expect(kitTextureTarget(2048, 512)).toEqual({ width: 1024, height: 256 });
  });

  test("the command-line option is removed from the arguments and selects the mode", () => {
    const argv = ["bun", "build.ts", "--textures", "half", "--out", "dir"];
    expect(takeKitTextureMode(argv)).toBe("half");
    expect(argv).toEqual(["bun", "build.ts", "--out", "dir"]);
    expect(kitTextureTarget(1024, 1024)).toEqual({ width: 512, height: 512 });
  });

  test("an unknown mode fails, and no option leaves full selected", () => {
    expect(() => takeKitTextureMode(["--textures", "quarter", "--out", "dir"])).toThrow("--textures must be one of full, half");
    expect(takeKitTextureMode(["--out", "dir"])).toBe("full");
  });
});
