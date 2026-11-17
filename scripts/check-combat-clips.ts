// The combat-animation checks of docs/combat-animation-standard.md (#737) on a built Ranger: the weapon's clearance from
// the body, planted-foot drift and the strike's speed against its wind-up, per clip.
//
//   bun scripts/check-combat-clips.ts <character .glb/.gltf or clips .glb> <humanoid-clips.json> <humanoid-sockets.json> [clip ...] [--json] [--between]
//
// Without clip names it checks every clip with a `strike` object or a gait's `footPlants` (#804), the library sword
// strikes and the cast recipe's staff and mace strikes (which have none: they are checked with their role's item and
// their measured contact, and the clips of `RANGER_CLEARANCE_CLIPS` with their planted feet; `combatCheckEntry`). Prints
// one line per clip and the reports as JSON with --json. Those clips, and every clip with --between, are also checked
// between their keys (`CLEARANCE_SUBSTEPS`).
import { readFile } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import { CLEARANCE_SUBSTEPS, checkCombatClip, combatCheckEntry, type CombatClipReport } from "../src/combat-clip-checks.ts";
import { RANGER_CLEARANCE_CLIPS } from "../src/ranger-clips.ts";

type Json = Record<string, any>;

export function formatReport(report: CombatClipReport) {
  const cm = (meters: number) => `${(meters * 100).toFixed(1)} cm`;
  const parts = [report.clip.padEnd(20)];
  const { clearance, feet, timing } = report;
  parts.push(clearance ? `clearance ${clearance.ok ? "ok  " : "FAIL"} ${clearance.worstMeters > 0 ? `${cm(clearance.worstMeters)} into ${clearance.part}` : `${cm(-clearance.worstMeters)} clear`} (frame ${clearance.frame}, ${clearance.alongItemMeters} m up the item)` : "clearance -");
  parts.push(feet ? `feet ${feet.ok ? "ok  " : "FAIL"} ${cm(feet.worstMeters)}${feet.foot ? ` (${feet.foot} ${feet.span.join("-")} s)` : ""}` : "feet - (none marked planted)");
  parts.push(timing ? `timing ${timing.ok ? "ok  " : "FAIL"} ${timing.ratio}x (wind-up ${timing.windupMeanSpeed} m/s to ${timing.windupEnd} s${timing.inferredWindupEnd ? " inferred" : ""}, strike peak ${timing.strikePeakSpeed} m/s)` : "timing -");
  return parts.join(" | ");
}

if (import.meta.main) {
  const json = process.argv.includes("--json");
  const between = process.argv.includes("--between");
  const [model, clipsFile, socketsFile, ...names] = process.argv.slice(2).filter((arg) => arg !== "--json" && arg !== "--between");
  if (!model || !clipsFile || !socketsFile) throw new Error("usage: check-combat-clips.ts <model> <humanoid-clips.json> <humanoid-sockets.json> [clip ...]");
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  const document = await io.read(model);
  const clips = JSON.parse(await readFile(clipsFile, "utf8")).clips as Json[];
  const sockets = JSON.parse(await readFile(socketsFile, "utf8")).sockets;
  const entries = clips
    .map((clip) => combatCheckEntry(clip as never, RANGER_CLEARANCE_CLIPS[clip.name]?.footPlants) ?? (clip.footPlants || names.includes(clip.name) ? clip : undefined))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined && (!names.length || names.includes(entry.name)));
  const reports = entries.map((entry) => checkCombatClip(document, entry, sockets, { substeps: between || entry.name in RANGER_CLEARANCE_CLIPS ? CLEARANCE_SUBSTEPS : 1 }));
  if (json) console.log(JSON.stringify(reports, null, 2));
  else for (const report of reports) console.log(formatReport(report));
}
