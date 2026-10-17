#!/usr/bin/env python3
"""Acceptance contract for single-file ComfyUI model acquisition (#225).

Every test drives the real CLI (`acquire-file` / `verify-file`) in a subprocess
against a stubbed `huggingface_hub` package that is placed first on PYTHONPATH.
The stub never touches the network: it serves fixture bytes, resolves fixture
revisions and logs every call so tests can prove that exactly one single-file
download happened at the resolved commit and that no snapshot download did.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "acquire-huggingface-model.py"
DOCS = ROOT / "docs" / "model-acquisition.md"

RESOLVED = "0123456789abcdef0123456789abcdef01234567"
OTHER_RESOLVED = "89abcdef0123456789abcdef0123456789abcdef"
STUB_VERSION = "0.0.0+fixture"

STUB_SOURCE = textwrap.dedent(
    '''
    """Offline huggingface_hub stub for asset-tooling acceptance tests."""
    import json
    import os
    import re
    from pathlib import Path
    from types import SimpleNamespace

    __version__ = "%s"
    _HEX40 = re.compile(r"^[0-9a-f]{40}$")


    def _config():
        with open(os.environ["ASSET_TOOLING_HF_STUB_CONFIG"], encoding="utf-8") as handle:
            return json.load(handle)


    def _log(entry):
        with open(os.environ["ASSET_TOOLING_HF_STUB_LOG"], "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, sort_keys=True) + "\\n")


    def _repo(repo_id):
        config = _config()
        if config.get("offline"):
            raise RuntimeError("stub: network access is forbidden in this test")
        repos = config.get("repos", {})
        if repo_id not in repos:
            raise RuntimeError(f"stub: repository not found: {repo_id}")
        return repos[repo_id]


    def _resolve(repo_id, revision):
        repo = _repo(repo_id)
        commit = repo["commit"]
        if revision in (None, commit):
            return commit
        mapped = repo.get("revisions", {}).get(revision)
        if mapped is None:
            raise RuntimeError(f"stub: revision not found: {repo_id}@{revision}")
        return mapped


    def _info(call, repo_id, revision=None, **kwargs):
        _log({"call": call, "repo_id": repo_id, "revision": revision})
        repo = _repo(repo_id)
        sha = _resolve(repo_id, revision)
        license_value = repo.get("license")
        card_data = {"license": license_value} if license_value is not None else None
        tags = [f"license:{license_value}"] if license_value is not None else []
        return SimpleNamespace(id=repo_id, sha=sha, card_data=card_data, cardData=card_data, tags=tags)


    def hf_hub_download(repo_id, filename, *, subfolder=None, revision=None, local_dir=None, cache_dir=None, **kwargs):
        path = f"{subfolder}/{filename}" if subfolder else filename
        _log({"call": "hf_hub_download", "repo_id": repo_id, "filename": path, "revision": revision})
        repo = _repo(repo_id)
        if revision is None or not _HEX40.fullmatch(revision) or revision != repo["commit"]:
            raise RuntimeError(f"stub: single-file download must use the resolved commit, got {revision!r}")
        if path not in repo.get("files", {}):
            raise RuntimeError(f"stub: entry not found: {repo_id}/{path}")
        content = bytes.fromhex(repo["files"][path])
        if local_dir is not None:
            target = Path(local_dir) / path
        else:
            base = Path(cache_dir) if cache_dir is not None else Path(os.environ["ASSET_TOOLING_HF_STUB_CACHE"])
            target = base / repo_id.replace("/", "--") / revision / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        return str(target)


    def snapshot_download(*args, **kwargs):
        _log({"call": "snapshot_download", "repo_id": kwargs.get("repo_id", args[0] if args else None)})
        raise RuntimeError("stub: snapshot download is forbidden for single-file acquisition")


    class HfApi:
        def __init__(self, *args, **kwargs):
            pass

        def model_info(self, repo_id, revision=None, **kwargs):
            return _info("model_info", repo_id, revision, **kwargs)

        def repo_info(self, repo_id, revision=None, **kwargs):
            return _info("repo_info", repo_id, revision, **kwargs)

        def hf_hub_download(self, repo_id, filename, **kwargs):
            return hf_hub_download(repo_id, filename, **kwargs)

        def snapshot_download(self, *args, **kwargs):
            return snapshot_download(*args, **kwargs)


    def model_info(repo_id, revision=None, **kwargs):
        return HfApi().model_info(repo_id, revision=revision, **kwargs)
    '''
    % STUB_VERSION
)


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def sha256_path(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def receipt_path_for(path: Path) -> Path:
    return path.with_name(path.name + ".receipt.json")


class SingleFileAcquisitionTests(unittest.TestCase):
    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory(prefix="asset-tooling-225-")
        self.root = Path(self._temporary.name)
        self.stub_dir = self.root / "stub"
        package = self.stub_dir / "huggingface_hub"
        package.mkdir(parents=True)
        (package / "__init__.py").write_text(STUB_SOURCE, encoding="utf-8")
        dist_info = self.stub_dir / f"huggingface_hub-{STUB_VERSION}.dist-info"
        dist_info.mkdir()
        (dist_info / "METADATA").write_text(
            f"Metadata-Version: 2.1\nName: huggingface_hub\nVersion: {STUB_VERSION}\n", encoding="utf-8"
        )
        self.config_path = self.root / "stub-config.json"
        self.log_path = self.root / "stub-log.jsonl"
        self.cache_dir = self.root / "stub-cache"
        self.models = self.root / "ComfyUI" / "models"
        self.models.mkdir(parents=True)
        self.configure({})

    def tearDown(self):
        self._temporary.cleanup()

    # ── stub plumbing ────────────────────────────────────────────────────────────

    def configure(self, repos: dict, offline: bool = False):
        self.config_path.write_text(json.dumps({"repos": repos, "offline": offline}), encoding="utf-8")

    def calls(self) -> list[dict]:
        if not self.log_path.exists():
            return []
        return [json.loads(line) for line in self.log_path.read_text(encoding="utf-8").splitlines() if line]

    def clear_calls(self):
        if self.log_path.exists():
            self.log_path.unlink()

    def downloads(self) -> list[dict]:
        return [call for call in self.calls() if call["call"] == "hf_hub_download"]

    def snapshot_calls(self) -> list[dict]:
        return [call for call in self.calls() if call["call"] == "snapshot_download"]

    def run_cli(self, *args: str) -> subprocess.CompletedProcess:
        env = dict(os.environ)
        env["PYTHONPATH"] = str(self.stub_dir) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        env["ASSET_TOOLING_HF_STUB_CONFIG"] = str(self.config_path)
        env["ASSET_TOOLING_HF_STUB_LOG"] = str(self.log_path)
        env["ASSET_TOOLING_HF_STUB_CACHE"] = str(self.cache_dir)
        env["HF_HOME"] = str(self.root / "hf-home")
        env.pop("HF_TOKEN", None)
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            cwd=str(self.root),
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )

    def assert_ok(self, result: subprocess.CompletedProcess):
        self.assertEqual(result.returncode, 0, f"stdout={result.stdout!r} stderr={result.stderr!r}")

    def assert_failed(self, result: subprocess.CompletedProcess):
        self.assertNotEqual(result.returncode, 0, f"stdout={result.stdout!r} stderr={result.stderr!r}")

    def files_under(self, directory: Path) -> list[str]:
        if not directory.exists():
            return []
        return sorted(path.relative_to(directory).as_posix() for path in directory.rglob("*") if not path.is_dir())

    # ── fixtures ─────────────────────────────────────────────────────────────────

    def single_repo(self, *, content: bytes, path: str = "split_files/diffusion_models/fixture-model.safetensors",
                    license_value="apache-2.0", served: bytes | None = None, repo_id: str = "example/model"):
        self.configure(
            {
                repo_id: {
                    "commit": RESOLVED,
                    "revisions": {"main": RESOLVED},
                    "license": license_value,
                    "files": {path: (served if served is not None else content).hex()},
                }
            }
        )
        return path

    def acquire_file(self, *, path: str, content: bytes, revision: str = "main", directory: str = "diffusion_models",
                     name: str | None = None, sha256: str | None = None, size: int | None = None,
                     repo_id: str = "example/model"):
        args = [
            "acquire-file",
            "--repo-id", repo_id,
            "--revision", revision,
            "--path", path,
            "--sha256", sha256 if sha256 is not None else sha256_bytes(content),
            "--size", str(size if size is not None else len(content)),
            "--models-dir", str(self.models),
            "--directory", directory,
        ]
        if name is not None:
            args += ["--name", name]
        return self.run_cli(*args)

    # ── acquire-file ─────────────────────────────────────────────────────────────

    def test_acquires_one_file_at_resolved_commit_with_versioned_receipt(self):
        content = b"fixture-diffusion-weights\x00\x01\x02"
        path = self.single_repo(content=content)

        result = self.acquire_file(path=path, content=content, name="renamed-model.safetensors")
        self.assert_ok(result)

        destination = self.models / "diffusion_models" / "renamed-model.safetensors"
        self.assertEqual(destination.read_bytes(), content)
        self.assertEqual(
            self.files_under(self.models),
            ["diffusion_models/renamed-model.safetensors", "diffusion_models/renamed-model.safetensors.receipt.json"],
            "only the model file and its receipt may be left in the models directory",
        )

        self.assertEqual(self.snapshot_calls(), [], "single-file acquisition must not download a snapshot")
        downloads = self.downloads()
        self.assertEqual(len(downloads), 1, f"expected exactly one single-file download, got {downloads}")
        self.assertEqual(downloads[0]["repo_id"], "example/model")
        self.assertEqual(downloads[0]["filename"], path)
        self.assertEqual(downloads[0]["revision"], RESOLVED, "download must use the resolved commit, not the branch")

        receipt = json.loads(receipt_path_for(destination).read_text(encoding="utf-8"))
        self.assertEqual(
            set(receipt),
            {"schemaVersion", "kind", "provider", "repository", "file", "license", "acquirer"},
        )
        self.assertEqual(receipt["schemaVersion"], 1)
        self.assertEqual(receipt["kind"], "huggingface-single-file")
        self.assertEqual(receipt["provider"], "huggingface")
        self.assertEqual(
            receipt["repository"],
            {"id": "example/model", "requestedRevision": "main", "resolvedRevision": RESOLVED},
        )
        self.assertEqual(
            receipt["file"],
            {
                "path": path,
                "name": "renamed-model.safetensors",
                "directory": "diffusion_models",
                "sha256": sha256_bytes(content),
                "byteLength": len(content),
            },
        )
        self.assertEqual(receipt["license"], {"observed": "apache-2.0"})
        acquirer = receipt["acquirer"]
        self.assertEqual(set(acquirer), {"id", "version", "implementationSha256", "huggingfaceHub"})
        self.assertIsInstance(acquirer["id"], str)
        self.assertTrue(acquirer["id"])
        self.assertIsInstance(acquirer["version"], str)
        self.assertTrue(acquirer["version"])
        self.assertEqual(acquirer["implementationSha256"], sha256_path(SCRIPT))
        self.assertIsInstance(acquirer["huggingfaceHub"], str)
        self.assertTrue(acquirer["huggingfaceHub"])
        self.assertNotIn("token", json.dumps(receipt).lower())

    def test_name_defaults_to_basename_of_repository_path(self):
        content = b"fixture-vae"
        path = self.single_repo(content=content, path="split_files/vae/fixture-vae.safetensors")

        self.assert_ok(self.acquire_file(path=path, content=content, directory="vae"))

        destination = self.models / "vae" / "fixture-vae.safetensors"
        self.assertEqual(destination.read_bytes(), content)
        receipt = json.loads(receipt_path_for(destination).read_text(encoding="utf-8"))
        self.assertEqual(receipt["file"]["name"], "fixture-vae.safetensors")
        self.assertEqual(receipt["file"]["directory"], "vae")
        self.assertEqual(receipt["file"]["path"], path)

    def test_commit_revision_is_recorded_as_both_requested_and_resolved(self):
        content = b"pinned-by-commit"
        path = self.single_repo(content=content)

        self.assert_ok(self.acquire_file(path=path, content=content, revision=RESOLVED))

        receipt = json.loads(
            receipt_path_for(self.models / "diffusion_models" / "fixture-model.safetensors").read_text(encoding="utf-8")
        )
        self.assertEqual(receipt["repository"]["requestedRevision"], RESOLVED)
        self.assertEqual(receipt["repository"]["resolvedRevision"], RESOLVED)

    def test_missing_license_is_recorded_as_null_and_never_fails(self):
        content = b"unlicensed-fixture"
        path = self.single_repo(content=content, license_value=None)

        self.assert_ok(self.acquire_file(path=path, content=content))

        receipt = json.loads(
            receipt_path_for(self.models / "diffusion_models" / "fixture-model.safetensors").read_text(encoding="utf-8")
        )
        self.assertEqual(receipt["license"], {"observed": None})

    def test_any_license_value_is_recorded_only(self):
        content = b"other-licensed-fixture"
        path = self.single_repo(content=content, license_value="flux-1-dev-non-commercial-license")

        self.assert_ok(self.acquire_file(path=path, content=content))

        receipt = json.loads(
            receipt_path_for(self.models / "diffusion_models" / "fixture-model.safetensors").read_text(encoding="utf-8")
        )
        self.assertEqual(receipt["license"], {"observed": "flux-1-dev-non-commercial-license"})

    def test_present_matching_file_is_a_no_op(self):
        content = b"idempotent-fixture"
        path = self.single_repo(content=content)
        self.assert_ok(self.acquire_file(path=path, content=content))
        destination = self.models / "diffusion_models" / "fixture-model.safetensors"
        receipt = receipt_path_for(destination)
        before = (destination.read_bytes(), receipt.read_bytes(), destination.stat().st_mtime_ns, receipt.stat().st_mtime_ns)
        self.clear_calls()

        self.assert_ok(self.acquire_file(path=path, content=content))

        self.assertEqual(self.downloads(), [], "a present, matching file must not be downloaded again")
        self.assertEqual(self.snapshot_calls(), [])
        after = (destination.read_bytes(), receipt.read_bytes(), destination.stat().st_mtime_ns, receipt.stat().st_mtime_ns)
        self.assertEqual(after, before, "a no-op must not rewrite the model file or its receipt")

    def test_existing_destination_with_different_bytes_fails_closed_untouched(self):
        content = b"pinned-fixture"
        path = self.single_repo(content=content)
        destination = self.models / "diffusion_models" / "fixture-model.safetensors"
        destination.parent.mkdir(parents=True)
        foreign = b"someone-elses-bytes"
        destination.write_bytes(foreign)

        result = self.acquire_file(path=path, content=content)

        self.assert_failed(result)
        self.assertIn("fixture-model.safetensors", result.stdout + result.stderr)
        self.assertEqual(destination.read_bytes(), foreign, "a conflicting destination must not be modified")
        self.assertFalse(receipt_path_for(destination).exists(), "no receipt may be written for a conflicting file")
        self.assertEqual(self.files_under(self.models), ["diffusion_models/fixture-model.safetensors"])

    def test_downloaded_sha256_mismatch_leaves_nothing_at_destination(self):
        content = b"pinned-fixture"
        path = self.single_repo(content=content, served=b"pinned-fixturX")

        result = self.acquire_file(path=path, content=content)

        self.assert_failed(result)
        self.assertEqual(len(self.downloads()), 1, "the mismatch must be detected on the downloaded bytes")
        self.assertIn("sha256", (result.stdout + result.stderr).lower())
        destination = self.models / "diffusion_models" / "fixture-model.safetensors"
        self.assertFalse(destination.exists(), "mismatching bytes must never be placed")
        self.assertFalse(receipt_path_for(destination).exists())
        self.assertEqual(self.files_under(self.models), [], "no partial or temporary file may remain")

    def test_downloaded_size_mismatch_leaves_nothing_at_destination(self):
        content = b"pinned-fixture"
        path = self.single_repo(content=content)

        result = self.acquire_file(path=path, content=content, size=len(content) + 1)

        self.assert_failed(result)
        output = (result.stdout + result.stderr).lower()
        self.assertTrue("size" in output or "byte" in output, f"error must name the size mismatch: {output!r}")
        destination = self.models / "diffusion_models" / "fixture-model.safetensors"
        self.assertFalse(destination.exists())
        self.assertFalse(receipt_path_for(destination).exists())
        self.assertEqual(self.files_under(self.models), [])

    # ── verify-file ──────────────────────────────────────────────────────────────

    def test_verify_file_is_offline_and_rejects_tampering(self):
        content = b"verify-fixture-bytes"
        path = self.single_repo(content=content)
        self.assert_ok(self.acquire_file(path=path, content=content))
        destination = self.models / "diffusion_models" / "fixture-model.safetensors"

        self.configure({}, offline=True)
        self.clear_calls()
        self.assert_ok(self.run_cli("verify-file", "--file", str(destination)))
        self.assertEqual(self.calls(), [], "verify-file must not contact the provider")

        with destination.open("ab") as handle:
            handle.write(b"tamper")
        self.assert_failed(self.run_cli("verify-file", "--file", str(destination)))

    def test_verify_file_rejects_receipt_drift(self):
        content = b"verify-receipt-fixture"
        path = self.single_repo(content=content)
        self.assert_ok(self.acquire_file(path=path, content=content))
        destination = self.models / "diffusion_models" / "fixture-model.safetensors"
        receipt_file = receipt_path_for(destination)
        receipt = json.loads(receipt_file.read_text(encoding="utf-8"))
        receipt["file"]["sha256"] = "f" * 64
        receipt_file.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")

        self.assert_failed(self.run_cli("verify-file", "--file", str(destination)))

    def test_verify_file_without_receipt_fails(self):
        loose = self.models / "vae" / "loose.safetensors"
        loose.parent.mkdir(parents=True)
        loose.write_bytes(b"no-receipt")

        result = self.run_cli("verify-file", "--file", str(loose))
        self.assert_failed(result)
        self.assertIn("receipt", (result.stdout + result.stderr).lower())

    # ── --profile ────────────────────────────────────────────────────────────────

    def profile_fixture(self):
        diffusion = b"profile-diffusion-bytes"
        encoder = b"profile-text-encoder-bytes"
        vae = b"profile-vae-bytes"
        pins = {
            "diffusionModel": ("fixture-diffusion.safetensors", "diffusion_models", diffusion,
                               "example/diffusion", RESOLVED, "fixture-diffusion.safetensors"),
            "textEncoder": ("fixture-encoder.safetensors", "text_encoders", encoder,
                            "example/shared", OTHER_RESOLVED, "split_files/text_encoders/fixture-encoder.safetensors"),
            "vae": ("fixture-vae.safetensors", "vae", vae,
                    "example/shared", OTHER_RESOLVED, "split_files/vae/fixture-vae.safetensors"),
        }
        repos: dict = {}
        files: dict = {}
        for role, (name, directory, content, repository, revision, path) in pins.items():
            repo = repos.setdefault(repository, {"commit": revision, "license": "apache-2.0", "files": {}})
            repo["files"][path] = content.hex()
            files[role] = {
                "name": name,
                "directory": directory,
                "sha256": sha256_bytes(content),
                "byteLength": len(content),
                "license": "apache-2.0",
                "source": {"provider": "huggingface", "repository": repository, "revision": revision, "path": path},
            }
        self.configure(repos)
        profiles_file = self.root / "profiles.json"
        profiles_file.write_text(json.dumps({"fixture-profile": {"files": files}}), encoding="utf-8")
        return profiles_file, pins

    def acquire_profile(self, profile_id: str, profiles_file: Path):
        return self.run_cli(
            "acquire-file", "--profile", profile_id, "--models-dir", str(self.models), "--profiles-file", str(profiles_file)
        )

    def test_profile_acquires_every_pinned_file_then_is_idempotent(self):
        profiles_file, pins = self.profile_fixture()

        self.assert_ok(self.acquire_profile("fixture-profile", profiles_file))

        self.assertEqual(self.snapshot_calls(), [])
        downloads = sorted((call["repo_id"], call["filename"], call["revision"]) for call in self.downloads())
        expected = sorted((repository, path, revision) for (_, _, _, repository, revision, path) in pins.values())
        self.assertEqual(downloads, expected, "each pinned file is downloaded exactly once at its pinned commit")
        for name, directory, content, repository, revision, path in pins.values():
            destination = self.models / directory / name
            self.assertEqual(destination.read_bytes(), content)
            receipt = json.loads(receipt_path_for(destination).read_text(encoding="utf-8"))
            self.assertEqual(receipt["kind"], "huggingface-single-file")
            self.assertEqual(receipt["repository"]["id"], repository)
            self.assertEqual(receipt["repository"]["resolvedRevision"], revision)
            self.assertEqual(receipt["file"]["path"], path)
            self.assertEqual(receipt["file"]["name"], name)
            self.assertEqual(receipt["file"]["directory"], directory)
            self.assertEqual(receipt["file"]["sha256"], sha256_bytes(content))
            self.assertEqual(receipt["file"]["byteLength"], len(content))
            self.assert_ok(self.run_cli("verify-file", "--file", str(destination)))

        snapshot = {
            path: (self.models / path).read_bytes() for path in self.files_under(self.models)
        }
        self.clear_calls()
        self.assert_ok(self.acquire_profile("fixture-profile", profiles_file))
        self.assertEqual(self.downloads(), [], "a fully present profile must not download anything")
        self.assertEqual(
            {path: (self.models / path).read_bytes() for path in self.files_under(self.models)}, snapshot
        )

    def test_profile_downloads_only_missing_files(self):
        profiles_file, pins = self.profile_fixture()
        self.assert_ok(self.acquire_profile("fixture-profile", profiles_file))
        vae_name, vae_directory, _, vae_repository, vae_revision, vae_path = pins["vae"]
        (self.models / vae_directory / vae_name).unlink()
        receipt_path_for(self.models / vae_directory / vae_name).unlink()
        self.clear_calls()

        self.assert_ok(self.acquire_profile("fixture-profile", profiles_file))

        self.assertEqual(
            [(call["repo_id"], call["filename"], call["revision"]) for call in self.downloads()],
            [(vae_repository, vae_path, vae_revision)],
        )

    def test_unknown_profile_fails_without_downloading(self):
        profiles_file, _ = self.profile_fixture()

        result = self.acquire_profile("no-such-profile", profiles_file)

        self.assert_failed(result)
        self.assertIn("no-such-profile", result.stdout + result.stderr)
        self.assertEqual(self.downloads(), [])
        self.assertEqual(self.snapshot_calls(), [])
        self.assertEqual(self.files_under(self.models), [])

    @unittest.skipUnless(shutil.which("bun"), "bun is required to read the TypeScript image.generate profiles")
    def test_default_profile_source_is_the_typescript_image_generate_profiles(self):
        exported = subprocess.run(
            [
                "bun", "-e",
                'import { IMAGE_GENERATE_MODEL_PROFILES as P } from "./src/image-generate-operation.ts";'
                'console.log(JSON.stringify(P));',
            ],
            cwd=str(ROOT), capture_output=True, text=True, timeout=120, check=True,
        )
        profiles = json.loads(exported.stdout)
        profile_id = sorted(profiles)[0]
        pins = profiles[profile_id]["files"]
        self.assertEqual(set(pins), {"diffusionModel", "textEncoder", "vae"})
        # Serve deliberately wrong (tiny) bytes at every pinned path: acquisition must
        # reach the provider with the TypeScript pins and then fail closed on the hash.
        repos: dict = {}
        for pin in pins.values():
            source = pin["source"]
            repo = repos.setdefault(source["repository"], {"commit": source["revision"], "license": pin["license"], "files": {}})
            repo["files"][source["path"]] = b"not-the-pinned-weights".hex()
        self.configure(repos)
        expected = {
            (pin["source"]["repository"], pin["source"]["path"], pin["source"]["revision"]) for pin in pins.values()
        }

        result = self.run_cli("acquire-file", "--profile", profile_id, "--models-dir", str(self.models))

        self.assert_failed(result)
        repositories = {pin["source"]["repository"] for pin in pins.values()}
        provider_calls = [call for call in self.calls() if call.get("repo_id") in repositories]
        self.assertTrue(provider_calls, "the default profile source must yield the TypeScript pins")
        for call in self.downloads():
            self.assertIn((call["repo_id"], call["filename"], call["revision"]), expected)
        self.assertEqual(self.snapshot_calls(), [])
        for pin in pins.values():
            self.assertFalse((self.models / pin["directory"] / pin["name"]).exists())

    # ── documentation ────────────────────────────────────────────────────────────

    def test_receipt_format_is_documented_and_versioned(self):
        text = DOCS.read_text(encoding="utf-8")
        for needle in ("acquire-file", "verify-file", "--profile", "huggingface-single-file", ".receipt.json", "schemaVersion"):
            self.assertTrue(needle in text, f"docs/model-acquisition.md must document {needle!r}")


if __name__ == "__main__":
    unittest.main()
