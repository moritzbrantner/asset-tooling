import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { BLENDER_SUITES, ciPlan } from "../scripts/ci-plan.ts";

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
    const outputs = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }));
    return { ...outputs, os: JSON.parse(outputs.os!), skipped: JSON.parse(outputs["allow-skipped"]!) } as Record<string, any>;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const ALL_OS = ["ubuntu-latest", "macos-latest", "windows-latest"];
const SCOPED = ["selected-bundle-consumer", "blender-script", "canonical-storage", "processing-contract", "stability-validation", "pages-validation"];
const blenderTests = (changed: string[]) => Object.fromEntries(ciPlan(changed).blender.map(({ suite, tests }) => [suite, tests.split(" ")]));

test("documentation-only changes run only the Linux check", () => {
  const plan = classify(["docs/architecture.md\t"]);
  expect(plan.os).toEqual(["ubuntu-latest"]);
  expect(plan.skipped).toEqual(SCOPED);
});

test("gallery changes require Pages without the other platforms or contracts", () => {
  const plan = classify(["src/catalog-pages-site.ts\t"]);
  expect(plan.os).toEqual(["ubuntu-latest"]);
  expect(plan.skipped).toEqual(SCOPED.filter((job) => job !== "pages-validation"));
});

test("a source-to-documentation rename keeps source validation required", () => {
  const plan = classify(["docs/retired.md\tsrc/core.ts"]);
  expect(plan.os).toEqual(ALL_OS);
  expect(plan.stability).toBe("true");
  expect(plan.pages).toBe("true");
  expect(plan["blender-enabled"]).toBe("true");
});

test("test-only changes run every platform without Stability, Pages or Blender", () => {
  const plan = classify(["test/core.test.ts\t"]);
  expect(plan.os).toEqual(ALL_OS);
  expect(plan.skipped).toEqual(SCOPED);
});

test("Stability manifest changes require the contracts on Linux only", () => {
  const plan = classify(["stability/consumers.json\t"]);
  expect(plan.os).toEqual(["ubuntu-latest"]);
  expect(plan.skipped).toEqual(["selected-bundle-consumer", "blender-script", "canonical-storage", "pages-validation"]);
});

test("pushes, validation edits and runtime changes run every job", () => {
  for (const changed of ["all", [".github/workflows/validate.yml"], ["scripts/ci-plan.ts"], ["bun.lock"]] as const) {
    const plan = ciPlan(changed === "all" ? "all" : [...changed]);
    expect(plan.os).toEqual(ALL_OS);
    expect(plan.blender.map(({ suite, tests }) => [suite, tests])).toEqual(
      BLENDER_SUITES.map(({ suite }) => [suite, `test/blender/${suite}`]),
    );
    expect(plan["canonical-storage"] && plan["selected-bundle-consumer"] && plan.stability).toBe(true);
  }
});

test("a Blender recipe runs only the tests that load it, on Linux", () => {
  expect(blenderTests(["adapters/blender/tree.py"])).toEqual({ recipes: ["test/blender/recipes/tree-recipes.test.ts"] });
  expect(blenderTests(["adapters/blender/outpost.py"]).kits).toEqual(expect.arrayContaining(["test/blender/kits/outpost-kit.test.ts"]));
  expect(blenderTests(["adapters/blender/outpost.py"]).fortress).toBeUndefined();
  const plan = ciPlan(["adapters/blender/tree.py"]);
  expect(plan.os).toEqual(["ubuntu-latest"]);
  expect(plan.stability || plan["selected-bundle-consumer"]).toBe(false);
});

test("a helper a recipe loads at runtime selects every kit that loads it", () => {
  expect(blenderTests(["adapters/blender/kit_common.py"]).kits).toEqual(expect.arrayContaining([
    "test/blender/kits/outpost-kit.test.ts", "test/blender/kits/shrine-kit.test.ts", "test/blender/kits/crypt-kit.test.ts",
  ]));
});

test("a Blender adapter no test reaches, or the Blender runtime, runs every suite", () => {
  for (const file of ["adapters/blender/script_runner.py", "adapters/blender/release.json"]) {
    expect(Object.keys(blenderTests([file]))).toEqual(BLENDER_SUITES.map(({ suite }) => suite));
  }
});

test("a suite's canonical payload runs that whole suite", () => {
  expect(blenderTests(["assets/canonical/poly-haven.broken-wall-x/a.png"]).fortress).toEqual(["test/blender/fortress"]);
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
