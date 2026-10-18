import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const classify = (rows: string[]) => {
  const root = mkdtempSync(join(tmpdir(), "asset-ci-impact-"));
  try {
    writeFileSync(join(root, "paths.tsv"), `${rows.join("\n")}\n`);
    writeFileSync(join(root, "gh"), '#!/bin/sh\ncat "$(dirname "$0")/paths.tsv"\n', {
      mode: 0o755,
    });
    const output = join(root, "output");
    const result = spawnSync("bash", [resolve("scripts/ci-impact.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REPOSITORY: "fixture/asset-tooling",
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: root,
        PR_NUMBER: "1",
        PR_CHANGED_FILES: String(rows.length),
      },
    });
    expect(result.status).toBe(0);
    return readFileSync(output, "utf8");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("documentation-only changes keep all expensive scopes disabled", () => {
  expect(classify(["docs/architecture.md\t"])).toBe(
    "extended=false\nstability=false\npages=false\n",
  );
});

test("gallery changes require Pages while preserving existing contract exceptions", () => {
  expect(classify(["src/catalog-pages-site.ts\t"])).toBe(
    "extended=false\nstability=false\npages=true\n",
  );
});

test("a source-to-documentation rename keeps source validation required", () => {
  expect(classify(["docs/retired.md\tsrc/core.ts"])).toBe(
    "extended=true\nstability=true\npages=true\n",
  );
});
