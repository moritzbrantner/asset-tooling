// Which Validate jobs a change set can affect (scripts/ci-impact.sh, .github/workflows/validate.yml). A pull request
// or a push to main runs a job only when a changed path lies in the source closure (scripts/source-closure.ts) of what
// that job executes. Change sets that cannot be listed completely, the nightly schedule and a manual dispatch run
// everything. Per-kit data stays out of shared code (#574): each Blender suite's test/blender/<suite>/suite.json and
// each rolling release's releases/<name>.json, so adding a kit selects only that kit's tests:
//   bun scripts/ci-plan.ts [--branch] --all
//   bun scripts/ci-plan.ts [--branch] --changed <file with one path per line>
// It prints GitHub step outputs; --branch marks a run outside a pull request.
import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { sourceClosure, touches } from "./source-closure.ts";

const ROOT = path.resolve(import.meta.dir, "..");

/** A change to validation itself runs every job, so the edit proves each job still works. */
const VALIDATION = [".github/workflows/validate.yml", "scripts/ci-impact.sh", "scripts/ci-plan.ts", "scripts/source-closure.ts"];
/** Runtime and toolchain files every Bun job depends on. */
const RUNTIME = ["package.json", "bun.lock", "bunfig.toml", "tsconfig.json", "mise.toml", "scripts/install-ffmpeg.ts"];
/** Files every Blender run depends on besides its own recipe. */
const BLENDER_RUNTIME = ["adapters/blender/release.json", "adapters/blender/script_runner.py", "scripts/install-blender.ts"];
const BLENDER_DIR = "test/blender";
/** `ktx`: the suite's builds encode KTX2 textures, so its job installs KTX-Software. */
export type BlenderSuite = { suite: string; lfs: string; timeout?: number; ktx?: boolean };

/** Each suite's own data file: `test/blender/<suite>/suite.json`, so adding a suite edits no shared file (#574). */
const SUITE_FILE = "suite.json";
const SUITE_KEYS = new Set(["note", "lfs", "timeout", "ktx"]);

/**
 * The Blender test suites, one CI job each: every directory under test/blender, with the canonical payloads its
 * suite.json hydrates (`lfs`), its job timeout in minutes and whether it needs KTX-Software.
 */
