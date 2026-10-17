"""Local setup safety regressions: no network, no GPU, no model downloads."""

from collections import namedtuple
import contextlib
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().with_name("setup-tools.py")
spec = importlib.util.spec_from_file_location("asset_setup_tools", SOURCE)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)

COMMIT = "a" * 40
CPU_INDEX = "https://download.pytorch.org/whl/cpu"
TORCH = "2.14.1+cpu"
TORCHVISION = "0.29.1+cpu"
CUDA_TORCH = "2.14.1+cu130"
VersionInfo = namedtuple("VersionInfo", "major minor micro releaselevel serial")
PINNED_KEY = "linux-x86_64-cp314"
CUDA_ONLY = {"nvidia-cublas-cu13": "13.0.0", "nvidia-cudnn-cu13": "9.10.0", "nvidia-nccl-cu13": "2.27.0", "triton": "3.5.0"}


def fake_sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf8")).hexdigest()


def cpu_torch_fixture() -> dict:
    wheels = {}
    for minor in range(10, 16):
        tag = f"cp3{minor}"
        wheels[f"linux-x86_64-{tag}"] = [
            {"name": "torch", "url": f"{CPU_INDEX}/torch-2.14.1%2Bcpu-{tag}-{tag}-manylinux_2_28_x86_64.whl",
             "sha256": fake_sha(f"torch-{tag}")},
            {"name": "torchvision", "url": f"{CPU_INDEX}/torchvision-0.29.1%2Bcpu-{tag}-{tag}-manylinux_2_28_x86_64.whl",
             "sha256": fake_sha(f"torchvision-{tag}")},
        ]
    return {"indexUrl": CPU_INDEX, "packages": {"torch": TORCH, "torchvision": TORCHVISION}, "wheels": wheels}


def wheel(name: str, key: str = PINNED_KEY) -> dict:
    return next(item for item in cpu_torch_fixture()["wheels"][key] if item["name"] == name)


def expected_requirement_lines(key: str = PINNED_KEY) -> list[str]:
    return sorted(f"{item['name']} @ {item['url']} --hash=sha256:{item['sha256']}" for item in cpu_torch_fixture()["wheels"][key])


def torch_record(key: str = PINNED_KEY) -> dict:
    return {"version": TORCH, "cuda": None,
            "wheels": [{"name": "torch", "sha256": wheel("torch", key)["sha256"]},
                       {"name": "torchvision", "sha256": wheel("torchvision", key)["sha256"]}]}


def is_env_probe(call: list[str]) -> bool:
    """Runtime platform/ABI and torch-requirements probe (non-mutating)."""
    return "-c" in call and "torchCudaRequirements" in call[call.index("-c") + 1]


def is_torch_probe(call: list[str]) -> bool:
    """Post-install torch import/version probe."""
    return "-c" in call and not is_env_probe(call)


@contextlib.contextmanager
def host(system: str = "linux", machine: str = "x86_64", version: tuple[int, int] = (3, 14)):
    """Patch only the platform identity; the module computes its key at call time."""
    info = VersionInfo(version[0], version[1], 0, "final", 0)
    with patch.object(setup.sys, "platform", system), \
            patch.object(setup.platform, "machine", return_value=machine), \
            patch.object(setup.sys, "version_info", info), \
            patch.object(setup.shutil, "which", side_effect=lambda name: f"/usr/bin/{name}"):
        yield


