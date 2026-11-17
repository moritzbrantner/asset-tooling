// The combat-animation checks of docs/combat-animation-standard.md (#737) on a built Ranger: the weapon's clearance from
// the body, planted-foot drift and the strike's speed against its wind-up, per clip.
//
//   bun scripts/check-combat-clips.ts <character .glb/.gltf or clips .glb> <humanoid-clips.json> <humanoid-sockets.json> [clip ...]
//
// Without clip names it checks every clip with a `strike` object, and the library sword strikes (which have none: they
// are checked with the arming sword on `hand_r.weapon` and their measured contact). Prints one line per clip and the
// reports as JSON with --json.
import { readFile } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import { checkCombatClip, type CombatClipEntry, type CombatClipReport } from "../src/combat-clip-checks.ts";

type Json = Record<string, any>;

/** A library sword strike's check data: the arming sword and its measured contact. */
function libraryStrike(clip: Json): CombatClipEntry | undefined {
  if (clip.strike || !/^sword\./.test(clip.role ?? "") || !clip.contact) return undefined;
  return { ...clip, strike: { weapon: { item: "equipment.sword.arming", socket: "hand_r.weapon", strikePoint: [0, .84, 0] }, contactSeconds: clip.contact.seconds } } as CombatClipEntry;
}

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
  const [model, clipsFile, socketsFile, ...names] = process.argv.slice(2).filter((arg) => arg !== "--json");
  if (!model || !clipsFile || !socketsFile) throw new Error("usage: check-combat-clips.ts <model> <humanoid-clips.json> <humanoid-sockets.json> [clip ...]");
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  const document = await io.read(model);
  const clips = JSON.parse(await readFile(clipsFile, "utf8")).clips as Json[];
  const sockets = JSON.parse(await readFile(socketsFile, "utf8")).sockets;
  const entries = clips
    .filter((clip) => names.length ? names.includes(clip.name) : clip.strike || libraryStrike(clip))
    .map((clip) => (libraryStrike(clip) ?? clip) as CombatClipEntry);
  const reports = entries.map((entry) => checkCombatClip(document, entry, sockets));
  if (json) console.log(JSON.stringify(reports, null, 2));
  else for (const report of reports) console.log(formatReport(report));
}
