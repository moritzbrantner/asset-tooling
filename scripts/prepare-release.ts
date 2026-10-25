// Prepare a rolling-release republish without breaking its pinned consumers (README "Publishing a rolling release").
//   bun scripts/prepare-release.ts <release> <artifactsDir> [--downloads <dir>] [--dry-run]
// <artifactsDir> holds the built bundle: exactly one <name>.tar with its .sha256 sidecar, export.ref.json, and any
// other top-level release files (lineage.json, <name>.descriptor.json). <downloads> defaults to <artifactsDir>/downloads.
// It verifies the tar, opens a draft "Re-pin <release>" PR in every consumer that consumers.json lists as pinning
// the release, and prints the owner's upload commands followed by the one line that lands the re-pins afterwards.
// It never uploads to the release itself; --dry-run only verifies and prints.
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";

export type Pin =
  | { type: "export-ref"; path: string }
  | { type: "file"; from: string; path: string }
  | { type: "tar-sha256"; path: string; after: string };
// `format` is a shell command run in the consumer checkout after the pins are rewritten, for consumers whose
// formatter checks the pinned copies (release JSON is copied byte for byte otherwise).
export type Consumer = { repo: string; release: string; pinned?: boolean; note?: string; pins?: Pin[]; format?: string };
export type Artifacts = { dir: string; tar: string; sha256: string; releaseFiles: string[]; downloads?: string };

const ROOT = path.resolve(import.meta.dir, "..");
const TOOLING_REPO = "moritzbrantner/asset-tooling";
const USAGE = "Usage: bun scripts/prepare-release.ts <release> <artifactsDir> [--downloads <dir>] [--dry-run]";

/** The consumers of `release`, split into those whose pins must follow it and those that read it unpinned. */
export function findConsumers(consumers: Consumer[], release: string): { pinned: Consumer[]; unpinned: Consumer[] } {
  const matching = consumers.filter((consumer) => consumer.release === release);
  for (const consumer of matching) {
    if (consumer.pinned !== false && !consumer.pins?.length) throw new Error(`${consumer.repo} pins ${release} but lists no pins`);
  }
  return { pinned: matching.filter((c) => c.pinned !== false), unpinned: matching.filter((c) => c.pinned === false) };
}

export async function loadConsumers(file = path.join(ROOT, "consumers.json")): Promise<Consumer[]> {
  const parsed = JSON.parse(await readFile(file, "utf8"));
  if (parsed.schema !== "release-consumers-v1" || !Array.isArray(parsed.consumers)) throw new Error(`${file} is not release-consumers-v1`);
  return parsed.consumers;
}

/** Locate the tar, its sidecar sha256 and the other top-level release files of a built artifacts directory. */
export async function readArtifacts(dir: string, downloads?: string): Promise<Artifacts> {
  const names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();
  const tars = names.filter((name) => name.endsWith(".tar"));
  if (tars.length !== 1) throw new Error(`${dir} must hold exactly one .tar, found ${tars.length}`);
  const tar = tars[0]!;
  if (!names.includes(`${tar}.sha256`) || !names.includes("export.ref.json")) throw new Error(`${dir} must hold ${tar}.sha256 and export.ref.json`);
  const sidecar = /^([0-9a-f]{64}) {2}/.exec(await readFile(path.join(dir, `${tar}.sha256`), "utf8"));
  if (!sidecar) throw new Error(`${tar}.sha256 is not a sha256sum line`);
  const releaseFiles = [tar, `${tar}.sha256`, ...names.filter((name) => name.endsWith(".json"))];
  const downloadDir = downloads ?? (existsSync(path.join(dir, "downloads")) ? path.join(dir, "downloads") : undefined);
  return { dir, tar, sha256: sidecar[1]!, releaseFiles, ...(downloadDir ? { downloads: downloadDir } : {}) };
}

/** Rewrite one consumer checkout's pins to the new artifacts; returns the files that changed. */
export async function applyPins(checkout: string, pins: Pin[], artifacts: Artifacts): Promise<string[]> {
  const changed = new Set<string>();
  for (const pin of pins) {
    const target = path.join(checkout, pin.path);
    const before = await readFile(target, "utf8");
    let after: string;
    if (pin.type === "tar-sha256") {
      const at = before.indexOf(pin.after);
      if (at < 0 || before.indexOf(pin.after, at + 1) >= 0) throw new Error(`${pin.path}: '${pin.after}' must occur exactly once`);
      const rest = before.slice(at + pin.after.length);
      const hash = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/.exec(rest);
      if (!hash) throw new Error(`${pin.path}: no sha256 after '${pin.after}'`);
      const start = at + pin.after.length + hash.index;
      after = before.slice(0, start) + artifacts.sha256 + before.slice(start + 64);
    } else {
      const from = pin.type === "export-ref" ? "export.ref.json" : pin.from;
      if (!artifacts.releaseFiles.includes(from)) throw new Error(`${pin.path}: the artifacts have no ${from}`);
      after = await readFile(path.join(artifacts.dir, from), "utf8");
    }
    if (after !== before) {
      await writeFile(target, after);
      changed.add(pin.path);
    }
  }
  return [...changed];
}