class FakeHost:
    """Offline stand-in for every external command setup-tools may run.

    Unknown commands fail the test, so unexpected mutation is detected rather than ignored.
    """

    def __init__(self, tc, runtime_packages=None, workspace_venv=True, commit=COMMIT, origin=None):
        self.tc = tc
        self.cli = {"comfy-cli": "1.22.0", "comfy-mcp": "0.10.0", "click": "8.1.0"}
        self.workspace_venv = workspace_venv
        if workspace_venv:
            self.runtime = dict(runtime_packages or {})
        else:
            self.cli.update(runtime_packages or {})
            self.runtime = self.cli
        self.commit = commit
        self.origin = origin or setup.COMFY_SOURCE
        self.calls: list[list[str]] = []
        self.requirement_files: list[tuple[str, str]] = []
        self.probe_override = None
        # Per-interpreter platform key reported by the runtime env probe; interpreters not
        # listed report the caller's key (a venv created by the caller shares its ABI).
        self.interpreter_keys: dict[str, str] = {}
        # Requires-Dist names (nvidia-*/triton) declared by an installed CUDA torch build.
        self.cuda_torch_requires = list(CUDA_ONLY)
        # When set, the official installer's workspace `.venv` (or its python binary) is
        # created as a symlink to this target.
        self.venv_link_target: Path | None = None
        self.python_link_target: Path | None = None

    # Helpers for building existing installs ---------------------------------------------
    @staticmethod
    def freeze_text(packages: dict) -> str:
        return "\n".join(f"{name}=={version}" for name, version in sorted(packages.items()))

    def cli_python(self) -> str:
        return str(self.tc.binary("python"))

    def workspace_python(self) -> str:
        return str(self.tc.runtime_python("workspace"))

    def runtime_python(self) -> str:
        return self.workspace_python() if self.workspace_venv else self.cli_python()

    def materialize_install(self, gpu="cpu", torch=None, runtime_sha=None, omit_torch=False):
        tc = self.tc
        tc.comfy_repo.mkdir(parents=True)
        (tc.comfy_repo / "requirements.txt").write_text("numpy\n", encoding="utf8")
        (tc.comfy_repo / "main.py").write_text("# pinned source\n", encoding="utf8")
        tc.env.joinpath("bin").mkdir(parents=True)
        for binary in (tc.binary("comfy"), tc.binary("python")):
            binary.touch()
        if self.workspace_venv:
            self.make_workspace_venv()
        state = {
            "schemaVersion": 1, "commit": COMMIT, "cli": "1.22.0", "mcp": "0.10.0", "gpu": gpu,
            "runtimeEnvironment": "workspace" if self.workspace_venv else "cli",
            "cliEnvironmentSha256": fake_sha(self.freeze_text(self.cli)),
            "runtimeEnvironmentSha256": runtime_sha or fake_sha(self.freeze_text(self.runtime)),
        }
        if not omit_torch and torch is not None:
            state["torch"] = torch
        tc.receipt.write_text(json.dumps(state, indent=2), encoding="utf8")
        return state

    def make_workspace_venv(self):
        venv = self.tc.comfy_repo / ".venv"
        if self.venv_link_target is not None and not venv.exists():
            self.venv_link_target.mkdir(parents=True, exist_ok=True)
            venv.symlink_to(self.venv_link_target, target_is_directory=True)
        python = Path(self.workspace_python())
        python.parent.mkdir(parents=True, exist_ok=True)
        if self.python_link_target is not None:
            self.python_link_target.parent.mkdir(parents=True, exist_ok=True)
            self.python_link_target.touch()
            if not python.is_symlink():
                python.symlink_to(self.python_link_target)
        else:
            python.touch()

    def torch_cuda_requirements(self, packages: dict) -> list[str]:
        version = packages.get("torch")
        if version is None or version.endswith("+cpu"):
            return []
        return [name.lower() for name in self.cuda_torch_requires]

    # Classification -------------------------------------------------------------------
    def packages_for(self, python: str) -> dict:
        if python == self.cli_python():
            return self.cli
        if self.workspace_venv and python == self.workspace_python():
            return self.runtime
        raise AssertionError(f"unexpected Python interpreter: {python}")

    def mutating_calls(self) -> list[list[str]]:
        result = []
        for call in self.calls:
            if call[0] == str(self.tc.binary("comfy")) or "venv" in call[1:3]:
                result.append(call)
            elif "pip" in call and ("install" in call or "uninstall" in call):
                result.append(call)
        return result

    def index(self, predicate) -> int:
        for position, call in enumerate(self.calls):
            if predicate(call):
                return position
        raise AssertionError("expected invocation not found in: " + "\n".join(" ".join(c) for c in self.calls))

    def uninstalled(self) -> set[str]:
        names = set()
        for call in self.calls:
            if "pip" in call and "uninstall" in call:
                names.update(arg for arg in call[call.index("uninstall") + 1:] if not arg.startswith("-"))
        return names

    # Dispatch -------------------------------------------------------------------------
    def __call__(self, *args, cwd=None, env=None, timeout=120, capture=True):
        args = [str(arg) for arg in args]
        self.calls.append(args)
        tc = self.tc
        executable = args[0]
        if args[1:3] == ["-m", "venv"]:
            tc.env.joinpath("bin").mkdir(parents=True, exist_ok=True)
            tc.binary("python").touch()
            tc.binary("comfy").touch()
            return ""
        if executable == str(tc.binary("comfy")):
            if "install" not in args:
                raise AssertionError(f"unexpected comfy invocation: {args}")
            tc.comfy_repo.mkdir(parents=True, exist_ok=True)
            (tc.comfy_repo / "requirements.txt").write_text("numpy\n", encoding="utf8")
            if self.workspace_venv:
                self.make_workspace_venv()
            return ""
        if executable == "git":
            if "rev-parse" in args:
                return self.commit
            if "get-url" in args:
                return self.origin
            raise AssertionError(f"unexpected git invocation: {args}")
        packages = self.packages_for(executable)
        if is_env_probe(args):
            key = self.interpreter_keys.get(executable, setup.cpu_torch_platform_key())
            return "noise from site hooks\n" + json.dumps(
                {"key": key, "torchCudaRequirements": self.torch_cuda_requirements(packages)})
        if "-c" in args:
            if self.probe_override is not None:
                return "noise from import\n" + json.dumps(self.probe_override)
            if "torch" not in packages:
                raise subprocess.CalledProcessError(1, args, "ModuleNotFoundError: torch")
            version = packages["torch"]
            return json.dumps({"version": version, "cuda": None if version.endswith("+cpu") else "13.0"})
        if args[1:3] != ["-m", "pip"]:
            raise AssertionError(f"unexpected invocation: {args}")
        command = args[3]
        if command == "freeze":
            return self.freeze_text(packages)
        if command == "check":
            return "No broken requirements found."
        if command == "show":
            name = args[4]
            if name not in packages:
                raise subprocess.CalledProcessError(1, args)
            return f"Name: {name}\nVersion: {packages[name]}"
        if command == "uninstall":
            for name in args[4:]:
                if not name.startswith("-"):
                    packages.pop(name, None)
            return ""
        if command == "install":
            if "-r" in args:
                requirement = Path(args[args.index("-r") + 1])
                content = requirement.read_text(encoding="utf8")
                if "--require-hashes" in args:
                    self.requirement_files.append((executable, content))
                    pinned = {"torch": TORCH, "torchvision": TORCHVISION}
                    for line in content.splitlines():
                        if " @ " in line:
                            name = line.split(" @ ", 1)[0].strip()
                            packages[name] = pinned[name]
                    return ""
                if requirement == tc.comfy_repo / "requirements.txt":
                    packages["numpy"] = "2.3.0"
                    return ""
                raise AssertionError(f"unexpected requirements file: {requirement}")
            for item in args[4:]:
                if "==" in item:
                    name, version = item.split("==", 1)
                    packages[name] = version
            return ""
        raise AssertionError(f"unexpected pip invocation: {args}")


