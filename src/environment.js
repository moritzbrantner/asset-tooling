import { sha256File, sha256Text } from "./hash.js";
import { canonicalJson } from "./canonical.js";

export async function captureEnvironment(components = []) {
  const runtimeName = typeof globalThis.Bun === "object" ? "bun" : "node";
  const runtimeVersion = runtimeName === "bun" ? globalThis.Bun.version : process.version.replace(/^v/, "");
  const executableSha256 = await sha256File(process.execPath);

  const fingerprint = {
    schemaVersion: 1,
    platform: {
      os: process.platform,
      arch: process.arch,
    },
    runtime: {
      name: runtimeName,
      version: runtimeVersion,
      executableSha256,
    },
    components: [...components].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
  };

  return {
    ...fingerprint,
    sha256: sha256Text(canonicalJson(fingerprint)),
  };
}
