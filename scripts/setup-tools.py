#!/usr/bin/env python3
"""Idempotent, repository-owned setup and read-only doctor for local asset tools."""

import argparse
import hashlib
import json
import os
import platform
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
COMFY_SOURCE = "https://github.com/Comfy-Org/ComfyUI.git"
CPU_TORCH_PACKAGES = ("torch", "torchvision")
# Probe of the runtime's torch build; the last stdout line is the JSON result.
TORCH_PROBE = "import json, torch; print(json.dumps({'version': torch.__version__, 'cuda': torch.version.cuda}))"
# Non-mutating probe of the runtime interpreter: its wheel platform key (same scheme as
# cpu_torch_platform_key) and the nvidia-*/triton names the installed torch declares.
ENV_PROBE = """
import json, platform, re, sys
from importlib import metadata
machine = platform.machine().lower()
machine = {"amd64": "x86_64", "x64": "x86_64"}.get(machine, machine)
def norm(name):
    return re.sub(r"[-_.]+", "-", name).lower()
def requirement_names(dist):
    try:
        requires = metadata.requires(dist) or []
    except metadata.PackageNotFoundError:
        return set()
    return {norm(re.split(r"[\\s;<>=!~\\[(@]", item.strip(), maxsplit=1)[0]) for item in requires}
def cuda_only(name):
    return name.startswith("nvidia-") or name.startswith("cuda-") or name == "triton"
installed = {norm(dist.metadata["Name"]) for dist in metadata.distributions() if dist.metadata["Name"]}
# Torch's CUDA dependencies are transitive (torch -> cuda-toolkit[...] / cuda-bindings -> nvidia-*):
# follow every installed CUDA-only requirement reachable from torch.
pending = sorted(name for name in requirement_names("torch") if cuda_only(name))
reached = set()
while pending:
    name = pending.pop()
    if name in reached:
        continue
    reached.add(name)
    if name in installed:
        pending.extend(sorted(child for child in requirement_names(name) if cuda_only(child) and child not in reached))
torchCudaRequirements = sorted(reached)
print(json.dumps({"key": f"{sys.platform}-{machine}-cp{sys.version_info[0]}{sys.version_info[1]}",
                  "torchCudaRequirements": torchCudaRequirements}))
"""


class SetupError(Exception):
    pass


def run(*args: str, cwd: Path | None = None, env: dict[str, str] | None = None, timeout: int = 120, capture: bool = True) -> str:
    completed = subprocess.run(
        args, cwd=cwd, env=env, check=True, text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        timeout=timeout,
    )
    return (completed.stdout or "").strip()


def normalize_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def cpu_torch_platform_key() -> str:
    """Key of the pinned CPU torch wheel set for this host, e.g. ``linux-x86_64-cp314``."""
    machine = platform.machine().lower()
    arch = {"amd64": "x86_64", "x64": "x86_64"}.get(machine, machine)
    return f"{sys.platform}-{arch}-cp{sys.version_info[0]}{sys.version_info[1]}"


def validate_cpu_torch(cpu: object) -> None:
    """Fail closed unless the CPU profile pins exact +cpu torch/torchvision wheels by SHA-256."""
    if not isinstance(cpu, dict):
        raise SetupError("comfyui.cpuTorch must declare the hash-pinned CPU torch wheels")
    index = cpu.get("indexUrl")
    if not isinstance(index, str) or not re.fullmatch(r"https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~-]+)*", index):
        raise SetupError("comfyui.cpuTorch.indexUrl must be an https URL")
    packages = cpu.get("packages")
    if not isinstance(packages, dict) or set(packages) != set(CPU_TORCH_PACKAGES):
        raise SetupError("comfyui.cpuTorch.packages must pin exactly torch and torchvision")
    for name, version in packages.items():
        if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+\+cpu", version):
            raise SetupError(f"comfyui.cpuTorch {name} must pin an exact +cpu release, not {version!r}")
    wheels = cpu.get("wheels")
    if not isinstance(wheels, dict) or not wheels:
        raise SetupError("comfyui.cpuTorch.wheels must declare at least one platform")
    for key, entries in wheels.items():
        match = re.fullmatch(r"linux-x86_64-(cp3\d+)", key)
        if not match:
            raise SetupError(f"comfyui.cpuTorch has unsupported platform {key!r} (only linux-x86_64)")
        if not isinstance(entries, list) or sorted(
                entry.get("name") if isinstance(entry, dict) else None for entry in entries) != sorted(CPU_TORCH_PACKAGES):
            raise SetupError(f"comfyui.cpuTorch {key} must list exactly one torch and one torchvision wheel")
        for entry in entries:
            name, url, digest = entry["name"], entry.get("url"), entry.get("sha256")
            filename = f"{name}-{packages[name].replace('+', '%2B')}-{match.group(1)}-"
            if not isinstance(url, str) or not url.startswith(index + "/") or \
                    not url.removeprefix(index + "/").startswith(filename) or not url.endswith(".whl"):
                raise SetupError(f"comfyui.cpuTorch {key} {name} wheel URL must be the pinned wheel under {index}")
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise SetupError(f"comfyui.cpuTorch {key} {name} must have a lowercase SHA-256 pin")