def write_fixture(root: Path, cpu_torch=None, drop_cpu_torch=False) -> None:
    scripts = root / "scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    (root / "package.json").write_text(json.dumps({"engines": {"bun": "1.4.3"}, "packageManager": "bun@1.4.3"}))
    comfy = {"commit": COMMIT, "comfy-cli": "1.22.0", "comfy-mcp": "0.10.0",
             "cpuTorch": cpu_torch if cpu_torch is not None else cpu_torch_fixture()}
    if drop_cpu_torch:
        del comfy["cpuTorch"]
    (scripts / "toolchain.json").write_text(json.dumps({"schemaVersion": 1, "comfyui": comfy}), encoding="utf8")


class LocalToolSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        write_fixture(self.root)
        self.toolchain = setup.Toolchain(self.root)

    def test_doctor_is_read_only_when_comfyui_is_missing(self):
        self.assertEqual(self.toolchain.comfy_status("cpu")[0], False)
        self.assertFalse((self.root / ".artifacts").exists())

    def test_reject_unpinned_source_before_setup(self):
        pin_file = self.root / "scripts/toolchain.json"
        data = json.loads(pin_file.read_text())
        data["comfyui"]["commit"] = "main"
        pin_file.write_text(json.dumps(data))
        with self.assertRaisesRegex(setup.SetupError, "commit pin"):
            setup.Toolchain(self.root)
        self.assertFalse((self.root / ".artifacts").exists())

    def test_existing_unowned_checkout_is_not_modified(self):
        self.toolchain.comfy_repo.mkdir(parents=True)
        marker = self.toolchain.comfy_repo / "keep.txt"
        marker.write_text("untouched")
        with host(), patch.object(setup, "run") as run:
            with self.assertRaisesRegex(setup.SetupError, "refusing to modify"):
                self.toolchain.setup_comfy("cpu")
            run.assert_not_called()
        self.assertEqual(marker.read_text(), "untouched")

    def test_reject_symlinked_installation(self):
        target = self.root / "outside"
        target.mkdir()
        (self.root / ".artifacts").symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(setup.SetupError, "symlinked"):
            self.toolchain.comfy_status()
        self.assertEqual(list(target.iterdir()), [])

    def test_identical_verified_installation_is_noop(self):
        # Intent kept from before #220: an intact, correct CPU install (now including the
        # pinned +cpu torch record) is a strict no-op on re-run.
        fake = FakeHost(self.toolchain, runtime_packages={"torch": TORCH, "torchvision": TORCHVISION, "numpy": "2.3.0"})
        fake.materialize_install(torch=torch_record())
        before = self.toolchain.receipt.read_bytes()
        with host(), patch.object(setup, "run", side_effect=fake):
            self.toolchain.setup_comfy("cpu")
        self.assertTrue(fake.calls)
        self.assertEqual(fake.mutating_calls(), [])
        self.assertEqual(self.toolchain.receipt.read_bytes(), before)

    def test_backend_drift_refuses_changes(self):
        self.toolchain.receipt.parent.mkdir(parents=True)
        self.toolchain.receipt.write_text('{"schemaVersion":1,"gpu":"cpu"}')
        with patch.object(setup, "run") as invoked:
            with self.assertRaisesRegex(setup.SetupError, "refusing to modify"):
                self.toolchain.setup_comfy("nvidia")
            invoked.assert_not_called()


