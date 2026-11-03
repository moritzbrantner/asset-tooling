// Reproducible, read-only microbenchmark for asset-tooling#453's budget hot path.
// bun scripts/benchmark-asset-bundle-budget.ts [--runs 7]
import { performance } from "node:perf_hooks";
import { checkBudget, createBundleBudgetTracker } from "../src/asset-bundle-manifest.js";
import type { BundleResource } from "../src/asset-bundle-contract.js";

function runsFromArgs(args: string[]): number {
  if (args.length === 0) return 7;
  if (args.length !== 2 || args[0] !== "--runs") throw new Error("usage: bun scripts/benchmark-asset-bundle-budget.ts [--runs 7]");
  const runs = Number(args[1]);
  if (!Number.isSafeInteger(runs) || runs < 3 || runs > 100) throw new Error("--runs must be an integer in 3..100");
  return runs;
}

function resources(count: number): BundleResource[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `assets/${index.toString(16).padStart(64, "0")}.rgba.json`,
    source: { kind: "image", mediaType: "application/vnd.moritzbrantner.rgba8+json", sha256: index.toString(16).padStart(64, "0"), byteLength: 1024 },
  }));
}

function wholeListOnEveryAppend(entries: BundleResource[]) {
  const declared: BundleResource[] = [];
  for (const entry of entries) { declared.push(entry); checkBudget(declared); }
}

function incremental(entries: BundleResource[]) {
  const budget = createBundleBudgetTracker([]);
  for (const entry of entries) budget.add(entry);
}

function samples(operation: () => void, count: number): number[] {
  for (let index = 0; index < 2; index++) operation();
  return Array.from({ length: count }, () => {
    const start = performance.now();
    operation();
    return Math.round((performance.now() - start) * 1000) / 1000;
  });
}

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)]!;
}

const runs = runsFromArgs(process.argv.slice(2));
const scenarios = [512, 3600].map((count) => {
  const entries = resources(count);
  const whole = samples(() => wholeListOnEveryAppend(entries), runs);
  const tracked = samples(() => incremental(entries), runs);
  return {
    declaredResources: count,
    baseline: { medianMs: median(whole), samplesMs: whole },
    incremental: { medianMs: median(tracked), samplesMs: tracked },
  };
});
console.log(JSON.stringify({ kind: "asset-bundle-budget-hot-path", runs, note: "Only budget accounting is timed; not complete atlas processing or file verification.", scenarios }, null, 2));
