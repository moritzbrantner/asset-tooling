// Rebuild and publish rolling releases from CI (#397, README "Publishing a rolling release"). The
// `Publish rolling releases` workflow runs it on every push to main and on a manual dispatch per release:
//   bun scripts/publish-release.ts plan --changed <file>    # releases whose sources a push changed, as a matrix
//   bun scripts/publish-release.ts plan --release <name>    # one release (workflow_dispatch)
//   bun scripts/publish-release.ts build <release> <out>    # run the release's maintained build into <out>
//   bun scripts/publish-release.ts publish <release> <out> [--dry-run]
// `publish` uploads every top-level file of <out> to the one rolling release with --clobber (Atlas Decision 7.1.5,
// never a numbered release). It verifies the tar against its export.ref.json first, skips the upload when the live
// release already holds the same tar, and refuses when a consumer in consumers.json pins the release and neither
// its default branch nor its open `agent/repin-<release>` branch (scripts/prepare-release.ts) pins the new build.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { findConsumers, loadConsumers, readArtifacts, type Artifacts, type Consumer, type Pin } from "./prepare-release.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const TOOLING_REPO = process.env.GITHUB_REPOSITORY ?? "moritzbrantner/asset-tooling";

export type RollingRelease = {
  name: string;
  /** The build script under scripts/, run as `bun <script> --out <out> ...args`. */
  script: string;
  args?: string[];
  /** Needs Blender (adapters/blender/release.json) for external.blender.script@1. */
  blender?: boolean;
  /** Needs the hydrated Git LFS payloads under assets/canonical/. */
  lfs?: boolean;
  /**
   * Needs this stability/processors.json processor: the workflow checks out its pinned repository and commit with
   * its cargo dependencies and names the checkout in ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB.
   */
  processor?: string;
  /** Needs KTX-Software's `ktx` CLI for KTX2 downloads. */
  ktx?: boolean;
  /** The publish job's timeout, when the build needs more than DEFAULT_TIMEOUT_MINUTES. */
  timeoutMinutes?: number;
};

export const DEFAULT_TIMEOUT_MINUTES = 60;
/** The Ranger builds the whole bundle (clips, armour, levels of detail, appearance) in one run, about 1.5 h locally. */
const RANGER = { script: "scripts/build-ranger-release.ts", blender: true, lfs: true, processor: "three-d-animation-retarget", ktx: true, timeoutMinutes: 240 };

/** Every rolling release CI rebuilds. The workflow's dispatch choices must list exactly these names. */
export const ROLLING_RELEASES: RollingRelease[] = [
  { name: "combat-effects", script: "scripts/build-combat-effects.ts" },
  { name: "combat-sounds", script: "scripts/build-combat-sounds.ts", lfs: true },
  { name: "farm-structures", script: "scripts/build-farm-structures.ts", blender: true },
  { name: "fortress-kit", script: "scripts/build-fortress-kit.ts", blender: true, lfs: true },
  { name: "greyhaven-ambient-animals", script: "scripts/build-greyhaven-ambient-animals.ts", blender: true, lfs: true },
  { name: "greyhaven-marshal-house", script: "scripts/build-greyhaven-marshal-house.ts", blender: true },
  { name: "greyhaven-nature", script: "scripts/build-greyhaven-nature.ts", blender: true, lfs: true },
  // #399: each figure is its own release, so the two build in parallel jobs.
  { name: "humanoid-ranger-female", ...RANGER, args: ["--figure", "female"] },
  { name: "humanoid-ranger-male", ...RANGER, args: ["--figure", "male"] },
  { name: "outpost-kit", script: "scripts/build-outpost-kit.ts", blender: true },
  { name: "settlement-props", script: "scripts/build-settlement-props.ts", blender: true },
  { name: "shrine-kit", script: "scripts/build-shrine-kit.ts", blender: true },
  { name: "zoo-effects", script: "scripts/build-zoo-effects.ts" },
  { name: "zoo-scenery", script: "scripts/build-zoo-scenery.ts", blender: true },
];

/** Rolling releases CI cannot rebuild yet, and why. They are still published by hand. */
export const MANUAL_RELEASES: Record<string, string> = {
  "greyhaven-starter": "its release adds KTX2 per-entry downloads and hand-framed composition renders that no single build script produces",
  "farm-crops": "no maintained build script packs its wheat.tar and corn.tar release layout (examples/wheat and examples/corn stop at the package)",
};

/** Files every build depends on besides its own import graph. The publishing scripts and consumers.json change no build output. */
const SHARED_SOURCES = ["package.json", "bun.lock", "scripts/pack-asset-bundle.ts"];
// A repo path literal such as "adapters/blender/shrine.py"; an unfinished template prefix ("adapters/blender/${") is skipped.
// "../adapters/…" counts; a URL's "…/assets/…" does not.
const PATH_LITERAL = /(?<![\w.-]|[\w-]\/)((?:adapters|assets|catalog|examples)\/[A-Za-z0-9._/-]*)/g;

