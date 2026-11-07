// The repository files a script or test reads, shared by the rolling-release plan (scripts/publish-release.ts)
// and the PR validation plan (scripts/ci-plan.ts).
import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";

// A repo path literal such as "adapters/blender/shrine.py"; an unfinished template prefix ("adapters/blender/${") is skipped.
// "../adapters/…" counts; a URL's "…/assets/…" does not.
const PATH_LITERAL = /(?<![\w.-]|[\w-]\/)((?:adapters|assets|catalog|examples)\/[A-Za-z0-9._/-]*)/g;
// A Blender recipe named by its bare file name, as in readBlenderRecipeSource("tree.py") or runpy.run_path("kit_common.py").
const BLENDER_RECIPE = /["'`]([A-Za-z0-9_-]+\.py)["'`]/g;
const BLENDER_DIR = "adapters/blender";
// A module loaded through a relative URL, as in import(new URL("./process-adapter.js", import.meta.url).href).
const RELATIVE_URL = /new URL\(\s*["'`](\.\.?\/[^"'`$]+)["'`]\s*,\s*import\.meta\.url\s*\)/g;

/** The package's own `exports` map, so `asset-tooling/operations` resolves like a relative import. */
function selfExports(root: string): { name: string; exports: Record<string, string> } {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { name?: string; exports?: Record<string, unknown> };
  const exports = Object.fromEntries(Object.entries(manifest.exports ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return { name: manifest.name ?? "", exports };
}

/**
 * The entries, their transitive local imports (relative, through the package's own name, or through a relative
 * `new URL`), and every repo path literal they name (Blender recipes, catalog manifests, descriptors). Blender
 * recipes are followed in turn, so the helpers they load at runtime count too.
 */
export function sourceClosure(entries: string[], root: string): string[] {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const self = selfExports(root);
  const sources = new Set<string>();
  const pending = [...entries];
  const seen = new Set<string>();
  const recipe = (file: string) => {
    sources.add(file);
    if (file.startsWith(`${BLENDER_DIR}/`) && file.endsWith(".py") && existsSync(path.join(root, file))) pending.push(file);
  };
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    sources.add(file);
    const text = readFileSync(path.join(root, file), "utf8");
    for (const match of text.matchAll(PATH_LITERAL)) if (!/[/.]$/.test(match[1]!)) recipe(match[1]!);
    for (const match of text.matchAll(BLENDER_RECIPE)) {
      if (existsSync(path.join(root, BLENDER_DIR, match[1]!))) recipe(`${BLENDER_DIR}/${match[1]}`);
    }
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const specifiers = [
      ...transpiler.scanImports(text.replace(/^#!.*/, "")).map((entry) => entry.path),
      ...[...text.matchAll(RELATIVE_URL)].map((match) => match[1]!),
    ];
    for (const specifier of specifiers) {
      let target: string | undefined;
      if (specifier.startsWith(".")) target = path.posix.join(path.posix.dirname(file), specifier);
      else if (specifier === self.name || specifier.startsWith(`${self.name}/`)) {
        const exported = self.exports[`.${specifier.slice(self.name.length)}`];
        if (exported) target = path.posix.normalize(exported);
      }
      const resolved = target && resolveLocal(root, target);
      if (resolved) pending.push(resolved);
    }
  }
  return [...sources].sort();
}

function resolveLocal(root: string, file: string): string | undefined {
  const candidates = [file, file.replace(/\.js$/, ".ts"), `${file}.ts`, `${file}/index.ts`];
  return candidates.find((candidate) => statSync(path.join(root, candidate), { throwIfNoEntry: false })?.isFile());
}

/** True when `changed` is one of `sources` or lies under one of them. */
export function touches(sources: string[], changed: string): boolean {
  return sources.some((source) => changed === source || changed.startsWith(`${source}/`));
}