def pins(root: Path) -> dict:
    manifest = json.loads((root / "scripts/toolchain.json").read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1:
        raise SetupError("Unsupported local toolchain manifest version")
    comfy = manifest.get("comfyui", {})
    if not re.fullmatch(r"[0-9a-f]{40}", comfy.get("commit", "")):
        raise SetupError("ComfyUI must have an exact 40-character commit pin")
    for name in ("comfy-cli", "comfy-mcp"):
        if not re.fullmatch(r"\d+\.\d+\.\d+", comfy.get(name, "")):
            raise SetupError(f"{name} must have an exact release version")
    validate_cpu_torch(comfy.get("cpuTorch"))
    package = json.loads((root / "package.json").read_text(encoding="utf8"))
    bun = package.get("engines", {}).get("bun")
    if not isinstance(bun, str) or not re.fullmatch(r"\d+\.\d+\.\d+", bun):
        raise SetupError("package.json must pin an exact Bun version")
    if package.get("packageManager") != f"bun@{bun}":
        raise SetupError("package.json packageManager and engines.bun must agree")
    return {**manifest, "bun": bun}


class Toolchain:
    def __init__(self, root: Path):
        self.root = root
        self.manifest = pins(root)
        self.storage = root / ".artifacts" / "toolchain"
        self.env = self.storage / "comfy-cli-venv"
        self.workspace = self.storage / "comfy-workspace"
        self.comfy_repo = self.workspace / "ComfyUI"
        self.receipt = self.storage / "comfyui-install.json"
        self.blender = self.storage / "blender"

    def safe_storage(self) -> None:
        for p in (self.root / ".artifacts", self.storage, self.env, self.workspace, self.blender):
            if p.is_symlink():
                raise SetupError(f"Refusing to use symlinked managed tool path: {p}")

    def binary(self, name: str) -> Path:
        suffix = "Scripts" if os.name == "nt" else "bin"
        extension = ".exe" if os.name == "nt" else ""
        return self.env / suffix / f"{name}{extension}"

    def basic_status(self) -> tuple[bool, str]:
        executable = shutil.which("bun")
        if not executable:
            return False, f"Bun {self.manifest['bun']} is required on PATH (host prerequisite)"
        try:
            found = run(executable, "--version")
        except (OSError, subprocess.SubprocessError) as exc:
            return False, f"Cannot check Bun: {exc}"
        if found != self.manifest["bun"]:
            return False, f"Bun version {found} does not match {self.manifest['bun']}"
        return True, f"Bun {found}"

    def preview_status(self) -> tuple[bool, str]:
        try:
            blender = json.loads((self.root / "adapters/blender/release.json").read_text(encoding="utf8"))
            arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine().lower(), platform.machine())
            release = blender["releases"].get(f"{sys.platform}-{arch}")
            if not release:
                return False, f"No pinned Blender release for {sys.platform}-{arch}"
            executable = self.blender / release["executable"]
            if not executable.is_file():
                return False, f"Pinned Blender {blender['version']} is not installed in managed tool storage"
            actual = run(str(executable), "--version").splitlines()[0]
            if not actual.startswith(f"Blender {blender['version']}"):
                return False, f"Managed Blender version differs: {actual}"
            for binary in ("ffmpeg", "ffprobe"):
                if not shutil.which(binary):
                    return False, f"{binary} is missing (system codec prerequisite)"
            return True, f"Managed Blender {blender['version']} and system FFmpeg available"
        except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
            return False, f"Cannot check preview tools: {exc}"

    def runtime_python(self, mode: str) -> Path:
        if mode == "workspace":
            folder = "Scripts" if os.name == "nt" else "bin"
            binary = "python.exe" if os.name == "nt" else "python"
            return self.comfy_repo / ".venv" / folder / binary
        if mode == "cli":
            return self.binary("python")
        raise SetupError("Unrecognized ComfyUI runtime environment in receipt")

    def cpu_torch_record(self, key: str) -> dict:
        cpu = self.manifest["comfyui"]["cpuTorch"]
        return {"version": cpu["packages"]["torch"], "cuda": None,
                "wheels": [{"name": item["name"], "sha256": item["sha256"]} for item in cpu["wheels"][key]]}

    def cpu_torch_status(self, state: dict) -> tuple[bool, str]:
        """Check the receipt's torch record against the pins (no live probe; the env hash covers it)."""
        pinned = self.manifest["comfyui"]["cpuTorch"]["packages"]["torch"]
        record = state.get("torch")
        if record in (self.cpu_torch_record(key) for key in self.manifest["comfyui"]["cpuTorch"]["wheels"]):
            return True, pinned
        found = "no torch record" if record is None else f"recorded torch {record.get('version') if isinstance(record, dict) else record!r}"
        if isinstance(record, dict) and record.get("cuda") is not None:
            found += f" with CUDA {record['cuda']}"
        return False, (f"CPU ComfyUI torch is not the hash-pinned {pinned} build ({found}); "
                       "re-run setup --profile comfyui --gpu cpu to converge it")

    def comfy_check(self, gpu: str | None = None) -> tuple[bool, str, bool]:
        """Return (ready, message, convergible); convergible means only the CPU torch backend differs."""
        self.safe_storage()
        if not self.receipt.is_file():
            return False, "No verified managed ComfyUI installation (models are acquired separately)", False
        try:
            state = json.loads(self.receipt.read_text(encoding="utf8"))
            expected = self.manifest["comfyui"]
            if (state.get("schemaVersion") != 1 or state.get("commit") != expected["commit"] or
                    state.get("cli") != expected["comfy-cli"] or
                    state.get("mcp") != expected["comfy-mcp"]):
                return False, "ComfyUI setup receipt conflicts with repository pins", False
            if gpu and state.get("gpu") != gpu:
                return False, f"Existing ComfyUI backend {state.get('gpu')} differs from requested {gpu}", False
            if not self.comfy_repo.is_dir() or not self.binary("comfy").is_file() or not self.binary("python").is_file():
                return False, "ComfyUI installation is incomplete", False
            self.managed_runtime(self.runtime_python(state.get("runtimeEnvironment")))
            if run("git", "-C", str(self.comfy_repo), "rev-parse", "HEAD") != expected["commit"]:
                return False, "ComfyUI source revision drifted from pinned commit", False
            origin = run("git", "-C", str(self.comfy_repo), "remote", "get-url", "origin")
            if origin != COMFY_SOURCE:
                return False, f"Unexpected ComfyUI source origin: {origin}", False
            cli_packages = run(str(self.binary("python")), "-m", "pip", "freeze")
            if hashlib.sha256(cli_packages.encode("utf8")).hexdigest() != state.get("cliEnvironmentSha256"):
                return False, "ComfyUI CLI/MCP environment changed since setup", False
            runtime_python = self.runtime_python(state.get("runtimeEnvironment"))
            if not runtime_python.is_file():
                return False, "Declared ComfyUI Python runtime disappeared", False
            packages = run(str(runtime_python), "-m", "pip", "freeze")
            if hashlib.sha256(packages.encode("utf8")).hexdigest() != state.get("runtimeEnvironmentSha256"):
                return False, "ComfyUI runtime dependencies changed since setup", False
            run(str(runtime_python), "-m", "pip", "check")
            for dist, label in (("comfy-cli", "cli"), ("comfy-mcp", "mcp")):
                package = run(str(self.binary("python")), "-m", "pip", "show", dist)
                version = next((line.removeprefix("Version: ") for line in package.splitlines() if line.startswith("Version: ")), None)
                if version != state[label]:
                    return False, f"{dist} version drifted: {version}", False
            if state["gpu"] == "cpu":
                valid, torch = self.cpu_torch_status(state)
                if not valid:
                    return False, torch, True
                return True, f"ComfyUI {expected['commit'][:12]} (cpu, torch {torch}); MCP installed; model readiness unverified", False
            return True, f"ComfyUI {expected['commit'][:12]} ({state['gpu']}); MCP installed; model readiness unverified", False
        except SetupError as exc:
            return False, str(exc), False
        except (OSError, KeyError, ValueError, AttributeError, subprocess.SubprocessError) as exc:
            return False, f"ComfyUI installation invalid: {exc}", False

    def comfy_status(self, gpu: str | None = None) -> tuple[bool, str]:
        ready, message, _ = self.comfy_check(gpu)
        return ready, message

    def setup_basic(self) -> None:
        valid, message = self.basic_status()
        if not valid:
            raise SetupError(message)
        run("bun", "install", "--frozen-lockfile", cwd=self.root, timeout=600, capture=False)

    def setup_previews(self) -> None:
        self.safe_storage()
        valid, _ = self.preview_status()
        if valid:
            return
        valid_bun, message = self.basic_status()
        if not valid_bun:
            raise SetupError(message)
        for binary in ("ffmpeg", "ffprobe"):
            if not shutil.which(binary):
                raise SetupError(f"Install {binary} on the host before setting up native previews")
        if self.blender.exists():
            raise SetupError("Managed Blender directory exists but failed verification; refusing to overwrite it")
        self.storage.mkdir(parents=True, exist_ok=True)
        # Existing pinned, SHA-256-verified Blender installer owns archive selection and extraction.
        run("bun", "scripts/install-blender.ts", str(self.blender), cwd=self.root, timeout=1200, capture=False)
        valid, message = self.preview_status()
        if not valid:
            raise SetupError(message)

    def managed_runtime(self, python: Path) -> Path:
        """The runtime venv must be a real directory tree inside managed storage (bin/python may link out)."""
        venv = python.parent.parent
        try:
            relative = venv.relative_to(self.storage)
        except ValueError:
            raise SetupError(f"ComfyUI runtime {venv} is outside managed tool storage") from None
        if ".." in relative.parts:
            raise SetupError(f"ComfyUI runtime {venv} is outside managed tool storage")
        current = self.storage
        for part in ("",) + relative.parts:
            current = current / part if part else current
            if current.is_symlink():
                raise SetupError(f"Refusing to use symlinked managed ComfyUI runtime path: {current}")
        return python

    def runtime_environment(self, runtime: Path) -> tuple[str, list[str]]:
        """Probe the runtime interpreter for its pinned wheel key and torch's declared CUDA requirements."""
        try:
            output = run(str(runtime), "-c", ENV_PROBE, timeout=600)
            probe = json.loads(output.strip().splitlines()[-1])
            key, requirements = probe["key"], probe["torchCudaRequirements"]
            if not isinstance(key, str) or not isinstance(requirements, list) or \
                    not all(isinstance(name, str) for name in requirements):
                raise ValueError(f"malformed probe result {probe!r}")
        except (subprocess.SubprocessError, ValueError, IndexError, KeyError, TypeError) as exc:
            raise SetupError(f"Cannot probe the ComfyUI runtime environment: {exc}") from exc
        return self.cpu_torch_key(key), [normalize_name(name) for name in requirements]

    def cpu_torch_key(self, key: str | None = None) -> str:
        key = key or cpu_torch_platform_key()
        if key not in self.manifest["comfyui"]["cpuTorch"]["wheels"]:
            raise SetupError(f"No hash-pinned CPU torch wheels for platform {key}; "
                             "the CPU ComfyUI profile supports linux-x86_64 cp310-cp315 only")
        return key

    def install_cpu_torch(self, runtime: Path, key: str) -> None:
        """Install the hash-pinned +cpu torch/torchvision wheels, without dependency resolution."""
        lines = [f"{item['name']} @ {item['url']} --hash=sha256:{item['sha256']}"
                 for item in self.manifest["comfyui"]["cpuTorch"]["wheels"][key]]
        requirements = self.storage / "cpu-torch-requirements.txt"
        requirements.write_text("# Generated from scripts/toolchain.json comfyui.cpuTorch\n" + "\n".join(lines) + "\n",
                                encoding="utf8")
        try:
            run(str(runtime), "-m", "pip", "install", "--require-hashes", "--no-deps", "-r", str(requirements),
                timeout=3600, capture=False)
        finally:
            requirements.unlink(missing_ok=True)

    def verify_cpu_torch(self, runtime: Path) -> None:
        """Live probe after installing: the runtime must import the pinned +cpu build without CUDA."""
        pinned = self.manifest["comfyui"]["cpuTorch"]["packages"]["torch"]
        try:
            output = run(str(runtime), "-c", TORCH_PROBE, timeout=600)
            probe = json.loads(output.strip().splitlines()[-1])
        except (subprocess.SubprocessError, ValueError, IndexError) as exc:
            raise SetupError(f"Cannot import torch in the ComfyUI runtime: {exc}") from exc
        if not isinstance(probe, dict) or probe.get("version") != pinned or probe.get("cuda") is not None:
            raise SetupError(f"ComfyUI runtime torch is {probe!r}, not the pinned {pinned} build without CUDA")

    @staticmethod
    def installed_requirements(freeze: str, requirements: list[str]) -> list[str]:
        """Installed distributions (as pip freeze names them) that torch declared as CUDA requirements."""
        wanted = set(requirements)
        names = []
        for line in freeze.splitlines():
            line = line.strip()
            if not line or line.startswith(("#", "-")):
                continue
            name = re.split(r"\s*(?:==|@|\s)", line, maxsplit=1)[0].strip()
            if normalize_name(name) in wanted:
                names.append(name)
        return names

    def write_receipt(self, state: dict) -> None:
        temp = self.receipt.with_suffix(".json.tmp")
        temp.write_text(json.dumps(state, indent=2) + "\n", encoding="utf8")
        temp.replace(self.receipt)

    def converge_cpu_torch(self) -> None:
        """Bring an otherwise intact managed CPU install to the pinned +cpu torch (Decision 5.1.3)."""
        state = json.loads(self.receipt.read_text(encoding="utf8"))
        runtime = self.managed_runtime(self.runtime_python(state["runtimeEnvironment"]))
        # Wheels follow the runtime's ABI, not the caller's; fail before removing anything.
        key, requirements = self.runtime_environment(runtime)
        cuda = self.installed_requirements(run(str(runtime), "-m", "pip", "freeze"), requirements)
        if cuda:
            run(str(runtime), "-m", "pip", "uninstall", "-y", *cuda, timeout=600, capture=False)
        self.install_cpu_torch(runtime, key)
        run(str(runtime), "-m", "pip", "check")
        self.verify_cpu_torch(runtime)
        # In cli-runtime mode the CLI environment is the runtime, so both hashes are taken afterwards.
        cli_packages = run(str(self.binary("python")), "-m", "pip", "freeze")
        runtime_packages = run(str(runtime), "-m", "pip", "freeze")
        self.write_receipt({
            **state, "torch": self.cpu_torch_record(key),
            "cliEnvironmentSha256": hashlib.sha256(cli_packages.encode("utf8")).hexdigest(),
            "runtimeEnvironmentSha256": hashlib.sha256(runtime_packages.encode("utf8")).hexdigest(),
        })

    def setup_comfy(self, gpu: str) -> None:
        self.safe_storage()
        # CPU wheels exist only for pinned platforms; fail before touching anything elsewhere.
        if gpu == "cpu":
            self.cpu_torch_key()
        valid, message, convergible = self.comfy_check(gpu)
        if valid:
            return
        if convergible and gpu == "cpu":
            self.converge_cpu_torch()
            valid, message = self.comfy_status(gpu)
            if not valid:
                raise SetupError(message)
            return
        if self.receipt.exists() or self.comfy_repo.exists():
            raise SetupError(message + "; refusing to modify existing ComfyUI state")
        if not shutil.which("git"):
            raise SetupError("git is required to acquire pinned ComfyUI source")
        if sys.version_info < (3, 10):
            raise SetupError("Python 3.10 or newer is required")
        if gpu == "nvidia" and not shutil.which("nvidia-smi"):
            raise SetupError("NVIDIA backend requires nvidia-smi; select --gpu cpu explicitly for CPU")
        self.storage.mkdir(parents=True, exist_ok=True)
        python = self.binary("python")
        if not self.env.exists():
            run(sys.executable, "-m", "venv", str(self.env))
        if not python.is_file():
            raise SetupError("Managed Python virtual environment is incomplete")
        expected = self.manifest["comfyui"]
        for dist, key_name in (("comfy-cli", "comfy-cli"), ("comfy-mcp", "comfy-mcp")):
            try:
                version_info = run(str(python), "-m", "pip", "show", dist)
            except subprocess.SubprocessError:
                version_info = ""
            if f"Version: {expected[key_name]}\n" not in version_info + "\n":
                run(str(python), "-m", "pip", "install", f"{dist}=={expected[key_name]}", timeout=600, capture=False)
        # The official CLI installs ComfyUI. For NVIDIA it also owns PyTorch and requirements;
        # for CPU it installs source only, because its resolver pulls CUDA torch from PyPI (#220).
        # Never use ambient/cloud workspaces or mutate a user-managed install.
        environment = os.environ.copy()
        for name in ("VIRTUAL_ENV", "CONDA_PREFIX", "PYTHONHOME", "PYTHONPATH"):
            environment.pop(name, None)
        environment["COMFY_WHERE"] = "local"
        backend = ["--nvidia", "--fast-deps"] if gpu == "nvidia" else ["--cpu", "--skip-torch-or-directml", "--skip-requirement"]
        run(
            str(self.binary("comfy")), "--workspace", str(self.comfy_repo), "--skip-prompt",
            # comfy-cli only accepts --commit together with the nightly version.
            "install", "--url", COMFY_SOURCE, "--version", "nightly", "--commit", expected["commit"],
            "--skip-manager", *backend,
            env=environment, timeout=3600, capture=False,
        )
        if run("git", "-C", str(self.comfy_repo), "rev-parse", "HEAD") != expected["commit"]:
            raise SetupError("Official installer did not install the declared ComfyUI commit")
        mode = "workspace" if self.runtime_python("workspace").is_file() else "cli"
        runtime = self.runtime_python(mode)
        if gpu == "cpu":
            self.managed_runtime(runtime)
            key, _ = self.runtime_environment(runtime)
            self.install_cpu_torch(runtime, key)
            run(str(runtime), "-m", "pip", "install", "-r", str(self.comfy_repo / "requirements.txt"),
                timeout=3600, capture=False)
            run(str(runtime), "-m", "pip", "check")
            self.verify_cpu_torch(runtime)
        run(str(python), "-m", "pip", "check")
        cli_packages = run(str(python), "-m", "pip", "freeze")
        run(str(runtime), "-m", "pip", "check")
        runtime_packages = run(str(runtime), "-m", "pip", "freeze")
        state = {
            "schemaVersion": 1, "commit": expected["commit"],
            "cli": expected["comfy-cli"], "mcp": expected["comfy-mcp"], "gpu": gpu,
            "runtimeEnvironment": mode,
            "cliEnvironmentSha256": hashlib.sha256(cli_packages.encode("utf8")).hexdigest(),
            "runtimeEnvironmentSha256": hashlib.sha256(runtime_packages.encode("utf8")).hexdigest(),
        }
        if gpu == "cpu":
            state["torch"] = self.cpu_torch_record(key)
        self.write_receipt(state)
        valid, message = self.comfy_status(gpu)
        if not valid:
            raise SetupError(message)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("setup", "doctor"))
    parser.add_argument("--profile", choices=("core", "previews", "comfyui", "all"), default="core")
    parser.add_argument("--gpu", choices=("nvidia", "cpu"), help="Explicit ComfyUI backend for setup")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable diagnostics")
    args = parser.parse_args()
    try:
        toolchain = Toolchain(ROOT)
        if args.action == "setup" and args.profile in ("comfyui", "all") and not args.gpu:
            raise SetupError("--gpu nvidia|cpu is required for ComfyUI installation")
        if args.action == "setup":
            if args.profile in ("core", "all"):
                toolchain.setup_basic()
            if args.profile in ("previews", "all"):
                toolchain.setup_previews()
            if args.profile in ("comfyui", "all"):
                toolchain.setup_comfy(args.gpu)
        profiles = ["core", "previews", "comfyui"] if args.profile == "all" else [args.profile]
        checks = {"core": toolchain.basic_status, "previews": toolchain.preview_status,
                  "comfyui": lambda: toolchain.comfy_status(args.gpu)}
        results = {name: dict(zip(("ready", "message"), checks[name]())) for name in profiles}
        if args.json:
            print(json.dumps({"schemaVersion": 1, "profiles": results}, sort_keys=True))
        else:
            for name, result in results.items():
                print(f"{name}: {'ready' if result['ready'] else 'missing'} — {result['message']}")
        return 0 if all(result["ready"] for result in results.values()) else 1
    except (SetupError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        if args.json:
            print(json.dumps({"schemaVersion": 1, "error": str(exc)}))
        else:
            print(f"tool setup error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