export function rollingRelease(name: string): RollingRelease {
  const release = ROLLING_RELEASES.find((entry) => entry.name === name);
  if (release) return release;
  if (MANUAL_RELEASES[name]) throw new Error(`${name} is not built in CI: ${MANUAL_RELEASES[name]}`);
  throw new Error(`unknown rolling release '${name}'`);
}

/**
 * The repository paths a release's build reads: the build script's transitive local imports, every repo path
 * literal they name (Blender recipes, catalog manifests, descriptors), Blender's pin when it needs Blender, the
 * canonical payloads when it needs LFS, and the shared packing/publishing files. Over-matching only costs a
 * rebuild that `publish` then skips as unchanged.
 */
export function releaseSources(release: RollingRelease, root = ROOT): string[] {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const sources = new Set<string>(SHARED_SOURCES);
  if (release.blender) sources.add("adapters/blender/release.json");
  if (release.lfs) sources.add("assets/canonical");
  if (release.processor) sources.add("stability/processors.json");
  const pending = [release.script];
  const seen = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    sources.add(file);
    const text = readFileSync(path.join(root, file), "utf8");
    for (const match of text.matchAll(PATH_LITERAL)) if (!/[/.]$/.test(match[1]!)) sources.add(match[1]!);
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    for (const { path: specifier } of transpiler.scanImports(text)) {
      if (!specifier.startsWith(".")) continue;
      const resolved = resolveLocal(root, path.posix.join(path.posix.dirname(file), specifier));
      if (resolved) pending.push(resolved);
    }
  }
  return [...sources].sort();
}

function resolveLocal(root: string, file: string): string | undefined {
  const candidates = [file, file.replace(/\.js$/, ".ts"), `${file}.ts`, `${file}/index.ts`];
  return candidates.find((candidate) => existsSync(path.join(root, candidate)) && !candidate.endsWith("/"));
}

/** True when `changed` is one of `sources` or lies under one of them. */
export function touches(sources: string[], changed: string): boolean {
  return sources.some((source) => changed === source || changed.startsWith(`${source}/`));
}

/** One publish job: the release and what its runner needs (an empty `processor` means none). */
export type PlanEntry = { release: string; blender: boolean; lfs: boolean; processor: string; ktx: boolean; timeout: number };

export function planEntry(release: RollingRelease): PlanEntry {
  return {
    release: release.name, blender: !!release.blender, lfs: !!release.lfs, processor: release.processor ?? "", ktx: !!release.ktx,
    timeout: release.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
  };
}

/** The releases whose sources `changed` touches, or all of them when the change set is unknown. */
export function plan(changed: string[] | "all", root = ROOT): PlanEntry[] {
  return ROLLING_RELEASES
    .filter((release) => changed === "all" || changed.some((file) => touches(releaseSources(release, root), file)))
    .map(planEntry);
}

/** Every top-level regular file of the build output, with export.ref.json last so a reader keyed on it sees the new tar. */
export async function releaseFiles(dir: string): Promise<string[]> {
  const names = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  return [...names.filter((name) => name !== "export.ref.json"), ...names.filter((name) => name === "export.ref.json")];
}

function sameJson(a: string, b: string): boolean {
  try {
    return Bun.deepEquals(JSON.parse(a), JSON.parse(b), true);
  } catch {
    return a === b;
  }
}

/** Whether one pinned file already pins these artifacts. JSON copies compare by value, since a consumer may reformat them. */
export async function pinMatches(content: string, pin: Pin, artifacts: Artifacts): Promise<boolean> {
  if (pin.type === "tar-sha256") {
    const at = content.indexOf(pin.after);
    if (at < 0) return false;
    const hash = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/.exec(content.slice(at + pin.after.length));
    return hash?.[0] === artifacts.sha256;
  }
  const from = pin.type === "export-ref" ? "export.ref.json" : pin.from;
  if (!artifacts.releaseFiles.includes(from)) throw new Error(`${pin.path}: the build has no ${from}`);
  return sameJson(content, await readFile(path.join(artifacts.dir, from), "utf8"));
}

export type FetchFile = (repo: string, file: string, ref?: string) => string | undefined;

/** The pinned consumers that would fail to load these artifacts, checking each one's default and re-pin branches. */
export async function blockingConsumers(consumers: Consumer[], release: string, artifacts: Artifacts, fetchFile: FetchFile): Promise<string[]> {
  const blocking: string[] = [];
  for (const consumer of findConsumers(consumers, release).pinned) {
    let ready: string | undefined;
    for (const ref of [undefined, `agent/repin-${release}`]) {
      const results = await Promise.all(consumer.pins!.map(async (pin) => {
        const content = fetchFile(consumer.repo, pin.path, ref);
        return content !== undefined && await pinMatches(content, pin, artifacts);
      }));
      if (results.every(Boolean)) { ready = ref ?? "default branch"; break; }
    }
    if (ready) console.log(`${consumer.repo}: pins the new build on its ${ready}`);
    else blocking.push(consumer.repo);
  }
  return blocking;
}

