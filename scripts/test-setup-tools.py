"""Local setup safety regressions: no network, no GPU, no model downloads."""

import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().with_name("setup-tools.py")
spec = importlib.util.spec_from_file_location("asset_setup_tools", SOURCE)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class LocalToolSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        scripts = self.root / "scripts"
        scripts.mkdir()
        (self.root / "package.json").write_text(json.dumps({"engines": {"bun": "1.4.3"}, "packageManager": "bun@1.4.3"}))
        (scripts / "toolchain.json").write_text(json.dumps({
            "schemaVersion": 1,
            "comfyui": {
                "commit": "a" * 40, "comfy-cli": "1.22.0", "comfy-mcp": "0.10.0",
            },
        }), encoding="utf8")
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
        with patch.object(setup, "run") as run:
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
        tc = self.toolchain
        tc.comfy_repo.mkdir(parents=True)
        tc.env.joinpath("bin").mkdir(parents=True)
        for binary in (tc.binary("comfy"), tc.binary("python")):
            binary.touch()
        digest = hashlib.sha256(b"package==1").hexdigest()
        tc.receipt.write_text(json.dumps({
            "schemaVersion": 1, "commit": "a" * 40, "cli": "1.22.0", "mcp": "0.10.0", "gpu": "cpu",
            "runtimeEnvironment": "cli", "cliEnvironmentSha256": digest,
            "runtimeEnvironmentSha256": digest,
        }))

        def fake_run(*args, **kwargs):
            line = " ".join(args)
            if "rev-parse" in line:
                return "a" * 40
            if "get-url origin" in line:
                return setup.COMFY_SOURCE
            if "freeze" in line:
                return "package==1"
            if "pip show comfy-cli" in line:
                return "Name: comfy-cli\nVersion: 1.22.0"
            if "pip show comfy-mcp" in line:
                return "Name: comfy-mcp\nVersion: 0.10.0"
            if "pip check" in line:
                return "No broken requirements"
            raise AssertionError(f"unexpected external invocation: {line}")

        with patch.object(setup, "run", side_effect=fake_run) as invoked:
            tc.setup_comfy("cpu")
            self.assertTrue(invoked.called)
            for call in invoked.call_args_list:
                self.assertNotIn("install", " ".join(call.args))

    def test_backend_drift_refuses_changes(self):
        self.toolchain.receipt.parent.mkdir(parents=True)
        self.toolchain.receipt.write_text('{"schemaVersion":1,"gpu":"cpu"}')
        with patch.object(setup, "run") as invoked:
            with self.assertRaisesRegex(setup.SetupError, "refusing to modify"):
                self.toolchain.setup_comfy("nvidia")
            invoked.assert_not_called()


if __name__ == "__main__":
    unittest.main()
