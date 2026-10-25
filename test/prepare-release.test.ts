import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { applyPins, findConsumers, loadConsumers, readArtifacts, uploadCommands, type Consumer } from "../scripts/prepare-release.ts";

const OLD = "a".repeat(64), NEW = "b".repeat(64);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "prepare-release-"));
  const artifacts = path.join(root, "artifacts"), checkout = path.join(root, "consumer");
  await mkdir(path.join(artifacts, "downloads"), { recursive: true });
  await mkdir(path.join(checkout, "scripts"), { recursive: true });
  await mkdir(path.join(checkout, "assets"), { recursive: true });
  await writeFile(path.join(artifacts, "kit.tar"), "tar");
  await writeFile(path.join(artifacts, "kit.tar.sha256"), `${NEW}  kit.tar\n`);
  await writeFile(path.join(artifacts, "export.ref.json"), '{"sha256":"new"}\n');
  await writeFile(path.join(artifacts, "lineage.json"), '{"release":"kit","new":true}\n');
  await writeFile(path.join(checkout, "scripts/fetch.sh"), `fetch_pinned other other.kit x \\\n  ${"c".repeat(64)} ref\nfetch_pinned kit kit x \\\n  ${OLD} assets/export.ref.json\n`);
  await writeFile(path.join(checkout, "assets/kit.pin.json"), `{\n  "release": "kit",\n  "tarSha256": "${OLD}"\n}\n`);
  await writeFile(path.join(checkout, "assets/export.ref.json"), '{"sha256":"old"}\n');
  await writeFile(path.join(checkout, "assets/lineage.json"), '{"release":"kit"}\n');
  return { artifacts, checkout };
}

describe("prepare-release", () => {
  test("finds pinned and unpinned consumers of a release", () => {
    const consumers: Consumer[] = [
      { repo: "o/a", release: "kit", pins: [{ type: "export-ref", path: "ref.json" }] },
      { repo: "o/b", release: "kit", pinned: false, note: "reads live" },
      { repo: "o/c", release: "other", pins: [{ type: "export-ref", path: "ref.json" }] },
    ];
    const found = findConsumers(consumers, "kit");
    expect(found.pinned.map((c) => c.repo)).toEqual(["o/a"]);
    expect(found.unpinned.map((c) => c.repo)).toEqual(["o/b"]);
    expect(() => findConsumers([{ repo: "o/d", release: "kit" }], "kit")).toThrow("lists no pins");
  });

  test("the committed consumer list pins the Ranger only in mmorpg", async () => {
    const found = findConsumers(await loadConsumers(), "humanoid-ranger-male");
    expect(found.pinned.map((c) => c.repo)).toEqual(["moenarch-games/mmorpg"]);
    expect(found.unpinned.map((c) => c.repo)).toContain("moenarch-games/arpg");
  });

  test("rewrites the tar sha256 after its anchor and copies pinned release files", async () => {
    const { artifacts: dir, checkout } = await fixture();
    const artifacts = await readArtifacts(dir);
    expect(artifacts).toMatchObject({ tar: "kit.tar", sha256: NEW, downloads: path.join(dir, "downloads") });
    expect(artifacts.releaseFiles).toEqual(["kit.tar", "kit.tar.sha256", "export.ref.json", "lineage.json"]);
    const pins = [
      { type: "tar-sha256", path: "scripts/fetch.sh", after: "fetch_pinned kit " },
      { type: "tar-sha256", path: "assets/kit.pin.json", after: '"tarSha256": "' },
      { type: "export-ref", path: "assets/export.ref.json" },
      { type: "file", from: "lineage.json", path: "assets/lineage.json" },
    ] as const;
    expect(await applyPins(checkout, [...pins], artifacts)).toEqual(["scripts/fetch.sh", "assets/kit.pin.json", "assets/export.ref.json", "assets/lineage.json"]);
    const script = await readFile(path.join(checkout, "scripts/fetch.sh"), "utf8");
    expect(script).toContain(`${"c".repeat(64)} ref`);
    expect(script).toContain(`  ${NEW} assets/export.ref.json`);
    expect(await readFile(path.join(checkout, "assets/kit.pin.json"), "utf8")).toBe(`{\n  "release": "kit",\n  "tarSha256": "${NEW}"\n}\n`);
    expect(await readFile(path.join(checkout, "assets/export.ref.json"), "utf8")).toBe('{"sha256":"new"}\n');
    expect(await applyPins(checkout, [...pins], artifacts)).toEqual([]);
  });

  test("refuses an ambiguous anchor or a release file the build lacks", async () => {
    const { artifacts: dir, checkout } = await fixture();
    const artifacts = await readArtifacts(dir);
    await expect(applyPins(checkout, [{ type: "tar-sha256", path: "scripts/fetch.sh", after: "fetch_pinned " }], artifacts)).rejects.toThrow("exactly once");
    await expect(applyPins(checkout, [{ type: "file", from: "kit.descriptor.json", path: "assets/lineage.json" }], artifacts)).rejects.toThrow("no kit.descriptor.json");
  });

  test("prints the owner's upload commands and one land line", () => {
    const dir = "/build/kit";
    const artifacts = { dir, tar: "kit.tar", sha256: NEW, releaseFiles: ["kit.tar", "kit.tar.sha256", "export.ref.json", "lineage.json"], downloads: `${dir}/downloads` };
    const { upload, land } = uploadCommands("kit", artifacts, [
      { repo: "o/a", number: 7, url: "https://github.com/o/a/pull/7", clone: "/c/a" },
      { repo: "o/b", number: 9, url: "https://github.com/o/b/pull/9", clone: "/c/b" },
    ]);
    expect(upload).toEqual([
      "gh release upload kit --repo moritzbrantner/asset-tooling /build/kit/kit.tar /build/kit/kit.tar.sha256 /build/kit/export.ref.json /build/kit/lineage.json --clobber",
      "gh release upload kit --repo moritzbrantner/asset-tooling /build/kit/downloads/* --clobber",
      "gh workflow run pages.yml --repo moritzbrantner/asset-tooling",
    ]);
    expect(land).toBe(
      "gh pr ready https://github.com/o/a/pull/7 && node ~/.local/share/coding-agent/workctl.mjs land o/a#7 --clone /c/a && " +
        "gh pr ready https://github.com/o/b/pull/9 && node ~/.local/share/coding-agent/workctl.mjs land o/b#9 --clone /c/b",
    );
  });
});
