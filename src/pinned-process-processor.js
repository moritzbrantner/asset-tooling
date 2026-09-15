import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { probeProcessAdapter } from "./process-adapter.js";
import { captureCargoRuntimeIdentity } from "./processor-runtime.js";
import { captureToolIdentity } from "./tool.js";

const execFileAsync = promisify(execFile);
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, location) {
  if (!isPlainObject(value)) throw new Error(`${location} must be a plain object`);
  return value;
}

function assertNonEmptyString(value, location) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value;
}

function normalizeProcessor(value, operationId) {
  const processor = assertPlainObject(value, `${operationId} processor`);
  const allowed = new Set([
    "repository",
    "revision",
    "executable",
    "scriptPath",
    "prefixArguments",
    "checkoutRoot",
    "sourceFiles",
  ]);
  for (const key of Object.keys(processor)) {
    if (!allowed.has(key)) throw new Error(`${operationId} processor contains unknown field '${key}'`);
  }
  const repository = assertNonEmptyString(processor.repository, "processor.repository");
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error("processor.repository must use owner/repository form");
  }
  if (typeof processor.revision !== "string" || !GIT_SHA_PATTERN.test(processor.revision)) {
    throw new Error("processor.revision must be an exact lowercase 40-character Git commit SHA");
  }
  const executable = assertNonEmptyString(processor.executable, "processor.executable");
  const scriptPath = assertNonEmptyString(processor.scriptPath, "processor.scriptPath");
  const prefixArguments = processor.prefixArguments ?? [];
  if (!Array.isArray(prefixArguments)) throw new Error("processor.prefixArguments must be an array");
  prefixArguments.forEach((argument, index) =>
    assertNonEmptyString(argument, `processor.prefixArguments[${index}]`),
  );
  if (
    /^cargo(?:\.exe)?$/i.test(path.basename(executable)) &&
    !prefixArguments.includes("--offline") &&
    !prefixArguments.includes("--frozen")
  ) {
    throw new Error(`${operationId} cargo processor must run with --offline or --frozen`);
  }

  const hasCheckoutRoot = processor.checkoutRoot !== undefined;
  const hasSourceFiles = processor.sourceFiles !== undefined;
  if (hasCheckoutRoot === hasSourceFiles) {
    throw new Error("processor must declare exactly one of checkoutRoot or sourceFiles");
  }

  let checkoutRoot;
  let sourceFiles;
  if (hasCheckoutRoot) {
    checkoutRoot = assertNonEmptyString(processor.checkoutRoot, "processor.checkoutRoot");
    if (!path.isAbsolute(checkoutRoot)) {
      throw new Error("processor.checkoutRoot must be an absolute path");
    }
  } else {
    if (!Array.isArray(processor.sourceFiles) || processor.sourceFiles.length === 0) {
      throw new Error("processor.sourceFiles must be a non-empty array");
    }
    sourceFiles = processor.sourceFiles.map((file, index) => {
      const normalized = assertNonEmptyString(file, `processor.sourceFiles[${index}]`);
      if (!path.isAbsolute(normalized)) {
        throw new Error(`processor.sourceFiles[${index}] must be an absolute path`);
      }
      return path.resolve(normalized);
    });
    if (new Set(sourceFiles).size !== sourceFiles.length) {
      throw new Error("processor.sourceFiles must not contain duplicates");
    }
  }

  return {
    repository,
    revision: processor.revision,
    executable,
    scriptPath,
    prefixArguments: [...prefixArguments],
    ...(checkoutRoot === undefined ? {} : { checkoutRoot: path.resolve(checkoutRoot) }),
    ...(sourceFiles === undefined ? {} : { sourceFiles }),
  };
}