function run(command: string, args: string[], options: { allowFailure?: boolean } = {}): { ok: boolean; stdout: string } {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const ok = result.status === 0;
  if (!ok && !options.allowFailure) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return { ok, stdout: result.stdout };
}

const ghFetchFile: FetchFile = (repo, file, ref) => {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const result = run("gh", ["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${file}${query}`], { allowFailure: true });
  return result.ok ? result.stdout : undefined;
};

/** The tar sha256 the live release holds, or undefined when it has none. */
function liveTarSha256(release: string, tar: string): string | undefined {
  const result = run("gh", ["release", "download", release, "--repo", TOOLING_REPO, "--pattern", `${tar}.sha256`, "--output", "-"], { allowFailure: true });
  return result.ok ? /^([0-9a-f]{64}) {2}/.exec(result.stdout)?.[1] : undefined;
}

async function publish(name: string, out: string, dryRun: boolean): Promise<number> {
  rollingRelease(name);
  const dir = path.resolve(out);
  const artifacts = await readArtifacts(dir);
  console.log(run("bun", [path.join(ROOT, "scripts/pack-asset-bundle.ts"), "--verify", path.join(dir, artifacts.tar), "--ref", path.join(dir, "export.ref.json")]).stdout.trim());
  const files = await releaseFiles(dir);
  const live = liveTarSha256(name, artifacts.tar);
  if (live === artifacts.sha256) {
    console.log(`${name}: the live release already holds tar ${artifacts.sha256}; nothing to publish`);
    return 0;
  }
  const consumers = await loadConsumers();
  for (const consumer of findConsumers(consumers, name).unpinned) console.log(`${consumer.repo}: not pinned (${consumer.note ?? "reads the live release"})`);
  const blocking = await blockingConsumers(consumers, name, { ...artifacts, releaseFiles: files }, ghFetchFile);
  if (blocking.length) {
    console.error(
      `${name}: refusing to publish tar ${artifacts.sha256}: ${blocking.join(", ")} pin${blocking.length === 1 ? "s" : ""} the live release and would fail to load it.\n` +
        `Download this run's '${name}' artifact, run 'bun scripts/prepare-release.ts ${name} <artifact dir>' to open the re-pin PRs, then re-run this job.`,
    );
    return 1;
  }
  if (dryRun) {
    console.log(`${name}: would replace ${files.join(", ")} (live tar ${live ?? "none"})`);
    return 0;
  }
  if (!run("gh", ["release", "view", name, "--repo", TOOLING_REPO], { allowFailure: true }).ok) {
    run("gh", ["release", "create", name, "--repo", TOOLING_REPO, "--title", `${name} (rolling)`, "--notes", `Rolling release of \`${name}\` (Atlas Decision 7.1.5), replaced in place by the Publish rolling releases workflow.`]);
  }
  const bundle = files.filter((file) => file !== "export.ref.json");
  run("gh", ["release", "upload", name, "--repo", TOOLING_REPO, "--clobber", ...bundle.map((file) => path.join(dir, file))]);
  run("gh", ["release", "upload", name, "--repo", TOOLING_REPO, "--clobber", path.join(dir, "export.ref.json")]);
  console.log(`${name}: published tar ${artifacts.sha256} (was ${live ?? "none"}): ${files.join(", ")}`);
  return 0;
}

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === "plan" && rest[0] === "--release" && rest[1] && rest.length === 2) {
    const release = rollingRelease(rest[1]);
    console.log(JSON.stringify([planEntry(release)]));
    return 0;
  }
  if (command === "plan" && rest[0] === "--changed" && rest[1] && rest.length === 2) {
    const text = await readFile(rest[1], "utf8");
    const changed = text.trim() === "*" ? "all" : text.split("\n").map((line) => line.trim()).filter(Boolean);
    console.log(JSON.stringify(plan(changed)));
    return 0;
  }
  if (command === "build" && rest.length === 2) {
    const release = rollingRelease(rest[0]!);
    const result = spawnSync("bun", [path.join(ROOT, release.script), "--out", path.resolve(rest[1]!), ...(release.args ?? [])], { stdio: "inherit" });
    return result.status ?? 1;
  }
  if (command === "publish" && (rest.length === 2 || (rest.length === 3 && rest[2] === "--dry-run"))) {
    return publish(rest[0]!, rest[1]!, rest[2] === "--dry-run");
  }
  console.error("Usage: bun scripts/publish-release.ts plan --changed <file> | plan --release <name> | build <release> <out> | publish <release> <out> [--dry-run]");
  return 2;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