class CpuTorchPinTests(unittest.TestCase):
    """`comfyui.cpuTorch` is required and validated by pins()."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def assert_rejected(self, mutate, drop=False):
        data = cpu_torch_fixture()
        mutate(data)
        write_fixture(self.root, cpu_torch=data, drop_cpu_torch=drop)
        with self.assertRaises(setup.SetupError):
            setup.pins(self.root)
        self.assertFalse((self.root / ".artifacts").exists())

    def test_valid_cpu_torch_pins_are_accepted(self):
        write_fixture(self.root)
        self.assertEqual(setup.pins(self.root)["comfyui"]["cpuTorch"]["packages"]["torch"], TORCH)

    def test_repository_manifest_pins_cpu_wheels_for_linux_x86_64_cp310_to_cp315(self):
        manifest = setup.pins(setup.ROOT)
        cpu = manifest["comfyui"]["cpuTorch"]
        self.assertEqual(cpu["indexUrl"], CPU_INDEX)
        self.assertEqual(set(cpu["packages"]), {"torch", "torchvision"})
        for version in cpu["packages"].values():
            self.assertTrue(version.endswith("+cpu"), version)
        self.assertEqual(set(cpu["wheels"]), {f"linux-x86_64-cp3{minor}" for minor in range(10, 16)})

    def test_missing_cpu_torch_is_rejected(self):
        self.assert_rejected(lambda data: None, drop=True)

    def test_malformed_cpu_torch_is_rejected(self):
        def bad_url_scheme(data):
            data["wheels"][PINNED_KEY][0]["url"] = data["wheels"][PINNED_KEY][0]["url"].replace("https://", "http://")

        def url_outside_index(data):
            data["wheels"][PINNED_KEY][0]["url"] = "https://pypi.org/packages/torch-2.14.1-cp314-cp314-manylinux_2_28_x86_64.whl"

        def uppercase_hash(data):
            data["wheels"][PINNED_KEY][0]["sha256"] = data["wheels"][PINNED_KEY][0]["sha256"].upper()

        def short_hash(data):
            data["wheels"][PINNED_KEY][0]["sha256"] = "ab" * 16

        def missing_torchvision(data):
            data["wheels"][PINNED_KEY] = data["wheels"][PINNED_KEY][:1]

        def extra_package(data):
            data["wheels"][PINNED_KEY].append({"name": "torchaudio", "url": f"{CPU_INDEX}/torchaudio.whl", "sha256": fake_sha("a")})

        def duplicate_torch(data):
            data["wheels"][PINNED_KEY][1] = copy.deepcopy(data["wheels"][PINNED_KEY][0])

        def cuda_version(data):
            data["packages"]["torch"] = CUDA_TORCH

        def plain_version(data):
            data["packages"]["torchvision"] = "0.29.1"

        def foreign_platform_key(data):
            data["wheels"]["linux-aarch64-cp314"] = copy.deepcopy(data["wheels"][PINNED_KEY])

        def darwin_key(data):
            data["wheels"]["darwin-arm64-cp314"] = copy.deepcopy(data["wheels"][PINNED_KEY])

        def no_wheels(data):
            data["wheels"] = []

        for mutate in (bad_url_scheme, url_outside_index, uppercase_hash, short_hash, missing_torchvision,
                       extra_package, duplicate_torch, cuda_version, plain_version, foreign_platform_key,
                       darwin_key, no_wheels):
            with self.subTest(mutate.__name__):
                self.assert_rejected(mutate)

    def test_platform_key_reflects_current_host(self):
        cases = [
            (("linux", "x86_64", (3, 14)), "linux-x86_64-cp314"),
            (("linux", "AMD64", (3, 10)), "linux-x86_64-cp310"),
            (("linux", "aarch64", (3, 12)), "linux-aarch64-cp312"),
            (("darwin", "arm64", (3, 13)), "darwin-arm64-cp313"),
            (("win32", "AMD64", (3, 15)), "win32-x86_64-cp315"),
        ]
        for arguments, expected in cases:
            with self.subTest(expected), host(*arguments):
                self.assertEqual(setup.cpu_torch_platform_key(), expected)


class CpuTorchSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        write_fixture(self.root)
        self.tc = setup.Toolchain(self.root)

    def receipt(self) -> dict:
        return json.loads(self.tc.receipt.read_text(encoding="utf8"))

    # Fail closed on unsupported platforms -----------------------------------------------
    def test_unpinned_platform_fails_closed_before_any_state_or_command(self):
        cases = [
            ("darwin", "arm64", (3, 14), "darwin-arm64-cp314"),
            ("win32", "AMD64", (3, 14), "win32-x86_64-cp314"),
            ("linux", "aarch64", (3, 14), "linux-aarch64-cp314"),
            ("linux", "x86_64", (3, 16), "linux-x86_64-cp316"),
        ]
        for system, machine, version, key in cases:
            with self.subTest(key), host(system, machine, version), patch.object(setup, "run") as run:
                with self.assertRaisesRegex(setup.SetupError, key):
                    self.tc.setup_comfy("cpu")
                run.assert_not_called()
                self.assertFalse((self.root / ".artifacts").exists())

    # Fresh install --------------------------------------------------------------------
    def fresh_install(self, workspace_venv=True):
        fake = FakeHost(self.tc, workspace_venv=workspace_venv)
        with host(), patch.object(setup, "run", side_effect=fake):
            self.tc.setup_comfy("cpu")
        return fake

    def test_fresh_cpu_install_uses_source_only_comfy_install_then_hash_pinned_cpu_wheels(self):
        fake = self.fresh_install()
        comfy = [call for call in fake.calls if call[0] == str(self.tc.binary("comfy"))]
        self.assertEqual(len(comfy), 1)
        command = comfy[0]
        install = command.index("install")
        self.assertEqual(command[install:install + 9],
                         ["install", "--url", setup.COMFY_SOURCE, "--version", "nightly", "--commit", COMMIT,
                          "--skip-manager", "--cpu"])
        for flag in ("--skip-torch-or-directml", "--skip-requirement"):
            self.assertIn(flag, command)
        self.assertNotIn("--fast-deps", command)
        self.assertNotIn("--nvidia", command)

        runtime = fake.workspace_python()
        comfy_at = fake.index(lambda c: c[0] == str(self.tc.binary("comfy")))
        hashed_at = fake.index(lambda c: c[0] == runtime and "install" in c and "--require-hashes" in c)
        hashed = fake.calls[hashed_at]
        self.assertEqual(hashed[1:3], ["-m", "pip"])
        self.assertIn("--no-deps", hashed)
        self.assertEqual(len(fake.requirement_files), 1)
        python, content = fake.requirement_files[0]
        self.assertEqual(python, runtime)
        lines = sorted(line.strip() for line in content.splitlines() if line.strip() and not line.strip().startswith("#"))
        self.assertEqual(lines, expected_requirement_lines(PINNED_KEY))

        requirements = str(self.tc.comfy_repo / "requirements.txt")
        requirements_at = fake.index(lambda c: c[0] == runtime and "install" in c and "-r" in c
                                     and c[c.index("-r") + 1] == requirements)
        self.assertNotIn("--require-hashes", fake.calls[requirements_at])
        probe_at = fake.index(lambda c: c[0] == runtime and is_torch_probe(c))
        self.assertLess(comfy_at, hashed_at)
        self.assertLess(hashed_at, requirements_at)
        # pip check must run after requirements were installed; the probe follows the install steps.
        self.assertTrue(any(i > requirements_at for i, c in enumerate(fake.calls)
                            if c[0] == runtime and c[1:4] == ["-m", "pip", "check"]), "pip check after requirements")
        self.assertLess(requirements_at, probe_at)

    def test_fresh_cpu_install_pins_wheels_for_the_detected_python(self):
        fake = FakeHost(self.tc)
        with host("linux", "x86_64", (3, 11)), patch.object(setup, "run", side_effect=fake):
            self.tc.setup_comfy("cpu")
        lines = sorted(line.strip() for line in fake.requirement_files[0][1].splitlines()
                       if line.strip() and not line.strip().startswith("#"))
        self.assertEqual(lines, expected_requirement_lines("linux-x86_64-cp311"))

    def test_fresh_cpu_install_without_workspace_venv_installs_into_cli_python(self):
        fake = self.fresh_install(workspace_venv=False)
        self.assertEqual(fake.requirement_files[0][0], fake.cli_python())
        self.assertEqual(self.receipt()["runtimeEnvironment"], "cli")
        self.assertEqual(self.receipt()["torch"], torch_record())

    def test_fresh_cpu_install_writes_truthful_torch_receipt(self):
        fake = self.fresh_install()
        state = self.receipt()
        self.assertEqual(state["schemaVersion"], 1)
        self.assertEqual(state["gpu"], "cpu")
        self.assertEqual(state["torch"], torch_record())
        self.assertEqual(state["runtimeEnvironmentSha256"], fake_sha(fake.freeze_text(fake.runtime)))
        self.assertEqual(state["cliEnvironmentSha256"], fake_sha(fake.freeze_text(fake.cli)))
        self.assertFalse(any(name.startswith("nvidia-") or name == "triton" for name in fake.runtime))
        with host(), patch.object(setup, "run", side_effect=fake):
            ready, message = self.tc.comfy_status("cpu")
        self.assertTrue(ready, message)
        self.assertIn(TORCH, message)

    def test_probe_reporting_cuda_torch_fails_without_receipt(self):
        for probe in ({"version": CUDA_TORCH, "cuda": "13.0"},
                      {"version": TORCH, "cuda": "13.0"},
                      {"version": "2.13.0+cpu", "cuda": None}):
            with self.subTest(probe=probe):
                root = Path(tempfile.mkdtemp(dir=self.temp.name))
                write_fixture(root)
                tc = setup.Toolchain(root)
                fake = FakeHost(tc)
                fake.probe_override = probe
                with host(), patch.object(setup, "run", side_effect=fake):
                    with self.assertRaises(setup.SetupError):
                        tc.setup_comfy("cpu")
                self.assertTrue(any(is_torch_probe(call) for call in fake.calls), "torch probe was not run")
                self.assertFalse(tc.receipt.exists())

    # Convergence ----------------------------------------------------------------------
    def cuda_runtime(self) -> dict:
        return {"torch": CUDA_TORCH, "torchvision": "0.29.1", "numpy": "2.3.0", **CUDA_ONLY}

    def assert_converged(self, fake: FakeHost, old_state: dict, key: str = PINNED_KEY):
        tc = self.tc
        self.assertFalse([c for c in fake.calls if c[0] == str(tc.binary("comfy"))], "comfy install was re-run")
        self.assertFalse([c for c in fake.calls if "venv" in c[1:3]])
        self.assertEqual(fake.uninstalled(), set(CUDA_ONLY))
        runtime = fake.runtime_python()
        for call in fake.calls:
            if "uninstall" in call:
                self.assertEqual(call[0], runtime)
                self.assertIn("-y", call)
        hashed_at = fake.index(lambda c: c[0] == runtime and "install" in c and "--require-hashes" in c)
        self.assertIn("--no-deps", fake.calls[hashed_at])
        lines = sorted(line.strip() for line in fake.requirement_files[0][1].splitlines()
                       if line.strip() and not line.strip().startswith("#"))
        self.assertEqual(lines, expected_requirement_lines(key))
        self.assertTrue(any(i > hashed_at for i, c in enumerate(fake.calls)
                            if c[0] == runtime and c[1:4] == ["-m", "pip", "check"]), "pip check after wheels")
        self.assertTrue(any(i > hashed_at for i, c in enumerate(fake.calls) if c[0] == runtime and is_torch_probe(c)),
                        "torch probe after wheels")
        self.assertEqual(fake.runtime["torch"], TORCH)
        self.assertFalse(any(name.startswith("nvidia-") or name == "triton" for name in fake.runtime))
        self.assertEqual(fake.runtime["numpy"], "2.3.0")
        state = self.receipt()
        self.assertEqual(state["torch"], torch_record(key))
        self.assertEqual(state["schemaVersion"], 1)
        for key in ("commit", "cli", "mcp", "gpu", "runtimeEnvironment"):
            self.assertEqual(state[key], old_state[key], key)
        self.assertEqual(state["runtimeEnvironmentSha256"], fake_sha(fake.freeze_text(fake.runtime)))
        self.assertEqual(state["cliEnvironmentSha256"], fake_sha(fake.freeze_text(fake.cli)))
        self.assertEqual((tc.comfy_repo / "main.py").read_text(), "# pinned source\n")
        self.assertEqual((tc.comfy_repo / "requirements.txt").read_text(), "numpy\n")
        # A second run against the converged install does nothing.
        fake.calls.clear()
        with host(), patch.object(setup, "run", side_effect=fake):
            self.tc.setup_comfy("cpu")
        self.assertEqual(fake.mutating_calls(), [])

    def test_old_cpu_receipt_without_torch_record_converges(self):
        fake = FakeHost(self.tc, runtime_packages=self.cuda_runtime())
        old = fake.materialize_install(omit_torch=True)
        with host(), patch.object(setup, "run", side_effect=fake):
            self.tc.setup_comfy("cpu")
        self.assert_converged(fake, old)

    def test_cpu_receipt_recording_cuda_torch_converges(self):
        fake = FakeHost(self.tc, runtime_packages=self.cuda_runtime())
        old = fake.materialize_install(torch={"version": CUDA_TORCH, "cuda": "13.0", "wheels": []})
        with host(), patch.object(setup, "run", side_effect=fake):
            self.tc.setup_comfy("cpu")
        self.assert_converged(fake, old)

    def test_cli_runtime_cpu_receipt_without_torch_converges(self):
        fake = FakeHost(self.tc, runtime_packages=self.cuda_runtime(), workspace_venv=False)
        old = fake.materialize_install(omit_torch=True)
        with host(), patch.object(setup, "run", side_effect=fake):
            self.tc.setup_comfy("cpu")
        self.assert_converged(fake, old)

    def test_convergence_does_not_bypass_other_drift(self):
        cases = {
            "revision": dict(commit="b" * 40),
            "origin": dict(origin="https://example.invalid/ComfyUI.git"),
        }
        for label, overrides in cases.items():
            with self.subTest(label):
                root = Path(tempfile.mkdtemp(dir=self.temp.name))
                write_fixture(root)
                tc = setup.Toolchain(root)
                fake = FakeHost(tc, runtime_packages=self.cuda_runtime(), **overrides)
                fake.materialize_install(omit_torch=True)
                before = tc.receipt.read_bytes()
                with host(), patch.object(setup, "run", side_effect=fake):
                    with self.assertRaises(setup.SetupError):
                        tc.setup_comfy("cpu")
                self.assertEqual(fake.mutating_calls(), [])
                self.assertEqual(tc.receipt.read_bytes(), before)

    def test_unrelated_runtime_drift_with_correct_torch_record_fails_closed(self):
        fake = FakeHost(self.tc, runtime_packages={"torch": TORCH, "torchvision": TORCHVISION, "numpy": "2.3.0"})
        fake.materialize_install(torch=torch_record(), runtime_sha=fake_sha("something else"))
        before = self.tc.receipt.read_bytes()
        with host(), patch.object(setup, "run", side_effect=fake):
            with self.assertRaisesRegex(setup.SetupError, "runtime dependencies changed"):
                self.tc.setup_comfy("cpu")
        self.assertEqual(fake.mutating_calls(), [])
        self.assertEqual(self.tc.receipt.read_bytes(), before)

    def test_backend_switches_fail_closed(self):
        for existing, requested in (("cpu", "nvidia"), ("nvidia", "cpu")):
            with self.subTest(f"{existing}->{requested}"):
                root = Path(tempfile.mkdtemp(dir=self.temp.name))
                write_fixture(root)
                tc = setup.Toolchain(root)
                packages = {"torch": TORCH, "torchvision": TORCHVISION} if existing == "cpu" else self.cuda_runtime()
                fake = FakeHost(tc, runtime_packages=packages)
                fake.materialize_install(gpu=existing, torch=torch_record() if existing == "cpu" else None)
                before = tc.receipt.read_bytes()
                with host(), patch.object(setup, "run", side_effect=fake):
                    with self.assertRaisesRegex(setup.SetupError, "differs from requested"):
                        tc.setup_comfy(requested)
                self.assertEqual(fake.mutating_calls(), [])
                self.assertEqual(tc.receipt.read_bytes(), before)

    # Doctor ---------------------------------------------------------------------------
    def test_doctor_reports_unpinned_cpu_torch_without_mutating(self):
        records = {
            "missing": None,
            "cuda build": {"version": CUDA_TORCH, "cuda": "13.0", "wheels": []},
            "cuda reported": {**torch_record(), "cuda": "13.0"},
            "other cpu version": {**torch_record(), "version": "2.13.0+cpu"},
        }
        for label, record in records.items():
            for gpu in ("cpu", None):
                with self.subTest(label, gpu=gpu):
                    root = Path(tempfile.mkdtemp(dir=self.temp.name))
                    write_fixture(root)
                    tc = setup.Toolchain(root)
                    fake = FakeHost(tc, runtime_packages=self.cuda_runtime())
                    fake.materialize_install(torch=record, omit_torch=record is None)
                    before = tc.receipt.read_bytes()
                    with host(), patch.object(setup, "run", side_effect=fake):
                        ready, message = tc.comfy_status(gpu)
                    self.assertFalse(ready)
                    self.assertIn(TORCH, message)
                    self.assertIn("setup", message.lower())
                    self.assertEqual(fake.mutating_calls(), [])
                    self.assertEqual(tc.receipt.read_bytes(), before)

    def test_doctor_ready_message_names_cpu_torch(self):
        fake = FakeHost(self.tc, runtime_packages={"torch": TORCH, "torchvision": TORCHVISION})
        fake.materialize_install(torch=torch_record())
        with host(), patch.object(setup, "run", side_effect=fake):
            ready, message = self.tc.comfy_status("cpu")
        self.assertTrue(ready, message)
        self.assertIn(TORCH, message)
        self.assertEqual(fake.mutating_calls(), [])

    # Managed runtime ownership (#239 P1) ---------------------------------------------
    def runtime_mutations(self, fake: FakeHost) -> list[list[str]]:
        runtime = fake.runtime_python()
        return [c for c in fake.calls if c[0] == runtime and "pip" in c and ("install" in c or "uninstall" in c)]

    def relink_outside(self, root: Path, path: Path) -> Path:
        """Move a managed directory outside managed storage and leave a symlink in its place."""
        outside = root / "user-owned" / path.name
        outside.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(path), str(outside))
        path.symlink_to(outside, target_is_directory=True)
        return outside

    def symlinked_runtime_cases(self):
        return {
            "workspace .venv": lambda tc: tc.comfy_repo / ".venv",
            "ComfyUI checkout": lambda tc: tc.comfy_repo,
            "comfy-workspace": lambda tc: tc.workspace,
        }

    def test_symlinked_runtime_is_never_converged(self):
        for label, target in self.symlinked_runtime_cases().items():
            with self.subTest(label):
                root = Path(tempfile.mkdtemp(dir=self.temp.name))
                write_fixture(root)
                tc = setup.Toolchain(root)
                fake = FakeHost(tc, runtime_packages=self.cuda_runtime())
                fake.materialize_install(omit_torch=True)
                self.relink_outside(root, target(tc))
                before = tc.receipt.read_bytes()
                packages = dict(fake.runtime)
                with host(), patch.object(setup, "run", side_effect=fake):
                    with self.assertRaisesRegex(setup.SetupError, "(?i)symlink|managed"):
                        tc.setup_comfy("cpu")
                self.assertEqual(fake.mutating_calls(), [])
                self.assertEqual(fake.uninstalled(), set())
                self.assertEqual(fake.runtime, packages)
                self.assertEqual(tc.receipt.read_bytes(), before)

    def test_symlinked_runtime_of_otherwise_ready_install_is_not_ready(self):
        for label, target in self.symlinked_runtime_cases().items():
            with self.subTest(label):
                root = Path(tempfile.mkdtemp(dir=self.temp.name))
                write_fixture(root)
                tc = setup.Toolchain(root)
                fake = FakeHost(tc, runtime_packages={"torch": TORCH, "torchvision": TORCHVISION, "numpy": "2.3.0"})
                fake.materialize_install(torch=torch_record())
                self.relink_outside(root, target(tc))
                before = tc.receipt.read_bytes()
                with host(), patch.object(setup, "run", side_effect=fake):
                    for gpu in ("cpu", None):
                        try:
                            ready, message = tc.comfy_status(gpu)
                        except setup.SetupError as exc:
                            ready, message = False, str(exc)
                        self.assertFalse(ready, f"doctor reported a symlinked runtime ready: {message}")
                        self.assertRegex(message, "(?i)symlink|managed")
                    with self.assertRaisesRegex(setup.SetupError, "(?i)symlink|managed"):
                        tc.setup_comfy("cpu")
                self.assertEqual(fake.mutating_calls(), [])
                self.assertEqual(tc.receipt.read_bytes(), before)

    def test_fresh_install_refuses_symlinked_workspace_venv(self):
        fake = FakeHost(self.tc)
        fake.venv_link_target = self.root / "user-owned" / "venv"
        with host(), patch.object(setup, "run", side_effect=fake):
            with self.assertRaisesRegex(setup.SetupError, "(?i)symlink|managed"):
                self.tc.setup_comfy("cpu")
        self.assertEqual(self.runtime_mutations(fake), [])
        self.assertEqual(fake.requirement_files, [])
        self.assertFalse(self.tc.receipt.exists())

    def test_runtime_python_binary_symlinked_to_system_interpreter_is_allowed(self):
        # Real venvs link bin/python to the base interpreter; only the venv directory and
        # its parents must be managed, real directories.
        fake = FakeHost(self.tc, runtime_packages=self.cuda_runtime())
        fake.python_link_target = self.root / "system" / "python3.14"
        old = fake.materialize_install(omit_torch=True)
        self.assertTrue(Path(fake.workspace_python()).is_symlink())
        with host(), patch.object(setup, "run", side_effect=fake):
            self.tc.setup_comfy("cpu")
        self.assert_converged(fake, old)

        root = Path(tempfile.mkdtemp(dir=self.temp.name))
        write_fixture(root)
        tc = setup.Toolchain(root)
        fresh = FakeHost(tc)
        fresh.python_link_target = root / "system" / "python3.14"
        with host(), patch.object(setup, "run", side_effect=fresh):
            tc.setup_comfy("cpu")
        self.assertTrue(Path(fresh.workspace_python()).is_symlink())
        self.assertEqual(json.loads(tc.receipt.read_text(encoding="utf8"))["torch"], torch_record())

    # Runtime ABI selects the wheel set (#239 P1) --------------------------------------
    def assert_env_probe_before_mutation(self, fake: FakeHost):
        runtime = fake.runtime_python()
        probe_at = fake.index(lambda c: c[0] == runtime and is_env_probe(c))
        mutations = [i for i, c in enumerate(fake.calls) if c in self.runtime_mutations(fake)]
        self.assertTrue(mutations)
        self.assertLess(probe_at, min(mutations))

    def test_fresh_install_selects_wheels_from_runtime_abi_not_caller(self):
        fake = FakeHost(self.tc)
        fake.interpreter_keys[fake.workspace_python()] = "linux-x86_64-cp313"
        with host("linux", "x86_64", (3, 14)), patch.object(setup, "run", side_effect=fake):
            self.tc.setup_comfy("cpu")
        lines = sorted(line.strip() for line in fake.requirement_files[0][1].splitlines()
                       if line.strip() and not line.strip().startswith("#"))
        self.assertEqual(lines, expected_requirement_lines("linux-x86_64-cp313"))
        self.assert_env_probe_before_mutation(fake)
        self.assertEqual(self.receipt()["torch"], torch_record("linux-x86_64-cp313"))
        with host(), patch.object(setup, "run", side_effect=fake):
            ready, message = self.tc.comfy_status("cpu")
        self.assertTrue(ready, message)

    def test_convergence_selects_wheels_from_runtime_abi_not_caller(self):
        for workspace_venv in (True, False):
            with self.subTest(workspace_venv=workspace_venv):
                root = Path(tempfile.mkdtemp(dir=self.temp.name))
                write_fixture(root)
                self.tc = setup.Toolchain(root)
                fake = FakeHost(self.tc, runtime_packages=self.cuda_runtime(), workspace_venv=workspace_venv)
                fake.interpreter_keys[fake.runtime_python()] = "linux-x86_64-cp313"
                old = fake.materialize_install(omit_torch=True)
                with host("linux", "x86_64", (3, 14)), patch.object(setup, "run", side_effect=fake):
                    self.tc.setup_comfy("cpu")
                lines = sorted(line.strip() for line in fake.requirement_files[0][1].splitlines()
                               if line.strip() and not line.strip().startswith("#"))
                self.assertEqual(lines, expected_requirement_lines("linux-x86_64-cp313"))
                self.assert_env_probe_before_mutation(fake)
                self.assert_converged(fake, old, key="linux-x86_64-cp313")

    def test_unpinned_runtime_abi_fails_before_uninstall_and_keeps_install(self):
        unpinned = "linux-x86_64-cp316"
        fake = FakeHost(self.tc, runtime_packages=self.cuda_runtime())
        fake.interpreter_keys[fake.workspace_python()] = unpinned
        fake.materialize_install(omit_torch=True)
        before = self.tc.receipt.read_bytes()
        packages = dict(fake.runtime)
        with host("linux", "x86_64", (3, 14)), patch.object(setup, "run", side_effect=fake):
            with self.assertRaisesRegex(setup.SetupError, unpinned):
                self.tc.setup_comfy("cpu")
        self.assertTrue(any(c[0] == fake.workspace_python() and is_env_probe(c) for c in fake.calls),
                        "runtime ABI probe was not run")
        self.assertEqual(fake.mutating_calls(), [])
        self.assertEqual(fake.runtime, packages)
        self.assertEqual(self.tc.receipt.read_bytes(), before)

    def test_fresh_install_with_unpinned_runtime_abi_writes_no_receipt(self):
        unpinned = "linux-x86_64-cp316"
        fake = FakeHost(self.tc)
        fake.interpreter_keys[fake.workspace_python()] = unpinned
        with host("linux", "x86_64", (3, 14)), patch.object(setup, "run", side_effect=fake):
            with self.assertRaisesRegex(setup.SetupError, unpinned):
                self.tc.setup_comfy("cpu")
        self.assertEqual(self.runtime_mutations(fake), [])
        self.assertEqual(fake.requirement_files, [])
        self.assertFalse(self.tc.receipt.exists())

    # Removal set is torch's declared CUDA requirements (#239 P2) ------------------------
    def test_convergence_keeps_nvidia_packages_torch_does_not_require(self):
        unrelated = {"nvidia-ml-py": "13.580.0", "nvidia-pyindex": "1.0.9"}
        fake = FakeHost(self.tc, runtime_packages={**self.cuda_runtime(), **unrelated})
        fake.materialize_install(omit_torch=True)
        with host(), patch.object(setup, "run", side_effect=fake):
            self.tc.setup_comfy("cpu")
        self.assertEqual(fake.uninstalled(), set(CUDA_ONLY))
        for name, version in unrelated.items():
            self.assertEqual(fake.runtime.get(name), version, name)
        self.assertFalse(any(name in fake.runtime for name in CUDA_ONLY))
        self.assertEqual(fake.runtime["torch"], TORCH)
        self.assertEqual(self.receipt()["torch"], torch_record())
        self.assertEqual(self.receipt()["runtimeEnvironmentSha256"], fake_sha(fake.freeze_text(fake.runtime)))

    def test_convergence_removes_only_declared_requirements_that_are_installed(self):
        # Torch declares one requirement that is absent; only installed ones are removed.
        fake = FakeHost(self.tc, runtime_packages={**self.cuda_runtime(), "nvidia-ml-py": "13.580.0"})
        fake.cuda_torch_requires = [*CUDA_ONLY, "nvidia-cusparselt-cu13"]
        fake.materialize_install(omit_torch=True)
        with host(), patch.object(setup, "run", side_effect=fake):
            self.tc.setup_comfy("cpu")
        self.assertEqual(fake.uninstalled(), set(CUDA_ONLY))
        self.assertIn("nvidia-ml-py", fake.runtime)

    def test_convergence_without_installed_torch_cuda_requirements_runs_no_uninstall(self):
        fake = FakeHost(self.tc, runtime_packages={"torch": CUDA_TORCH, "torchvision": "0.29.1", "numpy": "2.3.0",
                                                   "nvidia-ml-py": "13.580.0", "nvidia-pyindex": "1.0.9"})
        fake.materialize_install(omit_torch=True)
        with host(), patch.object(setup, "run", side_effect=fake):
            self.tc.setup_comfy("cpu")
        self.assertFalse([c for c in fake.calls if "uninstall" in c])
        self.assertEqual(fake.runtime["nvidia-ml-py"], "13.580.0")
        self.assertEqual(fake.runtime["nvidia-pyindex"], "1.0.9")
        self.assertEqual(fake.runtime["torch"], TORCH)

    # NVIDIA unchanged -----------------------------------------------------------------
    def test_nvidia_setup_is_unchanged_and_not_gated_by_cpu_torch(self):
        for arguments in (("linux", "x86_64", (3, 14)), ("linux", "x86_64", (3, 16)), ("darwin", "arm64", (3, 14))):
            with self.subTest(arguments):
                root = Path(tempfile.mkdtemp(dir=self.temp.name))
                write_fixture(root)
                tc = setup.Toolchain(root)
                fake = FakeHost(tc)
                with host(*arguments), patch.object(setup, "run", side_effect=fake):
                    tc.setup_comfy("nvidia")
                comfy = [call for call in fake.calls if call[0] == str(tc.binary("comfy"))]
                self.assertEqual(len(comfy), 1)
                command = comfy[0]
                install = command.index("install")
                self.assertEqual(command[install:],
                                 ["install", "--url", setup.COMFY_SOURCE, "--version", "nightly", "--commit", COMMIT,
                                  "--skip-manager", "--nvidia", "--fast-deps"])
                self.assertEqual(fake.requirement_files, [])
                self.assertFalse([c for c in fake.calls if "--require-hashes" in c or "uninstall" in c or is_torch_probe(c)])
                state = json.loads(tc.receipt.read_text(encoding="utf8"))
                self.assertEqual(state["gpu"], "nvidia")
                self.assertNotIn("torch", state)
                with host(*arguments), patch.object(setup, "run", side_effect=fake):
                    ready, message = tc.comfy_status("nvidia")
                self.assertTrue(ready, message)


if __name__ == "__main__":
    unittest.main()
