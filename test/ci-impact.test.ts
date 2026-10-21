import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    "extended=false\nstability=false\npages=false\nallow-skipped=[\"selected-bundle-consumer\",\"blender-script\",\"canonical-storage\",\"processing-contract\",\"stability-validation\",\"pages-validation\"]\n",
  );
});

test("gallery changes require Pages while preserving existing contract exceptions", () => {
  expect(classify(["src/catalog-pages-site.ts\t"])).toBe(
    "extended=false\nstability=false\npages=true\nallow-skipped=[\"selected-bundle-consumer\",\"blender-script\",\"canonical-storage\",\"processing-contract\",\"stability-validation\"]\n",
  );
});

test("a source-to-documentation rename keeps source validation required", () => {
  expect(classify(["docs/retired.md\tsrc/core.ts"])).toBe(
    "extended=true\nstability=true\npages=true\nallow-skipped=[]\n",
  );
});

test("test-only changes select extended checks without Stability or Pages", () => {
  expect(classify(["test/core.test.ts\t"])).toBe(
    "extended=true\nstability=false\npages=false\nallow-skipped=[\"stability-validation\",\"pages-validation\"]\n",
  );
});

test("Stability manifest changes require all contracts without Pages", () => {
  expect(classify(["stability/consumers.json\t"])).toBe(
    "extended=true\nstability=true\npages=false\nallow-skipped=[\"pages-validation\"]\n",
  );
});

for (const key of ["consumers", "processors"]) {
  test(`${key} workflow matrix emission rejects empty and invalid manifests`, () => {
    const workflow = readFileSync(".github/workflows/stability.yml", "utf8");
    const command = workflow.split("\n").find(
      (line) =>
        line.includes("node -e '") && line.includes(`stability/${key}.json`),
    );
    if (!command) throw new Error(`Missing actual ${key} matrix command`);
    const root = mkdtempSync(join(tmpdir(), "asset-stability-matrix-"));
    try {
      mkdirSync(join(root, "stability"));
      const output = join(root, "output");
      const manifest = join(root, "stability", `${key}.json`);
      const invalidManifests = [
        "{",
        "{}",
        JSON.stringify({ [key]: [] }),
        JSON.stringify({ [key]: {} }),
      ];
      for (const invalid of invalidManifests) {
        writeFileSync(manifest, invalid);
        writeFileSync(output, "");
        const result = spawnSync("bash", ["-e", "-c", command], {
          cwd: root,
          env: { ...process.env, GITHUB_OUTPUT: output },
        });
        expect(result.status).not.toBe(0);
        expect(readFileSync(output, "utf8")).toBe("");
      }
      const accepted = JSON.parse(readFileSync(`stability/${key}.json`, "utf8"));
      writeFileSync(manifest, JSON.stringify(accepted));
      const result = spawnSync("bash", ["-e", "-c", command], {
        cwd: root,
        env: { ...process.env, GITHUB_OUTPUT: output },
      });
      expect(result.status).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(
        `matrix=${JSON.stringify({ include: accepted[key] })}\n`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
