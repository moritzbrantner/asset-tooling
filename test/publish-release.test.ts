import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readArtifacts, type Consumer } from "../scripts/prepare-release.ts";
import {
  MANUAL_RELEASES, ROLLING_RELEASES, blockingConsumers, plan, releaseFiles, releaseSources, rollingRelease, touches, type FetchFile,
} from "../scripts/publish-release.ts";

const OLD = "a".repeat(64), NEW = "b".repeat(64);

async function build() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "publish-release-"));
  await mkdir(path.join(dir, "bundle"));
  await writeFile(path.join(dir, "kit.tar"), "tar");
  await writeFile(path.join(dir, "kit.tar.sha256"), `${NEW}  kit.tar\n`);
  await writeFile(path.join(dir, "export.ref.json"), '{"sha256":"new","byteLength":1}\n');
  await writeFile(path.join(dir, "lineage.json"), "{}\n");
  await writeFile(path.join(dir, "spark.png"), "png");
  return dir;
}

describe("publish-release", () => {
  test("the dispatch choices list exactly the releases CI builds", async () => {
    const workflow = await readFile(path.join(import.meta.dir, "../.github/workflows/publish-releases.yml"), "utf8");
    const options = /options:\n((?:\s+- .+\n)+)/.exec(workflow)![1]!.trim().split("\n").map((line) => line.trim().replace(/^- /, ""));
    expect(options).toEqual(ROLLING_RELEASES.map((release) => release.name));
    for (const release of ROLLING_RELEASES) expect(MANUAL_RELEASES[release.name]).toBeUndefined();
  });

  test("every release CI builds has its build script, and Ranger stays manual", () => {
    for (const release of ROLLING_RELEASES) expect(releaseSources(release)).toContain(release.script);
    expect(() => rollingRelease("humanoid-ranger-male")).toThrow("Mixamo");
    expect(() => rollingRelease("humanoid-ranger-male-v9")).toThrow("unknown rolling release");
  });

  test("a release's sources follow its imports and the recipe files it names", () => {
    const settlement = releaseSources(rollingRelease("settlement-props"));
    expect(settlement).toEqual(expect.arrayContaining([
      "scripts/build-settlement-props.ts", "scripts/build-outpost-kit.ts", "adapters/blender/settlement_props.py",
      "adapters/blender/outpost.py", "adapters/blender/release.json", "src/asset-bundle.ts",
    ]));
    expect(settlement).not.toContain("adapters/blender");
    expect(releaseSources(rollingRelease("greyhaven-nature"))).toEqual(expect.arrayContaining(["assets/canonical", "catalog/storage.json"]));
    expect(touches(["assets/canonical"], "assets/canonical/a/b.glb")).toBe(true);
    expect(touches(["adapters/blender/outpost.py"], "adapters/blender/outpost.pyc")).toBe(false);
  });

  test("plans only the releases a change touches", () => {
    expect(plan(["adapters/blender/outpost.py"]).map((entry) => entry.release)).toEqual(["outpost-kit", "settlement-props"]);
    expect(plan(["adapters/blender/zoo_scenery.py"])).toEqual([{ release: "zoo-scenery", blender: true, lfs: false }]);
    expect(plan(["docs/outpost-kit.md", "README.md", "consumers.json", ".github/workflows/publish-releases.yml"])).toEqual([]);
    expect(plan("all")).toHaveLength(ROLLING_RELEASES.length);
  });

  test("uploads every top-level build file with export.ref.json last", async () => {
    expect(await releaseFiles(await build())).toEqual(["kit.tar", "kit.tar.sha256", "lineage.json", "spark.png", "export.ref.json"]);
  });

  test("a pinned consumer blocks unless its default or re-pin branch pins the new build", async () => {
    const dir = await build();
    const artifacts = { ...(await readArtifacts(dir)), releaseFiles: await releaseFiles(dir) };
    const consumers: Consumer[] = [
      { repo: "o/live", release: "kit", pinned: false },
      { repo: "o/pinned", release: "kit", pins: [{ type: "tar-sha256", path: "pin.json", after: '"tarSha256": "' }, { type: "export-ref", path: "export.ref.json" }] },
    ];
    const files = (branches: Record<string, Record<string, string>>): FetchFile => (_repo, file, ref) => branches[ref ?? "main"]?.[file];
    const stale = { "pin.json": `{ "tarSha256": "${OLD}" }`, "export.ref.json": '{"sha256":"old","byteLength":1}' };
    const fresh = { "pin.json": `{ "tarSha256": "${NEW}" }`, "export.ref.json": '{\n  "byteLength": 1,\n  "sha256": "new"\n}\n' };
    expect(await blockingConsumers(consumers, "kit", artifacts, files({ main: stale }))).toEqual(["o/pinned"]);
    expect(await blockingConsumers(consumers, "kit", artifacts, files({ main: fresh }))).toEqual([]);
    expect(await blockingConsumers(consumers, "kit", artifacts, files({ main: stale, "agent/repin-kit": fresh }))).toEqual([]);
    expect(await blockingConsumers(consumers, "kit", artifacts, files({ main: { ...fresh, "pin.json": stale["pin.json"] } }))).toEqual(["o/pinned"]);
    expect(await blockingConsumers(consumers, "kit", artifacts, files({}))).toEqual(["o/pinned"]);
  });
});
