// Export the owner-selected Warden ability icons as the approved-png-v1 bundle (#211, Atlas 4.1.3).
//
//   bun scripts/export-warden-icons.ts            export to review/warden-icons/approved/ and write export.ref.json
//   bun scripts/export-warden-icons.ts --check    export to a disposable directory and compare with the committed bundle
//   bun scripts/export-warden-icons.ts --derive   print derived sha256 values without exporting
//
// Needs a Git LFS-hydrated review folder (git lfs pull --include="review/**") and FFmpeg for the
// image.decode@1 / image.encode.png@1 operations. Disposable object-store state stays in .asset-tooling/,
// the --check export in .artifacts/.
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { writeIfChanged } from "../examples/reconcile-file.js";
import {
  WARDEN_EXPORT_REF_FILE,
  loadApprovedWardenExport,
  wardenExportRefBytes,
} from "../src/warden-icon-export.js";
import { exportApprovedWardenIcons } from "../src/warden-icon-derive.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reviewDirectory = path.join(root, "review", "warden-icons");
const mode = process.argv[2] ?? "--write";
if (!["--write", "--check", "--derive"].includes(mode)) throw new Error(`unknown mode ${mode}`);

if (mode === "--derive") {
  const run = await exportApprovedWardenIcons({ root, reviewDirectory, deriveOnly: true });
  console.log(JSON.stringify(run.derived, null, 2));
} else if (mode === "--check") {
  await mkdir(path.join(root, ".artifacts"), { recursive: true });
  const scratch = await mkdtemp(path.join(root, ".artifacts", "warden-export-check-"));
  try {
    const run = await exportApprovedWardenIcons({ root, reviewDirectory, outputDirectory: path.join(scratch, "bundle") });
    const committed = await loadApprovedWardenExport(reviewDirectory);
    if (run.manifestRef!.sha256 !== committed.manifestRef.sha256) {
      throw new Error(`fresh export manifest ${run.manifestRef!.sha256} differs from the committed ${committed.manifestRef.sha256}`);
    }
    console.log(JSON.stringify({ accepted: true, manifest: committed.manifestRef.sha256, files: run.files }));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
} else {
  const run = await exportApprovedWardenIcons({ root, reviewDirectory });
  const refFile = path.join(reviewDirectory, run.selection.bundle, WARDEN_EXPORT_REF_FILE);
  await writeIfChanged(refFile, wardenExportRefBytes(run.manifestRef!));
  const committed = await loadApprovedWardenExport(reviewDirectory);
  console.log(JSON.stringify({
    manifest: committed.manifestRef.sha256,
    manifestStatus: run.manifestStatus,
    bytesWritten: run.bytesWritten,
    files: run.files,
    ref: JSON.parse(await readFile(refFile, "utf8")),
  }, null, 2));
}
