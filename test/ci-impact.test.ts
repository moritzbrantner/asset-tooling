import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { BLENDER_SUITES, ciPlan } from "../scripts/ci-plan.ts";

const classify = (rows: string[], event: Record<string, string> = {}, cwd?: string) => {
  const root = mkdtempSync(join(tmpdir(), "asset-ci-impact-"));
  try {
    writeFileSync(join(root, "paths.tsv"), `${rows.join("\n")}\n`);
    writeFileSync(join(root, "gh"), '#!/bin/sh\ncat "$(dirname "$0")/paths.tsv"\n', {
      mode: 0o755,
    });
    const output = join(root, "output");
    const result = spawnSync("bash", [resolve("scripts/ci-impact.sh")], {
      encoding: "utf8",
      cwd,
      env: {
        ...process.env,
        PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REPOSITORY: "fixture/asset-tooling",
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: root,
        PR_NUMBER: "1",
        PR_CHANGED_FILES: String(rows.length),
        ...event,
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

test("every Blender suite directory has its own suite.json", () => {
  const dirs = readdirSync("test/blender", { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  expect(BLENDER_SUITES.map(({ suite }) => suite)).toEqual(dirs);
  expect(BLENDER_SUITES.find(({ suite }) => suite === "fortress")).toMatchObject({ timeout: 60, ktx: true });
});

test("one kit's own data runs only that kit's tests (#574)", () => {
  // A suite's suite.json runs that whole suite and no other.
  expect(blenderTests(["test/blender/moss/suite.json"])).toEqual({ moss: ["test/blender/moss"] });
  // A release file (its runner needs and cost budget) runs the tests that build that release.
  expect(blenderTests(["releases/ivy.json"])).toEqual({ kits: ["test/blender/kits/ivy.test.ts"] });
  expect(blenderTests(["releases/river-stones.json"])).toEqual({ "river-stones": ["test/blender/river-stones"] });
  const plan = ciPlan(["releases/ivy.json", "test/blender/moss/suite.json"]);
  expect(plan.os).toEqual(["ubuntu-latest"]);
  expect(plan["canonical-storage"] || plan["selected-bundle-consumer"] || plan.stability || plan.pages).toBe(false);
});

test("a release file the tree no longer holds counts as a change to the release loader", () => {
  expect(blenderTests(["releases/retired-kit.json"])).toEqual(blenderTests(["scripts/release-data.ts"]));
  expect(Object.keys(blenderTests(["scripts/release-data.ts"]))).toEqual(expect.arrayContaining(["kits", "crag", "moss", "river-stones"]));
});

test("shared kit code still runs every kit it reaches", () => {
  const kitBundle = blenderTests(["src/kit-bundle.ts"]);
  expect(Object.keys(kitBundle).length).toBeGreaterThan(5);
  expect(blenderTests(["scripts/report-kit-costs.ts"]).kits).toEqual(expect.arrayContaining(["test/blender/kits/ivy.test.ts", "test/blender/kits/sandstone-kit.test.ts"]));
});

test("a push plans from its own diff, without the pull-request-only jobs", () => {
  const repo = mkdtempSync(join(tmpdir(), "asset-ci-push-"));
  try {
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-c", "user.name=ci", "-c", "user.email=ci@example.invalid", ...args], { cwd: repo, encoding: "utf8" });
      expect(result.status).toBe(0);
      return result.stdout.trim();
    };
    git("init", "-q");
    mkdirSync(join(repo, "releases"));
    writeFileSync(join(repo, "releases/ivy.json"), "{}\n");
    git("add", ".");
    git("commit", "-qm", "before");
    const before = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "releases/ivy.json"), "{\"changed\": true}\n");
    git("commit", "-qam", "after");
    const plan = classify([], { GITHUB_EVENT_NAME: "push", BEFORE: before, GITHUB_SHA: git("rev-parse", "HEAD") }, repo);
    expect(plan.os).toEqual(["ubuntu-latest"]);
    expect(JSON.parse(plan.blender).include.map(({ tests }: { tests: string }) => tests)).toEqual(["test/blender/kits/ivy.test.ts"]);
    expect(plan.skipped).toEqual(SCOPED.filter((job) => job !== "blender-script"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("an unknown push parent, the schedule and a dispatch run everything but the pull-request-only jobs", () => {
  for (const event of [{ GITHUB_EVENT_NAME: "push", BEFORE: "0".repeat(40), GITHUB_SHA: "f".repeat(40) }, { GITHUB_EVENT_NAME: "schedule" }, { GITHUB_EVENT_NAME: "workflow_dispatch" }]) {
    const plan = classify([], event);
    expect(plan.os).toEqual(ALL_OS);
    expect(JSON.parse(plan.blender).include.map(({ suite }: { suite: string }) => suite)).toEqual(BLENDER_SUITES.map(({ suite }) => suite));
    expect(plan.skipped).toEqual(["stability-validation", "pages-validation"]);
  }
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
