#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

HUGGING_FACE_ENDPOINT = "https://huggingface.co"
IMPLEMENTATION_ID = "asset-tooling.huggingface-snapshot"
IMPLEMENTATION_VERSION = "1"
HEX40 = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
REPO_ID = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
FIXED_ZIP_TIME = (1980, 1, 1, 0, 0, 0)
TOP_LEVEL_KEYS = {
    "schemaVersion",
    "provider",
    "repository",
    "license",
    "acquirer",
    "files",
    "bundle",
    "modelArtifact",
}


def sha256_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    byte_length = 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
            byte_length += len(chunk)
    return digest.hexdigest(), byte_length


def implementation_sha256() -> str:
    return sha256_file(Path(__file__).resolve())[0]


def assert_non_empty_string(value, location: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{location} must be a non-empty string")
    return value


def assert_optional_non_empty_string(value, location: str) -> str | None:
    if value is None:
        return None
    return assert_non_empty_string(value, location)


def assert_portable_path(value: str) -> str:
    if not isinstance(value, str) or not value or "\0" in value:
        raise ValueError(f"unsafe snapshot path: {value!r}")
    if value.startswith("/") or "\\" in value or "//" in value:
        raise ValueError(f"unsafe snapshot path: {value!r}")
    if re.match(r"^[A-Za-z]:", value):
        raise ValueError(f"unsafe snapshot path: {value!r}")
    if any(part in ("", ".", "..") for part in value.split("/")):
        raise ValueError(f"unsafe snapshot path: {value!r}")
    return value


def validate_license(expected_license: str | None, observed_license: str | None) -> None:
    expected = assert_optional_non_empty_string(expected_license, "expected license")
    observed = assert_optional_non_empty_string(observed_license, "observed license")
    if expected is None:
        return
    if observed is None:
        raise ValueError(f"expected license {expected!r}, but model metadata declares no license")
    if observed != expected:
        raise ValueError(f"license mismatch: expected {expected!r}, observed {observed!r}")


def iter_snapshot_files(snapshot_root: Path):
    root = snapshot_root.resolve()
    if not root.is_dir():
        raise ValueError(f"snapshot root is not a directory: {snapshot_root}")

    candidates = sorted(root.rglob("*"), key=lambda path: path.relative_to(root).as_posix())
    for path in candidates:
        relative = path.relative_to(root)
        if len(relative.parts) >= 2 and relative.parts[0] == ".cache" and relative.parts[1] == "huggingface":
            continue
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise ValueError(f"snapshot contains symbolic link: {relative.as_posix()}")
        if stat.S_ISDIR(metadata.st_mode):
            continue
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError(f"snapshot contains non-regular file: {relative.as_posix()}")
        portable = assert_portable_path(relative.as_posix())
        yield portable, path


def collect_snapshot_manifest(snapshot_root: Path) -> list[dict]:
    files = []
    for portable, path in iter_snapshot_files(snapshot_root):
        digest, byte_length = sha256_file(path)
        files.append({"path": portable, "sha256": digest, "byteLength": byte_length})
    if not files:
        raise ValueError("snapshot contains no model files")
    return files


def write_deterministic_zip(snapshot_root: Path, bundle_path: Path, manifest: list[dict]) -> None:
    bundle_path.parent.mkdir(parents=True, exist_ok=True)
    root = snapshot_root.resolve()
    with zipfile.ZipFile(bundle_path, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for item in manifest:
            source = root.joinpath(*PurePosixPath(item["path"]).parts)
            info = zipfile.ZipInfo(item["path"], date_time=FIXED_ZIP_TIME)
            info.create_system = 3
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.flag_bits |= 0x800
            with source.open("rb") as input_handle, archive.open(
                info, "w", force_zip64=True
            ) as output_handle:
                shutil.copyfileobj(input_handle, output_handle, length=1024 * 1024)


def normalize_observed_license(info) -> str | None:
    card_data = getattr(info, "card_data", None)
    license_value = None
    if card_data is not None:
        if isinstance(card_data, dict):
            license_value = card_data.get("license")
        else:
            license_value = getattr(card_data, "license", None)
    if isinstance(license_value, str) and license_value.strip():
        return license_value.strip()
    if isinstance(license_value, (list, tuple)):
        values = sorted({str(value).strip() for value in license_value if str(value).strip()})
        if values:
            return ",".join(values)
    for tag in getattr(info, "tags", None) or []:
        if isinstance(tag, str) and tag.startswith("license:") and len(tag) > len("license:"):
            return tag[len("license:") :]
    return None


def build_receipt(
    *,
    repo_id: str,
    requested_revision: str,
    resolved_revision: str,
    expected_license: str | None,
    observed_license: str | None,
    manifest: list[dict],
    bundle_path: Path,
    hub_client_version: str,
) -> dict:
    if not isinstance(repo_id, str) or not REPO_ID.fullmatch(repo_id):
        raise ValueError("repo id must have the form owner/name")
    assert_non_empty_string(requested_revision, "requested revision")
    if not isinstance(resolved_revision, str) or not HEX40.fullmatch(resolved_revision):
        raise ValueError("resolved Hugging Face revision must be a lowercase 40-character commit SHA")
    validate_license(expected_license, observed_license)
    assert_non_empty_string(hub_client_version, "Hugging Face Hub client version")
    bundle_sha256, bundle_byte_length = sha256_file(bundle_path)
    return {
        "schemaVersion": 1,
        "provider": {"id": "huggingface", "endpoint": HUGGING_FACE_ENDPOINT},
        "repository": {
            "repoId": repo_id,
            "requestedRevision": requested_revision,
            "resolvedRevision": resolved_revision,
        },
        "license": {
            "expected": expected_license,
            "observed": observed_license,
            "status": "matched" if expected_license is not None else "unverified",
        },
        "acquirer": {
            "id": IMPLEMENTATION_ID,
            "version": IMPLEMENTATION_VERSION,
            "sourceSha256": implementation_sha256(),
            "hubClient": {"name": "huggingface_hub", "version": hub_client_version},
        },
        "files": manifest,
        "bundle": {
            "format": "zip-store-v1",
            "path": bundle_path.name,
            "sha256": bundle_sha256,
            "byteLength": bundle_byte_length,
        },
        "modelArtifact": {
            "id": f"hf:{repo_id}@{resolved_revision}",
            "path": bundle_path.name,
            "sha256": bundle_sha256,
        },
    }


def package_snapshot(
    *,
    snapshot_root: Path,
    destination: Path,
    repo_id: str,
    requested_revision: str,
    resolved_revision: str,
    expected_license: str | None,
    observed_license: str | None,
    hub_client_version: str,
) -> dict:
    validate_license(expected_license, observed_license)
    destination.mkdir(parents=True, exist_ok=True)
    bundle_path = destination / "model.zip"
    receipt_path = destination / "receipt.json"
    manifest = collect_snapshot_manifest(snapshot_root)
    write_deterministic_zip(snapshot_root, bundle_path, manifest)
    receipt = build_receipt(
        repo_id=repo_id,
        requested_revision=requested_revision,
        resolved_revision=resolved_revision,
        expected_license=expected_license,
        observed_license=observed_license,
        manifest=manifest,
        bundle_path=bundle_path,
        hub_client_version=hub_client_version,
    )
    receipt_path.write_text(json.dumps(receipt, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    return receipt


def verify_receipt_shape(receipt: dict) -> None:
    if not isinstance(receipt, dict) or set(receipt) != TOP_LEVEL_KEYS:
        raise ValueError("model acquisition receipt fields are invalid")
    if receipt.get("schemaVersion") != 1:
        raise ValueError("unsupported model acquisition receipt")
    if receipt.get("provider") != {"id": "huggingface", "endpoint": HUGGING_FACE_ENDPOINT}:
        raise ValueError("receipt provider is not the canonical Hugging Face endpoint")

    repository = receipt.get("repository")
    if not isinstance(repository, dict) or set(repository) != {
        "repoId",
        "requestedRevision",
        "resolvedRevision",
    }:
        raise ValueError("receipt repository identity is invalid")
    if not isinstance(repository["repoId"], str) or not REPO_ID.fullmatch(repository["repoId"]):
        raise ValueError("receipt repository id is invalid")
    assert_non_empty_string(repository["requestedRevision"], "receipt requested revision")
    if not isinstance(repository["resolvedRevision"], str) or not HEX40.fullmatch(
        repository["resolvedRevision"]
    ):
        raise ValueError("receipt resolved revision is not an immutable commit SHA")

    license_evidence = receipt.get("license")
    if not isinstance(license_evidence, dict) or set(license_evidence) != {
        "expected",
        "observed",
        "status",
    }:
        raise ValueError("receipt license evidence is invalid")
    expected_license = assert_optional_non_empty_string(
        license_evidence["expected"], "receipt expected license"
    )
    observed_license = assert_optional_non_empty_string(
        license_evidence["observed"], "receipt observed license"
    )
    if expected_license is None:
        if license_evidence["status"] != "unverified":
            raise ValueError("receipt without expected license must be marked unverified")
    else:
        validate_license(expected_license, observed_license)
        if license_evidence["status"] != "matched":
            raise ValueError("receipt with expected license must be marked matched")

    acquirer = receipt.get("acquirer")
    if not isinstance(acquirer, dict) or set(acquirer) != {
        "id",
        "version",
        "sourceSha256",
        "hubClient",
    }:
        raise ValueError("receipt acquirer identity is invalid")
    if acquirer["id"] != IMPLEMENTATION_ID or acquirer["version"] != IMPLEMENTATION_VERSION:
        raise ValueError("receipt acquirer implementation is unsupported")
    if not isinstance(acquirer["sourceSha256"], str) or not SHA256.fullmatch(acquirer["sourceSha256"]):
        raise ValueError("receipt acquirer source hash is invalid")
    hub_client = acquirer["hubClient"]
    if not isinstance(hub_client, dict) or set(hub_client) != {"name", "version"}:
        raise ValueError("receipt Hub client identity is invalid")
    if hub_client["name"] != "huggingface_hub":
        raise ValueError("receipt Hub client name is invalid")
    assert_non_empty_string(hub_client["version"], "receipt Hub client version")

    files = receipt.get("files")
    if not isinstance(files, list) or not files:
        raise ValueError("receipt must contain at least one model file")
    seen = set()
    previous = None
    for item in files:
        if not isinstance(item, dict) or set(item) != {"path", "sha256", "byteLength"}:
            raise ValueError("receipt file entry is invalid")
        path = assert_portable_path(item["path"])
        if path in seen:
            raise ValueError(f"receipt contains duplicate path: {path}")
        if previous is not None and path <= previous:
            raise ValueError("receipt files must be strictly sorted by path")
        previous = path
        seen.add(path)
        if not isinstance(item["sha256"], str) or not SHA256.fullmatch(item["sha256"]):
            raise ValueError(f"receipt file hash is invalid: {path}")
        if not isinstance(item["byteLength"], int) or isinstance(item["byteLength"], bool) or item["byteLength"] < 0:
            raise ValueError(f"receipt file byte length is invalid: {path}")

    bundle = receipt.get("bundle")
    if not isinstance(bundle, dict) or set(bundle) != {"format", "path", "sha256", "byteLength"}:
        raise ValueError("receipt bundle identity is invalid")
    if bundle["format"] != "zip-store-v1" or bundle["path"] != "model.zip":
        raise ValueError("receipt bundle format/path is invalid")
    if not isinstance(bundle["sha256"], str) or not SHA256.fullmatch(bundle["sha256"]):
        raise ValueError("receipt bundle hash is invalid")
    if (
        not isinstance(bundle["byteLength"], int)
        or isinstance(bundle["byteLength"], bool)
        or bundle["byteLength"] <= 0
    ):
        raise ValueError("receipt bundle byte length is invalid")

    model_artifact = receipt.get("modelArtifact")
    expected_id = f"hf:{repository['repoId']}@{repository['resolvedRevision']}"
    if model_artifact != {"id": expected_id, "path": "model.zip", "sha256": bundle["sha256"]}:
        raise ValueError("receipt modelArtifact does not match repository/bundle identity")


def verify_bundle(bundle_path: Path, receipt_path: Path) -> dict:
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    verify_receipt_shape(receipt)
    bundle_sha256, bundle_byte_length = sha256_file(bundle_path)
    bundle = receipt["bundle"]
    if bundle_sha256 != bundle["sha256"] or bundle_byte_length != bundle["byteLength"]:
        raise ValueError("model bundle bytes do not match receipt")

    expected = {item["path"]: item for item in receipt["files"]}
    actual = {}
    with zipfile.ZipFile(bundle_path, "r") as archive:
        for info in archive.infolist():
            if info.is_dir():
                raise ValueError(f"bundle contains unexpected directory entry: {info.filename}")
            path = assert_portable_path(info.filename)
            if path in actual:
                raise ValueError(f"bundle contains duplicate path: {path}")
            mode = info.external_attr >> 16
            if mode and stat.S_ISLNK(mode):
                raise ValueError(f"bundle contains symbolic link entry: {path}")
            digest = hashlib.sha256()
            byte_length = 0
            with archive.open(info, "r") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
                    byte_length += len(chunk)
            actual[path] = {"path": path, "sha256": digest.hexdigest(), "byteLength": byte_length}

    if set(actual) != set(expected):
        missing = sorted(set(expected) - set(actual))
        extra = sorted(set(actual) - set(expected))
        raise ValueError(f"bundle file set differs from receipt: missing={missing}, extra={extra}")
    for path, expected_item in expected.items():
        if actual[path] != expected_item:
            raise ValueError(f"bundle entry differs from receipt: {path}")
    return {
        "status": "verified",
        "repoId": receipt["repository"]["repoId"],
        "resolvedRevision": receipt["repository"]["resolvedRevision"],
        "sha256": bundle_sha256,
        "fileCount": len(actual),
    }


def acquire(args) -> dict:
    if not isinstance(args.repo_id, str) or not REPO_ID.fullmatch(args.repo_id):
        raise ValueError("repo id must have the form owner/name")
    assert_non_empty_string(args.revision, "revision")
    assert_optional_non_empty_string(args.expected_license, "expected license")
    try:
        from huggingface_hub import HfApi, snapshot_download
        from importlib.metadata import version as package_version
    except ImportError as error:
        raise RuntimeError(
            "huggingface_hub is required for acquisition; install requirements-model-acquisition.txt"
        ) from error

    token = os.environ.get("HF_TOKEN") or None
    api = HfApi(endpoint=HUGGING_FACE_ENDPOINT, token=token)
    info = api.model_info(args.repo_id, revision=args.revision, token=token)
    resolved_revision = getattr(info, "sha", None)
    if not isinstance(resolved_revision, str) or not HEX40.fullmatch(resolved_revision):
        raise ValueError("Hugging Face did not resolve the requested revision to an immutable commit SHA")
    observed_license = normalize_observed_license(info)
    validate_license(args.expected_license, observed_license)

    with tempfile.TemporaryDirectory(prefix="asset-tooling-hf-") as temporary:
        snapshot_root = Path(temporary) / "snapshot"
        downloaded = snapshot_download(
            repo_id=args.repo_id,
            repo_type="model",
            revision=resolved_revision,
            local_dir=snapshot_root,
            token=token,
            endpoint=HUGGING_FACE_ENDPOINT,
        )
        downloaded_root = Path(downloaded).resolve()
        if downloaded_root != snapshot_root.resolve():
            raise ValueError("huggingface_hub returned an unexpected snapshot path")
        receipt = package_snapshot(
            snapshot_root=snapshot_root,
            destination=Path(args.destination),
            repo_id=args.repo_id,
            requested_revision=args.revision,
            resolved_revision=resolved_revision,
            expected_license=args.expected_license,
            observed_license=observed_license,
            hub_client_version=package_version("huggingface_hub"),
        )
    return receipt


def parse_args():
    parser = argparse.ArgumentParser(description="Acquire and verify immutable Hugging Face model bundles")
    subparsers = parser.add_subparsers(dest="command", required=True)

    acquire_parser = subparsers.add_parser("acquire")
    acquire_parser.add_argument("--repo-id", required=True)
    acquire_parser.add_argument("--revision", required=True)
    acquire_parser.add_argument("--destination", required=True)
    acquire_parser.add_argument("--expected-license")

    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("--bundle", required=True)
    verify_parser.add_argument("--receipt", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.command == "acquire":
            receipt = acquire(args)
            print(
                json.dumps(
                    {
                        "status": "acquired",
                        "repoId": receipt["repository"]["repoId"],
                        "requestedRevision": receipt["repository"]["requestedRevision"],
                        "resolvedRevision": receipt["repository"]["resolvedRevision"],
                        "licenseStatus": receipt["license"]["status"],
                        "sha256": receipt["bundle"]["sha256"],
                        "fileCount": len(receipt["files"]),
                    },
                    sort_keys=True,
                )
            )
        else:
            result = verify_bundle(Path(args.bundle), Path(args.receipt))
            print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as error:
        print(f"error: {error}", file=os.sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
