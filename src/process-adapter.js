import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { canonicalJson } from "./canonical.js";

function adapterEnvironment(extra = {}) {
  const inherited = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "VIRTUAL_ENV"]) {
    if (process.env[name] !== undefined) inherited[name] = process.env[name];
  }
  return {
    ...inherited,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    ...extra,
  };
}

async function run(executable, arguments_, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd,
      env: adapterEnvironment(options.environment),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        const detail = stderrText.trim() || stdoutText.trim() || `signal ${signal ?? "unknown"}`;
        reject(new Error(`generator adapter failed with exit code ${code}: ${detail}`));
        return;
      }
      resolve({ stdout: stdoutText, stderr: stderrText });
    });
  });
}

function assertCommandPart(value, location) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value;
}

function commandArguments(scriptPath, prefixArguments, mode, suffixArguments = []) {
  return [
    assertCommandPart(scriptPath, "adapter script path"),
    ...prefixArguments.map((value, index) => assertCommandPart(value, `adapter prefixArguments[${index}]`)),
    mode,
    ...suffixArguments,
  ];
}

export async function probeProcessAdapter({ executable, scriptPath, prefixArguments = [], cwd, environment = {} }) {
  const { stdout } = await run(
    assertCommandPart(executable, "adapter executable"),
    commandArguments(scriptPath, prefixArguments, "probe"),
    { cwd, environment },
  );
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`generator adapter probe did not return JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((component) => typeof component !== "object" || component === null || Array.isArray(component))) {
    throw new Error("generator adapter probe must return a JSON array of component objects");
  }
  return parsed;
}

export async function runProcessAdapter({
  executable,
  scriptPath,
  prefixArguments = [],
  cwd,
  environment = {},
  request,
  outputName = "output.bin",
}) {
  if (typeof outputName !== "string" || !/^[A-Za-z0-9._-]+$/.test(outputName)) {
    throw new Error("adapter outputName must be a simple file name");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-adapter-"));
  const requestPath = path.join(directory, "request.json");
  const outputPath = path.join(directory, outputName);
  const observationsPath = path.join(directory, "observations.json");

  try {
    await writeFile(requestPath, `${canonicalJson(request)}\n`, "utf8");
    await run(
      assertCommandPart(executable, "adapter executable"),
      commandArguments(scriptPath, prefixArguments, "generate", [requestPath, outputPath, observationsPath]),
      { cwd, environment },
    );
    const bytes = await readFile(outputPath);
    let observations;
    try {
      observations = JSON.parse(await readFile(observationsPath, "utf8"));
    } catch (error) {
      throw new Error(`generator adapter did not emit valid observations JSON: ${error.message}`);
    }
    if (typeof observations !== "object" || observations === null || Array.isArray(observations)) {
      throw new Error("generator adapter observations must be a JSON object");
    }
    return { bytes, observations };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
