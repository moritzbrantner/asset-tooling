"""Blender script runner for asset-tooling process-adapter-v1.

Runs inside Blender:

  blender --background --factory-startup --quiet --python-exit-code 1 \
    --python script_runner.py -- probe
  blender ... --python script_runner.py -- generate <request.json> <output> <observations.json>

The consumer's script is a hash-pinned spec input. It must define

  generate(output_path: str, arguments: dict, inputs: dict[str, str]) -> dict

which writes exactly one output file and returns JSON-serializable observations. `inputs` maps
every other declared spec input name to its portable path relative to the spec directory. The script runs in a factory-startup
scene with no add-ons beyond Blender's defaults and must not read undeclared files or the network.
All declared input files are rechecked into a disposable snapshot. Working directory and
portable input paths retain their existing spec-relative contract. Python dependencies
are executed from verified snapshot bytes through inputs.load_source(name).
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import os
import sys
import tempfile
from pathlib import Path
from types import MappingProxyType

import bpy


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    sys.stderr.flush()
    os._exit(1)


def finish() -> None:
    # Blender prints a status banner to stdout on normal exit, which would corrupt the probe's
    # JSON protocol; exit immediately once our own output is flushed.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def blender_version() -> str:
    return ".".join(str(part) for part in bpy.app.version)


def probe() -> None:
    binary = Path(bpy.app.binary_path)
    if not binary.is_file():
        fail("Blender binary path is not fingerprintable")
    components = [
        {
            "id": "blender-script-runner",
            "version": "1",
            "sha256": sha256_file(Path(__file__)),
        },
        {
            "id": "blender",
            "version": blender_version(),
            "versionCycle": bpy.app.version_cycle,
            "buildHash": bpy.app.build_hash.decode("ascii"),
            "executableSha256": sha256_file(binary),
        },
        {
            "id": "blender-python",
            "version": ".".join(str(part) for part in sys.version_info[:3]),
        },
    ]
    print(json.dumps(components, separators=(",", ":")))


def assert_json(value, location: str) -> None:
    if value is None or isinstance(value, (str, bool)):
        return
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            fail(f"{location} contains a non-finite number")
        return
    if isinstance(value, list):
        for index, child in enumerate(value):
            assert_json(child, f"{location}[{index}]")
        return
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str):
                fail(f"{location} contains a non-string key")
            assert_json(child, f"{location}.{key}")
        return
    fail(f"{location} contains unsupported value type {type(value).__name__!r}")


def verified_module(source_bytes: bytes, script_path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, script_path)
    if spec is None or spec.loader is None:
        fail(f"cannot load script {script_path}")
    module = importlib.util.module_from_spec(spec)
    # Execute verified source, never timestamp/size-matched ambient .pyc, and
    # retain normal module metadata without inheriting this runner's flags.
    exec(compile(source_bytes, spec.origin, "exec", dont_inherit=True), module.__dict__)
    return module


class VerifiedScriptInputs(dict):
    """A compatible portable path map with an explicit pinned Python loader."""

    def __init__(self, paths, snapshot: Path):
        super().__init__(paths)
        self._sources = MappingProxyType({
            name: (Path(relative), snapshot / relative) for name, relative in paths.items()
        })

    def load_source(self, name: str):
        if name not in self._sources:
            fail(f"undeclared Python input '{name}'")
        source_path, snapshot_path = self._sources[name]
        if source_path.suffix != ".py":
            fail(f"Python input '{name}' must be a .py source")
        source_bytes = snapshot_path.read_bytes()
        return verified_module(source_bytes, source_path, f"asset_tooling_input_{name}").__dict__


def generate(request_path: Path, output_path: Path, observations_path: Path) -> None:
    request = json.loads(request_path.read_text("utf8"))
    expected = request["blenderVersion"]
    if blender_version() != expected:
        fail(f"Blender {blender_version()} does not match declared blenderVersion {expected}")

    with tempfile.TemporaryDirectory(prefix="declared-inputs-", dir=request_path.parent) as temporary:
        snapshot = Path(temporary)
        for name, artifact in request["inputArtifacts"].items():
            relative = Path(artifact["path"])
            if relative.is_absolute() or ".." in relative.parts:
                fail(f"input '{name}' path must stay relative to the spec")
            destination = snapshot / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            with relative.open("rb") as source, destination.open("wb") as target:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
                    target.write(chunk)
            if digest.hexdigest() != artifact["sha256"]:
                fail(f"input '{name}' bytes changed after asset-tooling verified them")
        script_path = Path(request["scriptPath"])
        script_bytes = (snapshot / script_path).read_bytes()
        if hashlib.sha256(script_bytes).hexdigest() != request["scriptSha256"]:
            fail("script bytes changed after asset-tooling verified them")

        module = verified_module(script_bytes, script_path, "asset_tooling_blender_script")
        entry = getattr(module, "generate", None)
        if not callable(entry):
            fail("script must define generate(output_path, arguments, inputs)")

        observations = entry(str(output_path), request["arguments"], VerifiedScriptInputs(request["inputs"], snapshot))
    if not isinstance(observations, dict):
        fail("script generate() must return an observations dict")
    assert_json(observations, "script observations")
    if not output_path.is_file():
        fail("script generate() did not write the output file")
    observations_path.write_text(
        json.dumps(
            {"runner": "blender-script-runner-v1", "blenderVersion": blender_version(), "script": observations},
            sort_keys=True,
            separators=(",", ":"),
        ),
        "utf8",
    )


def main() -> None:
    arguments = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if arguments == ["probe"]:
        probe()
    elif len(arguments) == 4 and arguments[0] == "generate":
        generate(Path(arguments[1]), Path(arguments[2]), Path(arguments[3]))
    else:
        fail("usage: script_runner.py -- probe | generate <request> <output> <observations>")
    finish()


try:
    main()
except SystemExit:
    raise
except BaseException as error:  # noqa: BLE001 - any script failure must fail the adapter closed
    import traceback

    traceback.print_exc()
    fail(f"Blender script runner failed: {error}")
