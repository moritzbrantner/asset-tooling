// Which Validate jobs a pull request's change set can affect (scripts/ci-impact.sh, .github/workflows/validate.yml).
// Pushes to main and change sets that cannot be listed completely run everything; a pull request runs a job only
// when a changed path lies in the source closure (scripts/source-closure.ts) of what that job executes:
//   bun scripts/ci-plan.ts --all
//   bun scripts/ci-plan.ts --changed <file with one path per line>
// It prints GitHub step outputs.
import path from "node:path";
import { readdirSync } from "node:fs";
import { sourceClosure, touches } from "./source-closure.ts";

const ROOT = path.resolve(import.meta.dir, "..");

/** A change to validation itself runs every job, so the edit proves each job still works. */
const VALIDATION = [".github/workflows/validate.yml", "scripts/ci-impact.sh", "scripts/ci-plan.ts", "scripts/source-closure.ts"];
/** Runtime and toolchain files every Bun job depends on. */
const RUNTIME = ["package.json", "bun.lock", "bunfig.toml", "tsconfig.json", "mise.toml", "scripts/install-ffmpeg.ts"];
/** Files every Blender run depends on besides its own recipe. */
const BLENDER_RUNTIME = ["adapters/blender/release.json", "adapters/blender/script_runner.py", "scripts/install-blender.ts"];
const BLENDER_DIR = "test/blender";

export type BlenderSuite = { suite: string; lfs: string; timeout?: number };

/** The Blender test suites, one CI job each, with the canonical payloads each one hydrates. */
export const BLENDER_SUITES: BlenderSuite[] = [
  {
    suite: "kits",
    lfs: "assets/authored/**,assets/canonical/quaternius.stylized-nature-megakit-standard.*/**,assets/canonical/poly-haven.fir-tree-01-*/**,assets/canonical/poly-haven.rock-boulder-dry-*/**,assets/canonical/poly-haven.mossy-rock-*/**,assets/canonical/quaternius.animal-pack-vol2.cat-blend/**,assets/canonical/quaternius.ultimate-animated-animals-shibainu-glb/**,assets/canonical/quaternius.easy-enemy-rat-glb/**",
  },
  {
    suite: "recipes",
    lfs: "assets/canonical/quaternius.universal-base-characters-standard.*/**,assets/canonical/quaternius.modular-character-outfits-fantasy-standard.*/**",
  },
  // The fortress kit's 51 recipe runs (17 pieces x 3 levels) take longer than the other kits together.
  {
    suite: "fortress",
    timeout: 60,
    lfs: "assets/canonical/poly-haven.broken-wall-*/**,assets/canonical/poly-haven.japanese-stone-wall-*/**,assets/canonical/poly-haven.stone-tiles-02-*/**,assets/canonical/poly-haven.old-planks-02-*/**",
  },
  // The climbing kit's 45 recipe runs (15 parts x 3 levels).
  { suite: "climbing", timeout: 30, lfs: "assets/canonical/quaternius.medieval-village-megakit-standard.t-vineleaf-png-png/**" },
];

/** Paths that run on every platform: the package's own code and tests, not the Linux-only build tooling. */
const CROSS_PLATFORM = /^(src\/(?!browser\/)|test\/(?!blender\/|browser\/|hydrated\/)|examples\/copy\/)/;
/** The Pages gallery's own sources, which the Pages build validates instead. */
const PAGES_ONLY = /^(src\/browser\/|test\/browser\/|src\/(animation-viewer-eligibility|animation-viewer-page|browser-pages-site|catalog-pages-site|catalog-pages|catalog-preview-hints|generated-gallery-assets|ranger-comparison)\.ts$|test\/(animation-viewer-eligibility|catalog-pages-site|catalog-pages|generated-gallery-assets|ranger-comparison)\.test\.ts$|scripts\/(build-catalog-pages|build-generated-previews|serve-pages)\.ts$|\.github\/workflows\/pages\.yml$)/;
const PAGES = /^(catalog\/|src\/|licenses\/|THIRD_PARTY_NOTICES\.md$|scripts\/|review\/|adapters\/blender\/|examples\/reconcile-file\.ts$|package\.json$|\.github\/workflows\/(pages|validate)\.yml$)/;
const DOCUMENTATION = /^docs\/|(^|\/)[^/]+\.md$/;

export type BlenderJob = { suite: string; lfs: string; timeout: number; tests: string };

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

function everything(): CiPlan {
  return {
    os: ALL_OS,
    blender: BLENDER_SUITES.map(({ suite, lfs, timeout }) => ({ suite, lfs, timeout: timeout ?? 15, tests: `${BLENDER_DIR}/${suite}` })),
    "selected-bundle-consumer": true,
    "canonical-storage": true,
    "processing-contract": true,
    stability: true,
    pages: true,
  };
}

/** The jobs `changed` can affect, or every job when the change set is unknown. */
export function ciPlan(changed: string[] | "all", root = ROOT): CiPlan {
  if (changed === "all" || changed.length === 0 || matches(VALIDATION, changed)) return everything();
  const code = changed.filter((file) => !DOCUMENTATION.test(file));
  const contract = code.filter((file) => !PAGES_ONLY.test(file));
  const runtime = matches(RUNTIME, code);

  // A Blender test runs when its own closure changed. A Blender adapter no test's closure reaches is loaded some
  // other way, so it runs every suite rather than none.
  const suites = BLENDER_SUITES.map((suite) => ({ suite, tests: files(`${BLENDER_DIR}/${suite.suite}`, ".test.ts", root) }));
  const closures = new Map(suites.flatMap(({ tests }) => tests).map((test) => [test, sourceClosure([test], root)]));
  const reached = new Set([...closures.values()].flat());
  const allBlender = runtime || matches(BLENDER_RUNTIME, code) ||
    code.some((file) => file.startsWith("adapters/blender/") && !reached.has(file));
  const blender = suites.flatMap(({ suite, tests }) => {
    const selected = allBlender || lfsMatches(suite.lfs, code) ? tests : tests.filter((test) => matches(closures.get(test)!, code));
    if (selected.length === 0) return [];
    const all = selected.length === tests.length;
    return [{ suite: suite.suite, lfs: suite.lfs, timeout: suite.timeout ?? 15, tests: all ? `${BLENDER_DIR}/${suite.suite}` : selected.join(" ") }];
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
    pages: changed.some((file) => PAGES.test(file)),
  };
}

/** GitHub step outputs: the matrices as JSON, each scoped job as true/false, and the jobs merge-ready may skip. */
export function stepOutputs(plan: CiPlan): string {
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
  let changed: string[] | "all";
  if (args.length === 1 && args[0] === "--all") changed = "all";
  else if (args.length === 2 && args[0] === "--changed") {
    changed = (await Bun.file(args[1]!).text()).split("\n").map((line) => line.trim()).filter(Boolean);
  } else throw new Error("usage: bun scripts/ci-plan.ts --all | --changed <file>");
  process.stdout.write(stepOutputs(ciPlan(changed)));
}
