import path from "node:path";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";

/** Example output reconciliation; parent directory is created by the caller. */
export async function writeIfChanged(filePath: string, bytes: Uint8Array): Promise<void> {
  try {
    if ((await readFile(filePath)).equals(bytes)) return;
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const temporary = await mkdtemp(path.join(path.dirname(filePath), ".example-write-"));
  try {
    const staged = path.join(temporary, "output");
    await writeFile(staged, bytes);
    await rename(staged, filePath);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