/** The owner's upload commands, and the coordinator's single line that lands the re-pin PRs after the upload. */
export function uploadCommands(release: string, artifacts: Artifacts, prs: { repo: string; number: number; url: string; clone: string }[]): { upload: string[]; land: string } {
  const quote = (value: string) => (/^[\w./@:+=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);
  const lines = [`gh release upload ${release} --repo ${TOOLING_REPO} ${artifacts.releaseFiles.map((f) => quote(`${artifacts.dir}/${f}`)).join(" ")} --clobber`];
  if (artifacts.downloads) lines.push(`gh release upload ${release} --repo ${TOOLING_REPO} ${quote(artifacts.downloads)}/* --clobber`);
  lines.push(`gh workflow run pages.yml --repo ${TOOLING_REPO}`);
  const land = prs.map((pr) => `gh pr ready ${pr.url} && node ~/.local/share/coding-agent/workctl.mjs land ${pr.repo}#${pr.number} --clone ${quote(pr.clone)}`);
  return { upload: lines, land: land.join(" && ") };
}

function run(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/** Clone (or refresh) the consumer, rewrite its pins on agent/repin-<release> and open or update its draft PR. */
function checkoutRepin(consumer: Consumer) {
  const name = consumer.repo.split("/")[1]!;
  const clone = path.join(os.homedir(), ".cache/agent-work", `${name}-repin-${consumer.release}`);
  const branch = `agent/repin-${consumer.release}`;
  if (!existsSync(path.join(clone, ".git"))) run("gh", ["repo", "clone", consumer.repo, clone, "--", "-q"]);
  run("git", ["fetch", "-q", "origin"], clone);
  const base = run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], clone);
  run("git", ["checkout", "-q", "-f", "-B", branch, base], clone);
  return { clone, branch, base: base.replace(/^origin\//, "") };
}

async function main(args: string[]): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const rest = args.filter((a) => a !== "--dry-run");
  const flag = rest.indexOf("--downloads");
  const downloads = flag >= 0 ? rest.splice(flag, 2)[1] : undefined;
  const [release, artifactsDir, ...extra] = rest;
  if (!release || !artifactsDir || extra.length || (flag >= 0 && !downloads)) { console.error(USAGE); return 2; }

  const artifacts = await readArtifacts(path.resolve(artifactsDir), downloads && path.resolve(downloads));
  const tarPath = path.join(artifacts.dir, artifacts.tar);
  console.log(run("bun", [path.join(ROOT, "scripts/pack-asset-bundle.ts"), "--verify", tarPath, "--ref", path.join(artifacts.dir, "export.ref.json")]));

  const { pinned, unpinned } = findConsumers(await loadConsumers(), release);
  for (const consumer of unpinned) console.log(`${consumer.repo}: not pinned (${consumer.note ?? "reads the live release"})`);
  const prs: { repo: string; number: number; url: string; clone: string }[] = [];
  for (const consumer of pinned) {
    if (dryRun) { console.log(`${consumer.repo}: would re-pin ${consumer.pins!.map((p) => p.path).join(", ")}`); continue; }
    const { clone, branch, base } = checkoutRepin(consumer);
    await applyPins(clone, consumer.pins!, artifacts);
    if (consumer.format) run("sh", ["-c", consumer.format], clone);
    const pinPaths = [...new Set(consumer.pins!.map((pin) => pin.path))];
    const changed = pinPaths.filter((pinPath) => run("git", ["status", "--porcelain", "--", pinPath], clone));
    if (!changed.length) { console.log(`${consumer.repo}: already pinned to ${artifacts.sha256}`); continue; }
    run("git", ["add", "--", ...changed], clone);
    run("git", ["commit", "-q", "-m", `Re-pin ${release}\n\nPins the ${release} release tar ${artifacts.sha256}.`], clone);
    run("git", ["push", "-q", "--force", "-u", "origin", branch], clone);
    const existing = JSON.parse(run("gh", ["pr", "list", "-R", consumer.repo, "--head", branch, "--state", "open", "--json", "number,url"]));
    const body = [
      `Re-pins the rolling \`${release}\` release to tar sha256 \`${artifacts.sha256}\` (${changed.map((f) => `\`${f}\``).join(", ")}).`,
      "",
      `Prepared by asset-tooling \`scripts/prepare-release.ts\` **before** the release is replaced. It stays a draft until the owner has run \`gh release upload ${release} … --clobber\`; until then this PR's checks fetch the old release and fail.`,
    ].join("\n");
    let pr: { number: number; url: string };
    if (existing.length) {
      pr = existing[0];
      run("gh", ["pr", "edit", String(pr.number), "-R", consumer.repo, "--body", body]);
    } else {
      const url = run("gh", ["pr", "create", "-R", consumer.repo, "--draft", "--base", base, "--head", branch, "--title", `Re-pin ${release}`, "--body", body]);
      pr = { url, number: Number(url.split("/").pop()) };
    }
    console.log(`${consumer.repo}: ${pr.url}`);
    prs.push({ repo: consumer.repo, clone, ...pr });
  }
  const { upload, land } = uploadCommands(release, artifacts, prs);
  console.log(`\n# Owner: replace the ${release} release assets (this script never uploads)\n${upload.join("\n")}`);
  console.log(`\n# Coordinator, once the upload is done: mark the re-pin PRs ready and land them\n${land || "# no re-pin PR: nothing to land"}`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