function processorStorageEnvironment(processor) {
  if (!/^cargo(?:\.exe)?$/i.test(path.basename(processor.executable))) return {};
  const environment = {};
  for (const name of ["CARGO_HOME", "RUSTUP_HOME", "HOME", "USERPROFILE"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export function resolveCargoManifestPath(root, manifestValue) {
  return path.isAbsolute(manifestValue)
    ? path.resolve(manifestValue)
    : path.resolve(root, manifestValue);
}

async function gitOutput(checkoutRoot, arguments_, location) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", checkoutRoot, ...arguments_], {
      encoding: "utf8",
      windowsHide: true,
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(`${location} failed: ${error.message}`);
  }
}

async function verifyProcessorSource(processor, root, operationId) {
  if (processor.checkoutRoot !== undefined) {
    const actualRevision = await gitOutput(
      processor.checkoutRoot,
      ["rev-parse", "HEAD"],
      `${operationId} processor checkout revision verification`,
    );
    if (actualRevision !== processor.revision) {
      throw new Error(
        `${operationId} processor checkout HEAD '${actualRevision}' does not match declared revision '${processor.revision}'`,
      );
    }
    const status = await gitOutput(
      processor.checkoutRoot,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      `${operationId} processor checkout cleanliness verification`,
    );
    const unexpectedStatus = status
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && line !== "?? Cargo.lock");
    if (unexpectedStatus.length > 0) {
      throw new Error(`${operationId} processor checkout must be source-clean at the declared revision`);
    }

    if (/^cargo(?:\.exe)?$/i.test(path.basename(processor.executable))) {
      const manifestIndex = processor.prefixArguments.indexOf("--manifest-path");
      const manifestValue = processor.prefixArguments[manifestIndex + 1];
      if (manifestIndex < 0 || typeof manifestValue !== "string") {
        throw new Error(`${operationId} cargo processor must declare --manifest-path`);
      }
      const manifestPath = resolveCargoManifestPath(root, manifestValue);
      if (!pathIsInside(processor.checkoutRoot, manifestPath)) {
        throw new Error(`${operationId} processor manifest must be inside checkoutRoot`);
      }
      const manifestRelativePath = path.relative(processor.checkoutRoot, manifestPath);
      await gitOutput(
        processor.checkoutRoot,
        ["ls-files", "--error-unmatch", "--", manifestRelativePath],
        `${operationId} processor manifest tracking verification`,
      );
    } else {
      const scriptPath = path.isAbsolute(processor.scriptPath)
        ? path.resolve(processor.scriptPath)
        : path.resolve(root, processor.scriptPath);
      if (!pathIsInside(processor.checkoutRoot, scriptPath)) {
        throw new Error(`${operationId} processor script must be inside checkoutRoot`);
      }
    }

    return {
      repository: processor.repository,
      revision: processor.revision,
      verification: "git-clean-exact-head",
    };
  }

  const scriptPath = path.isAbsolute(processor.scriptPath)
    ? path.resolve(processor.scriptPath)
    : path.resolve(root, processor.scriptPath);
  if (!processor.sourceFiles.includes(scriptPath)) {
    throw new Error(`${operationId} processor.sourceFiles must include the executed scriptPath`);
  }
  const fileHashes = [];
  for (const sourceFile of processor.sourceFiles) {
    let bytes;
    try {
      bytes = await readFile(sourceFile);
    } catch (error) {
      throw new Error(
        `${operationId} processor source file '${sourceFile}' could not be read: ${error.message}`,
      );
    }
    fileHashes.push(createHash("sha256").update(bytes).digest("hex"));
  }
  fileHashes.sort();
  return {
    repository: processor.repository,
    revision: processor.revision,
    sourceSha256: createHash("sha256").update(JSON.stringify(fileHashes)).digest("hex"),
  };
}

function normalizeProbe(components, { operationId, processorId, protocol, codec }) {
  const matching = components.filter((component) => component.id === processorId);
  if (matching.length !== 1) {
    throw new Error(`processor probe must contain exactly one '${processorId}' component`);
  }
  const component = assertPlainObject(matching[0], `${operationId} processor probe component`);
  assertNonEmptyString(component.version, "processor probe version");
  assertNonEmptyString(component.algorithm, "processor probe algorithm");
  if (component.protocol !== protocol) {
    throw new Error(`processor probe protocol must be '${protocol}'`);
  }
  if (component.codec !== codec) {
    throw new Error(`processor probe codec must be '${codec}'`);
  }
  assertPlainObject(component.dependencies, "processor probe dependencies");
  assertNonEmptyString(component.cargoLock, "processor probe cargoLock");
  return component;
}

export async function capturePinnedProcessProcessorIdentity(root, processorValue, identity) {
  const { operationId, processorId, protocol, codec } = identity;
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error(`${operationId} root must be an absolute path`);
  }
  const processor = normalizeProcessor(processorValue, operationId);
  const source = await verifyProcessorSource(processor, root, operationId);
  const environment = processorStorageEnvironment(processor);
  const runtime = /^cargo(?:\.exe)?$/i.test(path.basename(processor.executable))
    ? await captureCargoRuntimeIdentity({
        executable: processor.executable,
        cwd: processor.checkoutRoot ?? root,
        environment,
      })
    : undefined;
  const components = await probeProcessAdapter({
    executable: processor.executable,
    scriptPath: processor.scriptPath,
    prefixArguments: processor.prefixArguments,
    cwd: root,
    environment,
  });
  const probe = normalizeProbe(components, { operationId, processorId, protocol, codec });
  return {
    processor,
    environment,
    implementation: {
      id: probe.id,
      version: probe.version,
      source,
      ...(runtime ? { runtime } : {}),
      probe,
      assetTooling: await captureToolIdentity(),
    },
  };
}
