// The per-release data files under releases/, one `<release>.json` per rolling release (#574). The rolling-release
// publisher (scripts/publish-release.ts) and the kit cost budgets (scripts/report-kit-costs.ts) read them, so adding
// or changing one kit edits only its own file, and CI plans only that kit's tests and release (scripts/ci-plan.ts).
import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";

/** The repository directory holding one `<release>.json` per rolling release. */
export const RELEASES_DIR = "releases";

/** A kit's cost limits as written in its release file, in whole MiB. */
export type ReleaseBudgetData = { note?: string; materials: number; textureMemoryMB: number; downloadMB: number };

/** One `releases/<name>.json`: the release's build and runner needs, and its kit cost limits when it has them. */
export type ReleaseData = {
  note?: string;
  script: string;
  args?: string[];
  blender?: boolean;
  lfs?: boolean;
  processor?: string;
  ktx?: boolean;
  timeoutMinutes?: number;
  budget?: ReleaseBudgetData;
};

const KEYS = new Set(["note", "script", "args", "blender", "lfs", "processor", "ktx", "timeoutMinutes", "budget"]);
const BUDGET_KEYS = ["materials", "textureMemoryMB", "downloadMB"];

function parse(name: string, text: string): ReleaseData {
  const file = `${RELEASES_DIR}/${name}.json`;
  const data = JSON.parse(text) as ReleaseData;
  const unknown = Object.keys(data).filter((key) => !KEYS.has(key));
  if (unknown.length) throw new Error(`${file}: unknown keys ${unknown.join(", ")}`);
  if (typeof data.script !== "string" || !data.script.startsWith("scripts/")) throw new Error(`${file}: script must be a path under scripts/`);
  if (data.budget && !BUDGET_KEYS.every((key) => typeof data.budget![key as keyof ReleaseBudgetData] === "number")) {
    throw new Error(`${file}: budget needs numeric ${BUDGET_KEYS.join(", ")}`);
  }
  return data;
}

/** Every release file, by release name in alphabetical order. */
export function readReleaseData(root: string): [string, ReleaseData][] {
  return readdirSync(path.join(root, RELEASES_DIR))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const name = file.slice(0, -".json".length);
      return [name, parse(name, readFileSync(path.join(root, RELEASES_DIR, file), "utf8"))];
    });
}
