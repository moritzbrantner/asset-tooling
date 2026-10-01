import path from "node:path";
import { fileURLToPath } from "node:url";
import {type AssetSpecDocument} from "./schema.js";
import {type CanonicalJsonObject} from "./operations.js";
type AdapterCommand={executable:string;launcherArguments:string[];scriptPath:string;prefixArguments:string[];cwd:string};
// Keep this typed module at the existing untyped process-adapter migration seam.
const {probeProcessAdapter,runProcessAdapter}:{
 probeProcessAdapter:(options:AdapterCommand)=>Promise<CanonicalJsonObject[]>;
 runProcessAdapter:(options:AdapterCommand & {request:unknown;outputName:string})=>Promise<{bytes:Uint8Array;observations:CanonicalJsonObject}>;
}=await import(new URL("./process-adapter.js",import.meta.url).href);

const RUNNER_SCRIPT = fileURLToPath(new URL("../adapters/blender/script_runner.py", import.meta.url));
const BLENDER_LAUNCHER_ARGUMENTS = [
  "--background",
  "--factory-startup",
  "--quiet",
  "--python-exit-code",
  "1",
  "--python",
];
const BLENDER_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const BACKEND_ID = "external.blender.script";

/** The Blender executable: `ASSET_TOOLING_BLENDER` when set, otherwise `blender` on PATH. */
export function blenderExecutable(): string {
  const configured = process.env.ASSET_TOOLING_BLENDER;
  return configured !== undefined && configured.length > 0 ? configured : "blender";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: Set<string>, location: string) {
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {throw new Error(`${location} contains unsupported field '${key}'`);}
  }
  for (const key of expected) {
    if (!(key in value)) {throw new Error(`${location}.${key} is required`);}
  }
}

function validateBlenderScript(document:AssetSpecDocument) {
  const { spec } = document;
  if (spec.randomness.mode !== "none") {
    throw new Error(`${BACKEND_ID} requires randomness.mode='none'; seed through script arguments`);
  }
  if (Object.keys(spec.models).length !== 0) {
    throw new Error(`${BACKEND_ID} does not accept models; pin Blender through parameters.blenderVersion`);
  }
  const script = spec.inputs.script;
  if (script === undefined) {
    throw new Error(`${BACKEND_ID} requires an input named 'script'`);
  }
  if (!script.path.endsWith(".py")) {
    throw new Error("inputs.script.path must be a .py file");
  }
  const parameters = spec.parameters;
  assertExactKeys(parameters, new Set(["blenderVersion", "arguments"]), "parameters");
  if (typeof parameters.blenderVersion !== "string" || !BLENDER_VERSION.test(parameters.blenderVersion)) {
    throw new Error("parameters.blenderVersion must be an exact MAJOR.MINOR.PATCH Blender release");
  }
  if (!isPlainObject(parameters.arguments)) {
    throw new Error("parameters.arguments must be an object");
  }
  return {script,blenderVersion:parameters.blenderVersion,arguments:parameters.arguments};
}

function outputName(outputPath: string): string {
  const extension = path.posix.extname(outputPath);
  return /^\.[A-Za-z0-9]+$/.test(extension) ? `output${extension}` : "output.bin";
}

export const BLENDER_SCRIPT_BACKEND = {
  id: BACKEND_ID,
  version: "1",
  kind: "procedural",
  // Exact capability is a claim about a pinned Blender binary running a deterministic script;
  // `verify` still replays the script and compares output bytes.
  exactCapable: true,
  validate: validateBlenderScript,
  async environmentComponents(document:AssetSpecDocument) {
    const validated=validateBlenderScript(document);
    const components = await probeProcessAdapter({
      executable: blenderExecutable(),
      launcherArguments: BLENDER_LAUNCHER_ARGUMENTS,
      scriptPath: RUNNER_SCRIPT,
      prefixArguments: ["--"],
      cwd: document.root,
    });
    const blender = components.find((component) => component.id === "blender");
    const declared = validated.blenderVersion;
    if (!blender || blender.version !== declared) {
      throw new Error(
        `Blender ${String(blender?.version ?? "(not found)")} does not match declared blenderVersion ${declared}`,
      );
    }
    return components;
  },
  async generate(document:AssetSpecDocument) {
    const validated=validateBlenderScript(document);
    const { spec, root } = document;
    const inputs:Record<string,string> = {};
    for (const [name, artifact] of Object.entries(spec.inputs)) {
      if (name !== "script") {inputs[name] = artifact.path;}
    }
    return runProcessAdapter({
      executable: blenderExecutable(),
      launcherArguments: BLENDER_LAUNCHER_ARGUMENTS,
      scriptPath: RUNNER_SCRIPT,
      prefixArguments: ["--"],
      cwd: root,
      outputName: outputName(spec.output.path),
      request: {
        blenderVersion: validated.blenderVersion,
        scriptPath: validated.script.path,
        scriptSha256: validated.script.sha256,
        arguments: validated.arguments,
        inputArtifacts:spec.inputs,
        inputs,
      },
    });
  },
};
