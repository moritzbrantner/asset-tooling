import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

// Regression for the Codex P2 on PR #245: an option token after `--from` is a usage error, not a file name.
test("#245: `--from --bogus` is a usage error (exit 2), not a file name", () => {
  const script = path.join(import.meta.dir, "..", "scripts", "promote-catalog-lfs-source.ts");
  for (const args of [["acceptance.unregistered-source-245", "--from", "--bogus"], ["acceptance.unregistered-source-245", "--from", "-x"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, /usage/);
  }
});
