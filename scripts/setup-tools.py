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

    def comfy_status(self, gpu: str | None = None) -> tuple[bool, str]:
        self.safe_storage()
        if not self.receipt.is_file():
            return False, "No verified managed ComfyUI installation (models are acquired separately)"
        try:
            state = json.loads(self.receipt.read_text(encoding="utf8"))
            expected = self.manifest["comfyui"]
            if (state.get("schemaVersion") != 1 or state.get("commit") != expected["commit"] or
                    state.get("cli") != expected["comfy-cli"] or
                    state.get("mcp") != expected["comfy-mcp"]):
                return False, "ComfyUI setup receipt conflicts with repository pins"
            if gpu and state.get("gpu") != gpu:
                return False, f"Existing ComfyUI backend {state.get('gpu')} differs from requested {gpu}"
            if not self.comfy_repo.is_dir() or not self.binary("comfy").is_file() or not self.binary("python").is_file():
                return False, "ComfyUI installation is incomplete"
            if run("git", "-C", str(self.comfy_repo), "rev-parse", "HEAD") != expected["commit"]:
                return False, "ComfyUI source revision drifted from pinned commit"
            origin = run("git", "-C", str(self.comfy_repo), "remote", "get-url", "origin")
            if origin != COMFY_SOURCE:
                return False, f"Unexpected ComfyUI source origin: {origin}"
            cli_packages = run(str(self.binary("python")), "-m", "pip", "freeze")
            if hashlib.sha256(cli_packages.encode("utf8")).hexdigest() != state.get("cliEnvironmentSha256"):
                return False, "ComfyUI CLI/MCP environment changed since setup"
            runtime_python = self.runtime_python(state.get("runtimeEnvironment"))
            if not runtime_python.is_file():
                return False, "Declared ComfyUI Python runtime disappeared"
            packages = run(str(runtime_python), "-m", "pip", "freeze")
            if hashlib.sha256(packages.encode("utf8")).hexdigest() != state.get("runtimeEnvironmentSha256"):
                return False, "ComfyUI runtime dependencies changed since setup"
            run(str(runtime_python), "-m", "pip", "check")
            for dist, label in (("comfy-cli", "cli"), ("comfy-mcp", "mcp")):
                package = run(str(self.binary("python")), "-m", "pip", "show", dist)
                version = next((line.removeprefix("Version: ") for line in package.splitlines() if line.startswith("Version: ")), None)
                if version != state[label]:
                    return False, f"{dist} version drifted: {version}"
            return True, f"ComfyUI {expected['commit'][:12]} ({state['gpu']}); MCP installed; model readiness unverified"
        except (OSError, KeyError, ValueError, subprocess.SubprocessError) as exc:
            return False, f"ComfyUI installation invalid: {exc}"

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

    def setup_comfy(self, gpu: str) -> None:
        self.safe_storage()
        valid, message = self.comfy_status(gpu)
        if valid:
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
        for dist, key in (("comfy-cli", "comfy-cli"), ("comfy-mcp", "comfy-mcp")):
            try:
                version_info = run(str(python), "-m", "pip", "show", dist)
            except subprocess.SubprocessError:
                version_info = ""
            if f"Version: {expected[key]}\n" not in version_info + "\n":
                run(str(python), "-m", "pip", "install", f"{dist}=={expected[key]}", timeout=600, capture=False)
        # The official CLI owns installing ComfyUI, PyTorch and requirements.
        # Never use ambient/cloud workspaces or mutate a user-managed install.
        environment = os.environ.copy()
        for key in ("VIRTUAL_ENV", "CONDA_PREFIX", "PYTHONHOME", "PYTHONPATH"):
            environment.pop(key, None)
        environment["COMFY_WHERE"] = "local"
        run(
            str(self.binary("comfy")), "--workspace", str(self.workspace), "--skip-prompt",
            "install", "--url", COMFY_SOURCE, "--commit", expected["commit"],
            "--skip-manager", f"--{'nvidia' if gpu == 'nvidia' else 'cpu'}", "--fast-deps",
            env=environment, timeout=3600, capture=False,
        )
        if run("git", "-C", str(self.comfy_repo), "rev-parse", "HEAD") != expected["commit"]:
            raise SetupError("Official installer did not install the declared ComfyUI commit")
        run(str(python), "-m", "pip", "check")
        cli_packages = run(str(python), "-m", "pip", "freeze")
        mode = "workspace" if self.runtime_python("workspace").is_file() else "cli"
        runtime = self.runtime_python(mode)
        run(str(runtime), "-m", "pip", "check")
        runtime_packages = run(str(runtime), "-m", "pip", "freeze")
        state = {
            "schemaVersion": 1, "commit": expected["commit"],
            "cli": expected["comfy-cli"], "mcp": expected["comfy-mcp"], "gpu": gpu,
            "runtimeEnvironment": mode,
            "cliEnvironmentSha256": hashlib.sha256(cli_packages.encode("utf8")).hexdigest(),
            "runtimeEnvironmentSha256": hashlib.sha256(runtime_packages.encode("utf8")).hexdigest(),
        }
        temp = self.receipt.with_suffix(".json.tmp")
        temp.write_text(json.dumps(state, indent=2) + "\n", encoding="utf8")
        temp.replace(self.receipt)
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