export function blenderSuites(root = ROOT): BlenderSuite[] {
  return readdirSync(path.join(root, BLENDER_DIR), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((suite) => {
      const file = `${BLENDER_DIR}/${suite}/${SUITE_FILE}`;
      const data = JSON.parse(readFileSync(path.join(root, file), "utf8")) as { lfs?: unknown; timeout?: number; ktx?: boolean };
      const unknown = Object.keys(data).filter((key) => !SUITE_KEYS.has(key));
      if (unknown.length) throw new Error(`${file}: unknown keys ${unknown.join(", ")}`);
      if (!Array.isArray(data.lfs) || !data.lfs.every((glob) => typeof glob === "string" && glob)) throw new Error(`${file}: lfs must list path globs`);
      return { suite, lfs: data.lfs.join(","), ...(data.timeout === undefined ? {} : { timeout: data.timeout }), ...(data.ktx === undefined ? {} : { ktx: data.ktx }) };
    });
}

export const BLENDER_SUITES: BlenderSuite[] = blenderSuites();

/** Paths that run on every platform: the package's own code and tests, not the Linux-only build tooling. */
const CROSS_PLATFORM = /^(src\/(?!browser\/)|test\/(?!blender\/|browser\/|hydrated\/)|examples\/copy\/)/;
/** The Pages gallery's own sources, which the Pages build validates instead. */
const PAGES_ONLY = /^(src\/browser\/|test\/browser\/|src\/(animation-viewer-eligibility|animation-viewer-page|browser-pages-site|catalog-pages-site|catalog-pages|catalog-preview-hints|generated-gallery-assets|ranger-comparison|young-residents-page)\.ts$|test\/(animation-viewer-eligibility|catalog-pages-site|catalog-pages|generated-gallery-assets|ranger-comparison|young-residents-page)\.test\.ts$|scripts\/(build-catalog-pages|build-generated-previews|serve-pages)\.ts$|\.github\/workflows\/pages\.yml$)/;
const PAGES = /^(catalog\/|src\/|licenses\/|THIRD_PARTY_NOTICES\.md$|scripts\/|review\/|adapters\/blender\/|examples\/reconcile-file\.ts$|package\.json$|\.github\/workflows\/(pages|validate)\.yml$)/;
const DOCUMENTATION = /^docs\/|(^|\/)[^/]+\.md$/;

export type BlenderJob = { suite: string; lfs: string; timeout: number; ktx: boolean; tests: string };

export type CiPlan = {
  os: string[];
  blender: BlenderJob[];
  "selected-bundle-consumer": boolean;
  "canonical-storage": boolean;
  "processing-contract": boolean;
  stability: boolean;
  pages: boolean;
};

const ALL_OS = ["ubuntu-latest", "macos-latest", "windows-latest"];

function files(dir: string, suffix: string, root: string): string[] {
  return readdirSync(path.join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(suffix))
    .map((name) => `${dir}/${name.split(path.sep).join("/")}`)
    .sort();
}

const matches = (sources: string[], changed: string[]) => changed.some((file) => touches(sources, file));

function lfsMatches(lfs: string, changed: string[]): boolean {
  const globs = lfs.split(",").map((pattern) => new Bun.Glob(pattern));
  return changed.some((file) => globs.some((glob) => glob.match(file)));
}

/**
 * A release's data file (releases/<name>.json, scripts/release-data.ts) is configuration of its build script, so it
 * counts as a change to that script: the tests that build the release run, no others. A file the tree no longer
 * holds, or cannot be read, counts as a change to the loader instead, which every test reading release data reaches.
 */
function withReleaseScripts(changed: string[], root: string): string[] {
  const scripts = changed.flatMap((file) => {
    if (!/^releases\/[^/]+\.json$/.test(file)) return [];
    try {
      const { script } = JSON.parse(readFileSync(path.join(root, file), "utf8")) as { script?: unknown };
      if (typeof script === "string") return [script];
    } catch {}
    return ["scripts/release-data.ts"];
  });
  return [...new Set([...changed, ...scripts])];
}

function everything(root: string): CiPlan {
  return {
    os: ALL_OS,
    blender: blenderSuites(root).map(({ suite, lfs, timeout, ktx }) => ({ suite, lfs, timeout: timeout ?? 15, ktx: !!ktx, tests: `${BLENDER_DIR}/${suite}` })),
    "selected-bundle-consumer": true,
    "canonical-storage": true,
    "processing-contract": true,
    stability: true,
    pages: true,
  };
}

/** The jobs `changed` can affect, or every job when the change set is unknown. */
export function ciPlan(changed: string[] | "all", root = ROOT): CiPlan {
  if (changed === "all" || changed.length === 0 || matches(VALIDATION, changed)) return everything(root);
  // The Pages build reads no release data, so Pages follows the listed paths only.
  const listed = changed;
  changed = withReleaseScripts(changed, root);
  const code = changed.filter((file) => !DOCUMENTATION.test(file));
  const contract = code.filter((file) => !PAGES_ONLY.test(file));
  const runtime = matches(RUNTIME, code);

  // A Blender test runs when its own closure changed. A Blender adapter no test's closure reaches is loaded some
  // other way, so it runs every suite rather than none. A suite's own suite.json or canonical payloads run that
  // whole suite.
  const suites = blenderSuites(root).map((suite) => ({ suite, tests: files(`${BLENDER_DIR}/${suite.suite}`, ".test.ts", root) }));
  const closures = new Map(suites.flatMap(({ tests }) => tests).map((test) => [test, sourceClosure([test], root)]));
  const reached = new Set([...closures.values()].flat());
  const allBlender = runtime || matches(BLENDER_RUNTIME, code) ||
    code.some((file) => file.startsWith("adapters/blender/") && !reached.has(file));
  const blender = suites.flatMap(({ suite, tests }) => {
    const whole = allBlender || lfsMatches(suite.lfs, code) || code.includes(`${BLENDER_DIR}/${suite.suite}/${SUITE_FILE}`);
    const selected = whole ? tests : tests.filter((test) => matches(closures.get(test)!, code));
    if (selected.length === 0) return [];
    const all = selected.length === tests.length;
    return [{ suite: suite.suite, lfs: suite.lfs, timeout: suite.timeout ?? 15, ktx: !!suite.ktx, tests: all ? `${BLENDER_DIR}/${suite.suite}` : selected.join(" ") }];
  });

  const hydrated = files("test/hydrated", ".ts", root);
  const python = files("scripts", ".py", root);
  return {
    os: contract.some((file) => CROSS_PLATFORM.test(file)) || runtime ? ALL_OS : ["ubuntu-latest"],
    blender,
    "selected-bundle-consumer": runtime || matches(sourceClosure(["scripts/verify-bundle-consumer.ts"], root), code),
    "canonical-storage": runtime || matches(["assets/canonical", "catalog", ".gitattributes", ...sourceClosure(["scripts/verify-catalog-storage.ts", ...hydrated], root)], code),
    "processing-contract": matches(["requirements-validation.txt", "examples", "schemas", "stability", ...python], code),
    stability: runtime || matches([
      "stability", ".github/workflows/stability.yml",
      ...sourceClosure(["src/entry.ts", "scripts/check-stability.ts", "scripts/check-processor-contract.ts", "scripts/check-scene-processor-contract.ts", "scripts/check-workflow-bridge.ts"], root),
    ], contract.filter((file) => !file.startsWith("test/"))),
    pages: listed.some((file) => PAGES.test(file)),
  };
}

/**
 * GitHub step outputs: the matrices as JSON, each scoped job as true/false, and the jobs merge-ready may skip. A
 * branch run (a push, the nightly schedule or a manual dispatch) never runs the pull-request-only Stability and Pages
 * validation jobs.
 */
export function stepOutputs(planned: CiPlan, { branch = false } = {}): string {
  const plan = branch ? { ...planned, stability: false, pages: false } : planned;
  const jobs = {
    "selected-bundle-consumer": plan["selected-bundle-consumer"],
    "blender-script": plan.blender.length > 0,
    "canonical-storage": plan["canonical-storage"],
    "processing-contract": plan["processing-contract"],
    "stability-validation": plan.stability,
    "pages-validation": plan.pages,
  };
  const skipped = Object.entries(jobs).filter(([, run]) => !run).map(([job]) => job);
  return [
    `os=${JSON.stringify(plan.os)}`,
    `blender=${JSON.stringify({ include: plan.blender })}`,
    `blender-enabled=${jobs["blender-script"]}`,
    `selected-bundle-consumer=${plan["selected-bundle-consumer"]}`,
    `canonical-storage=${plan["canonical-storage"]}`,
    `processing-contract=${plan["processing-contract"]}`,
    `stability=${plan.stability}`,
    `pages=${plan.pages}`,
    `allow-skipped=${JSON.stringify(skipped)}`,
  ].join("\n") + "\n";
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const branch = args[0] === "--branch";
  if (branch) args.shift();
  let changed: string[] | "all";
  if (args.length === 1 && args[0] === "--all") changed = "all";
  else if (args.length === 2 && args[0] === "--changed") {
    changed = (await Bun.file(args[1]!).text()).split("\n").map((line) => line.trim()).filter(Boolean);
  } else throw new Error("usage: bun scripts/ci-plan.ts [--branch] --all | --changed <file>");
  process.stdout.write(stepOutputs(ciPlan(changed), { branch }));
}
