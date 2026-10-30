// Build one Ranger figure's rolling release (#399) for the Publish rolling releases workflow:
//   bun scripts/build-ranger-release.ts --out <out> --figure male|female
// It runs scripts/build-ranger-character.ts into <out> (the object store; the tar, its .sha256, export.ref.json and
// lineage.json land at the top level) and then writes the per-entry downloads of scripts/pack-downloads.ts next to
// them, with the shared clips GLB, so `publish-release.ts publish` uploads the whole release. The 3d-lab checkout of
// the pinned `three-d-animation-retarget` processor is ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB (the workflow checks it
// out); KTX2 encoding needs KTX-Software's `ktx` (ASSET_TOOLING_KTX or on PATH).
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { RANGER_FIGURES, buildRangerCharacter, type RangerFigure } from "./build-ranger-character.ts";
import { packDownloads } from "./pack-downloads.ts";

/** The rolling release name of a figure's bundle (`humanoid.ranger.male` -> `humanoid-ranger-male`). */
export const rangerReleaseName = (figure: RangerFigure) => RANGER_FIGURES[figure].key.replaceAll(".", "-");

export async function buildRangerRelease({ outDir, figure, processorCheckout, log = () => {} }: {
  outDir: string; figure: RangerFigure; processorCheckout: string; log?: (line: string) => void;
}) {
  const out = path.resolve(outDir);
  const result = await buildRangerCharacter({ processorCheckout, outDir: out, figure, log: (line) => log(`[ranger] ${line}`) });
  await writeFile(path.join(out, "lineage.json"), `${JSON.stringify(result.lineage, null, 2)}\n`);
  const key = RANGER_FIGURES[figure].key;
  const { indexFile } = await packDownloads({ bundleDir: result.bundleDir, outDir: out, name: rangerReleaseName(figure), clips: `${key}/default`, log: (line) => log(`[downloads] ${line}`) });
  return { tar: result.tar, tarSha256: result.tarSha256, exportRefPath: result.exportRefPath, index: indexFile };
}

if (import.meta.main) {
  const args = process.argv.slice(2), option = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const outDir = option("--out"), figure = option("--figure"), processorCheckout = process.env.ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB;
  if (!outDir || !figure || !Object.hasOwn(RANGER_FIGURES, figure) || !processorCheckout) {
    console.error("Usage: ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB=<absolute 3d-lab checkout> bun scripts/build-ranger-release.ts --out <out> --figure male|female");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(await buildRangerRelease({ outDir, figure: figure as RangerFigure, processorCheckout, log: (line) => console.error(line) }), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
