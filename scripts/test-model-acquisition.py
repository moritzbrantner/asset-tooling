#!/usr/bin/env python3
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "acquire-huggingface-model.py"
SCHEMA = ROOT / "schemas" / "model-acquisition-receipt-v1.schema.json"

spec = importlib.util.spec_from_file_location("asset_tooling_hf_acquisition", SCRIPT)
if spec is None or spec.loader is None:
    raise RuntimeError("failed to load model acquisition implementation")
acquisition = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acquisition)

RESOLVED = "0123456789abcdef0123456789abcdef01234567"


class ModelAcquisitionTests(unittest.TestCase):
    def make_snapshot(self, root: Path) -> Path:
        snapshot = root / "snapshot"
        (snapshot / "unet").mkdir(parents=True)
        (snapshot / ".cache" / "huggingface").mkdir(parents=True)
        (snapshot / "model_index.json").write_text('{"_class_name":"FixturePipeline"}\n', encoding="utf-8")
        (snapshot / "unet" / "weights.safetensors").write_bytes(b"fixture-weights\x00\x01\x02")
        (snapshot / ".cache" / "huggingface" / "download-metadata.json").write_text(
            '{"ambient":true}\n', encoding="utf-8"
        )
        return snapshot

    def package(self, snapshot: Path, destination: Path):
        return acquisition.package_snapshot(
            snapshot_root=snapshot,
            destination=destination,
            repo_id="example/model",
            requested_revision="release-v1",
            resolved_revision=RESOLVED,
            expected_license="apache-2.0",
            observed_license="apache-2.0",
            hub_client_version="fixture-1",
        )

    def test_deterministic_bundle_and_receipt_validate_and_verify(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            snapshot = self.make_snapshot(root)
            first = root / "first"
            second = root / "second"

            first_receipt = self.package(snapshot, first)
            second_receipt = self.package(snapshot, second)

            self.assertEqual((first / "model.zip").read_bytes(), (second / "model.zip").read_bytes())
            self.assertEqual((first / "receipt.json").read_bytes(), (second / "receipt.json").read_bytes())
            self.assertEqual(first_receipt, second_receipt)
            self.assertEqual(
                [item["path"] for item in first_receipt["files"]],
                ["model_index.json", "unet/weights.safetensors"],
            )

            schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
            Draft202012Validator.check_schema(schema)
            Draft202012Validator(schema).validate(first_receipt)

            result = acquisition.verify_bundle(first / "model.zip", first / "receipt.json")
            self.assertEqual(result["status"], "verified")
            self.assertEqual(result["resolvedRevision"], RESOLVED)
            self.assertEqual(result["fileCount"], 2)

    def test_bundle_tampering_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            snapshot = self.make_snapshot(root)
            destination = root / "output"
            self.package(snapshot, destination)

            with (destination / "model.zip").open("ab") as handle:
                handle.write(b"tamper")

            with self.assertRaisesRegex(ValueError, "bundle bytes do not match receipt"):
                acquisition.verify_bundle(destination / "model.zip", destination / "receipt.json")

    def test_license_mismatch_fails_before_writing_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            snapshot = self.make_snapshot(root)
            destination = root / "output"

            with self.assertRaisesRegex(ValueError, "license mismatch"):
                acquisition.package_snapshot(
                    snapshot_root=snapshot,
                    destination=destination,
                    repo_id="example/model",
                    requested_revision="release-v1",
                    resolved_revision=RESOLVED,
                    expected_license="mit",
                    observed_license="apache-2.0",
                    hub_client_version="fixture-1",
                )
            self.assertFalse(destination.exists())

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks are unavailable")
    def test_snapshot_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            snapshot = self.make_snapshot(root)
            target = snapshot / "model_index.json"
            link = snapshot / "linked-config.json"
            try:
                os.symlink(target, link)
            except OSError as error:
                self.skipTest(f"symlink creation unavailable: {error}")

            with self.assertRaisesRegex(ValueError, "symbolic link"):
                acquisition.collect_snapshot_manifest(snapshot)

    def test_receipt_cross_field_drift_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            snapshot = self.make_snapshot(root)
            destination = root / "output"
            receipt = self.package(snapshot, destination)
            receipt["modelArtifact"]["sha256"] = "f" * 64
            (destination / "receipt.json").write_text(
                json.dumps(receipt, sort_keys=True, indent=2) + "\n", encoding="utf-8"
            )

            with self.assertRaisesRegex(ValueError, "modelArtifact"):
                acquisition.verify_bundle(destination / "model.zip", destination / "receipt.json")


if __name__ == "__main__":
    unittest.main()
