import { readFile } from "node:fs/promises";
import { sha256Bytes } from "./hash.js";

/** Preserve the producer lock identity in source checkouts and packed installs. */
export async function readDependencyLockSha256(): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(new URL("../bun.lock", import.meta.url));
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    // Package managers omit their reserved lockfile names from tarballs. Prepack copies exact bytes.
    bytes = await readFile(new URL("../adapters/dependency.lock", import.meta.url));
  }
  return sha256Bytes(bytes);
}
