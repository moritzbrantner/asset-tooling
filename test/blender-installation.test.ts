import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installPinnedBlender } from "../scripts/blender-installation.ts";

test("Blender installation revalidates all files and reconciles drift from the pinned archive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blender-install-test-"));
  let cache;
  try {
    const source = path.join(root, "source");
    await mkdir(path.join(source, "blender-release"), { recursive: true });
    await writeFile(path.join(source, "blender-release/blender"), "fixture executable");
    await chmod(path.join(source, "blender-release/blender"), 0o755);
    await writeFile(path.join(source, "blender-release/runtime.py"), "trusted runtime");
    const archivePath = path.join(root, "fixture.tar");
    const packed = spawnSync("tar", ["-cf", archivePath, "-C", source, "blender-release"]);
    assert.equal(packed.status, 0);
    const bytes = await readFile(archivePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    cache = path.join(os.tmpdir(), `asset-tooling-blender-${sha256}.archive`);
    const release = {
      url: `data:application/octet-stream;base64,${bytes.toString("base64")}`,
      sha256,
      executable: "blender-release/blender",
    };
    const destination = path.join(root, "installation");
    const executable = await installPinnedBlender(destination, release);
    const original = await stat(executable);
    assert.equal(await installPinnedBlender(destination, release), executable);
    assert.equal((await stat(executable)).mtimeMs, original.mtimeMs);
    const runtime = path.join(destination, "blender-release/runtime.py");
    await writeFile(runtime, "modified runtime");
    await writeFile(path.join(destination, "unexpected"), "undeclared bytes");
    await installPinnedBlender(destination, release);
    assert.equal(await readFile(runtime, "utf8"), "trusted runtime");
    await assert.rejects(stat(path.join(destination, "unexpected")), { code: "ENOENT" });
    await writeFile(cache, "corrupt cached archive");
    await assert.rejects(installPinnedBlender(destination, release), /does not match pinned/);
    assert.equal(await readFile(runtime, "utf8"), "trusted runtime");
    await assert.rejects(installPinnedBlender(process.cwd(), release), /must not contain the workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (cache) await rm(cache, { force: true });
  }
});
