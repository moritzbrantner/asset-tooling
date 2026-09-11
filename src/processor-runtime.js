import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function commandEnvironment(extra = {}) {
  const inherited = {};
  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
  ]) {
    if (process.env[name] !== undefined) inherited[name] = process.env[name];
  }
  return { ...inherited, ...extra };
}

async function commandOutput(executable, arguments_, cwd, environment, location) {
  try {
    const { stdout } = await execFileAsync(executable, arguments_, {
      cwd,
      env: commandEnvironment(environment),
      encoding: "utf8",
      windowsHide: true,
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(`${location} failed: ${error.message}`);
  }
}

async function optionalFileSha256(filePath) {
  try {
    const bytes = await readFile(filePath);
    return createHash("sha256").update(bytes).digest("hex");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function cargoConfigIdentity(environment) {
  const home = environment.CARGO_HOME
    ?? (environment.HOME ? path.join(environment.HOME, ".cargo") : undefined)
    ?? (environment.USERPROFILE ? path.join(environment.USERPROFILE, ".cargo") : undefined);
  if (!home) return {};

  const configTomlSha256 = await optionalFileSha256(path.join(home, "config.toml"));
  const legacyConfigSha256 = await optionalFileSha256(path.join(home, "config"));
  return {
    ...(configTomlSha256 ? { configTomlSha256 } : {}),
    ...(legacyConfigSha256 ? { legacyConfigSha256 } : {}),
  };
}

export async function captureCargoRuntimeIdentity({
  executable = "cargo",
  cwd,
  environment = {},
}) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new Error("Cargo runtime identity cwd must be an absolute path");
  }
  return {
    kind: "cargo-rust-v1",
    cargo: await commandOutput(executable, ["-Vv"], cwd, environment, "Cargo runtime probe"),
    rustc: await commandOutput("rustc", ["-Vv"], cwd, environment, "rustc runtime probe"),
    cargoConfig: await cargoConfigIdentity(environment),
  };
}
