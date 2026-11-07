// Inspect the runtime and download estimates already emitted by pack-downloads.ts (#126).
// Read-only; compares corresponding variants, never sums alternatives or claims measured FPS.
// Usage: bun scripts/report-download-costs.ts --index <current.index.json> [--baseline <prior.index.json>]
import { readFile } from "node:fs/promises";
import { DOWNLOAD_INDEX_SCHEMA } from "./pack-downloads.ts";

const METRICS = ["downloadBytes", "textureCompressedBytes", "textureRgba8FallbackBytes", "materials", "drawCalls", "triangles"] as const;
type Metric = typeof METRICS[number];
type Cost = { id: string } & Record<Metric, number>;

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer`);
  return value;
}
function parseIndex(value: unknown): { release: string; entries: Cost[] } {
  const input = object(value, "download index");
  if (input.schema !== DOWNLOAD_INDEX_SCHEMA) throw new Error("unsupported download index schema");
  if (typeof input.release !== "string" || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(input.release)) throw new Error("invalid download release name");
  if (!Array.isArray(input.entries) || input.entries.length > 4096) throw new Error("download index must contain at most 4096 entries");
  const seen = new Set<string>();
  const entries = input.entries.map((value, i): Cost => {
    const entry = object(value, `entry[${i}]`);
    for (const field of ["key", "variant"] as const) {
      if (typeof entry[field] !== "string" || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(entry[field])) throw new Error(`entry[${i}] has invalid ${field}`);
    }
    const id = `${entry.key}/${entry.variant}`;
    if (seen.has(id)) throw new Error(`duplicate download index entry '${id}'`);
    seen.add(id);
    const runtime = object(entry.runtime, `entry '${id}' runtime`);
    const textures = object(runtime.textureMemoryEstimate, `entry '${id}' texture memory`);
    return { id,
      downloadBytes: integer(entry.bytes, `entry '${id}' download bytes`),
      textureCompressedBytes: integer(textures.compressedBytes, `entry '${id}' compressed texture bytes`),
      textureRgba8FallbackBytes: integer(textures.rgba8FallbackBytes, `entry '${id}' fallback texture bytes`),
      materials: integer(runtime.materials, `entry '${id}' materials`),
      drawCalls: integer(runtime.drawCalls, `entry '${id}' draw calls`),
      triangles: integer(runtime.triangles, `entry '${id}' triangles`),
    };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { release: input.release, entries };
}

/** Compare exact logical selections: totals across different variants would double-count shared payloads. */
export function compareDownloadCosts(currentIndex: unknown, baselineIndex?: unknown) {
  const current = parseIndex(currentIndex);
  const baseline = baselineIndex === undefined ? undefined : parseIndex(baselineIndex);
  if (baseline && baseline.release !== current.release) throw new Error("baseline and candidate must describe the same release");
  const previous = new Map(baseline?.entries.map(entry => [entry.id, entry] as const) ?? []);
  const selected = new Map(current.entries.map(entry => [entry.id, entry] as const));
  const maxima = Object.fromEntries(METRICS.map(metric => {
    const top = current.entries.reduce<Cost | undefined>((winner, item) =>
      !winner || item[metric] > winner[metric] ? item : winner, undefined);
    return [metric, top ? { id: top.id, value: top[metric] } : null];
  })) as Record<Metric, { id: string; value: number } | null>;
  const changes = baseline ? current.entries.flatMap(entry => {
    const old = previous.get(entry.id);
    if (!old) return [];
    const deltas = Object.fromEntries(METRICS.map(metric => [metric, entry[metric] - old[metric]])) as Record<Metric, number>;
    return METRICS.some(metric => deltas[metric] !== 0) ? [{ id: entry.id, deltas }] : [];
  }) : [];
  return { schema: "asset-download-cost-report-v1" as const, release: current.release, entryCount: current.entries.length,
    entries: current.entries, maxima, changes,
    added: baseline ? current.entries.filter(entry => !previous.has(entry.id)).map(entry => entry.id) : [],
    removed: baseline ? baseline.entries.filter(entry => !selected.has(entry.id)).map(entry => entry.id) : [],
    note: "Static per-variant estimates from the existing download index; no combined-variant totals, GPU timings or automatic acceptance.",
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const accepted = new Set(["--index", "--baseline"]);
  if (!args.length || args.length % 2 !== 0 || args.some((arg, i) => i % 2 === 0 && !accepted.has(arg))) {
    console.error("Usage: bun scripts/report-download-costs.ts --index <current.index.json> [--baseline <prior.index.json>]");
    process.exit(2);
  }
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (flags.has(args[i]!)) throw new Error(`duplicate ${args[i]} flag`);
    flags.set(args[i]!, args[i + 1]!);
  }
  if (!flags.has("--index")) throw new Error("--index is required");
  const current = JSON.parse(await readFile(flags.get("--index")!, "utf8"));
  const baseline = flags.has("--baseline") ? JSON.parse(await readFile(flags.get("--baseline")!, "utf8")) : undefined;
  console.log(JSON.stringify(compareDownloadCosts(current, baseline), null, 2));
}
