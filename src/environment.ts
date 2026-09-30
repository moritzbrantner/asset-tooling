import { sha256File, sha256Text } from "./hash.js";
import {
  canonicalJson,
  compareCodeUnitStrings,
  type CanonicalJsonValue,
} from "./canonical.js";

export interface EnvironmentFingerprint {
  schemaVersion: 1;
  platform: {
    os: NodeJS.Platform;
    arch: string;
  };
  runtime: {
    name: "bun" | "node";
    version: string;
    executableSha256: string;
  };
  components: CanonicalJsonValue[];
  sha256: string;
}

type EnvironmentFingerprintContent = Omit<EnvironmentFingerprint, "sha256">;

export async function captureEnvironment(
  components: readonly CanonicalJsonValue[] = [],
): Promise<EnvironmentFingerprint> {
  const runtimeName: "bun" | "node" = typeof globalThis.Bun === "object" ? "bun" : "node";
  const runtimeVersion = runtimeName === "bun" ? globalThis.Bun.version : process.version.replace(/^v/, "");
  const executableSha256 = await sha256File(process.execPath);

  const fingerprint: EnvironmentFingerprintContent = {
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
    components: [...components].sort((left, right) =>
      compareCodeUnitStrings(canonicalJson(left), canonicalJson(right)),
    ),
  };

  return {
    ...fingerprint,
    sha256: sha256Text(canonicalJson(fingerprint)),
  };
}
