#!/usr/bin/env python3
"""Contract tests for processing receipt schema and cross-field evidence."""

from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = ROOT / "schemas" / "processing-receipt-v1.schema.json"
EXAMPLE_PATH = ROOT / "examples" / "mesh-simplify-receipt.json"
REPRODUCIBILITY_PATH = ROOT / "scripts" / "validate-reproducibility.py"


def load_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise AssertionError(f"{path} must contain a JSON object")
    return value


def load_reproducibility_validator():
    spec = importlib.util.spec_from_file_location(
        "processing_reproducibility", REPRODUCIBILITY_PATH
    )
    if spec is None or spec.loader is None:
        raise AssertionError("could not load reproducibility validator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.validate_reproducibility


def assert_invalid(validator: Draft202012Validator, receipt: dict, needle: str) -> None:
    errors = list(validator.iter_errors(receipt))
    if not errors:
        raise AssertionError(f"expected invalid receipt containing {needle!r}")
    rendered = "\n".join(error.message for error in errors)
    if needle not in rendered:
        raise AssertionError(
            f"expected validation failure containing {needle!r}, got:\n{rendered}"
        )


def main() -> None:
    schema = load_json(SCHEMA_PATH)
    example = load_json(EXAMPLE_PATH)
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    validator.validate(example)

    missing_target = copy.deepcopy(example)
    del missing_target["parameters"]["targetTriangleCount"]
    assert_invalid(validator, missing_target, "targetTriangleCount")

    exact_without_repeat = copy.deepcopy(example)
    del exact_without_repeat["reproducibility"]["repeatOutputSha256"]
    assert_invalid(validator, exact_without_repeat, "repeatOutputSha256")

    structural_without_evidence = copy.deepcopy(example)
    structural_without_evidence["reproducibility"] = {"state": "structural"}
    assert_invalid(validator, structural_without_evidence, "evidence")

    validate_reproducibility = load_reproducibility_validator()
    if validate_reproducibility(example):
        raise AssertionError("valid exact receipt failed cross-field validation")

    mismatched_repeat = copy.deepcopy(example)
    mismatched_repeat["reproducibility"]["repeatOutputSha256"] = "2" * 64
    errors = validate_reproducibility(mismatched_repeat)
    if not errors or "output.sha256" not in errors[0]:
        raise AssertionError("mismatched replay hash was not rejected")

    structural = copy.deepcopy(example)
    structural["reproducibility"] = {
        "state": "structural",
        "evidence": {"reason": "backend is not byte-deterministic"},
    }
    validator.validate(structural)
    if validate_reproducibility(structural):
        raise AssertionError("valid structural evidence failed validation")

    print("processing receipt contract valid")


if __name__ == "__main__":
    main()
