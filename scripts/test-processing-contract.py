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
SIMPLIFY_EXAMPLE_PATH = ROOT / "examples" / "mesh-simplify-receipt.json"
LOD_EXAMPLE_PATH = ROOT / "examples" / "mesh-lod-chain-receipt.json"
REPRODUCIBILITY_PATH = ROOT / "scripts" / "validate-reproducibility.py"
OBSERVATIONS_PATH = ROOT / "scripts" / "validate-processing-observations.py"


def load_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise AssertionError(f"{path} must contain a JSON object")
    return value


def load_function(path: Path, module_name: str, function_name: str):
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise AssertionError(f"could not load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return getattr(module, function_name)


def assert_invalid(validator: Draft202012Validator, receipt: dict, needle: str) -> None:
    errors = list(validator.iter_errors(receipt))
    if not errors:
        raise AssertionError(f"expected invalid receipt containing {needle!r}")
    rendered = "\n".join(error.message for error in errors)
    if needle not in rendered:
        raise AssertionError(
            f"expected validation failure containing {needle!r}, got:\n{rendered}"
        )


def assert_cross_field_error(errors: list[str], needle: str) -> None:
    rendered = "\n".join(errors)
    if needle not in rendered:
        raise AssertionError(f"expected cross-field failure containing {needle!r}, got:\n{rendered}")


def main() -> None:
    schema = load_json(SCHEMA_PATH)
    simplify_example = load_json(SIMPLIFY_EXAMPLE_PATH)
    lod_example = load_json(LOD_EXAMPLE_PATH)
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    validator.validate(simplify_example)
    validator.validate(lod_example)

    missing_target = copy.deepcopy(simplify_example)
    del missing_target["parameters"]["targetTriangleCount"]
    assert_invalid(validator, missing_target, "targetTriangleCount")

    missing_observations = copy.deepcopy(simplify_example)
    del missing_observations["observations"]
    assert_invalid(validator, missing_observations, "observations")

    exact_without_repeat = copy.deepcopy(simplify_example)
    del exact_without_repeat["reproducibility"]["repeatOutputSha256"]
    assert_invalid(validator, exact_without_repeat, "repeatOutputSha256")

    structural_without_evidence = copy.deepcopy(simplify_example)
    structural_without_evidence["reproducibility"] = {"state": "structural"}
    assert_invalid(validator, structural_without_evidence, "evidence")

    validate_reproducibility = load_function(
        REPRODUCIBILITY_PATH,
        "processing_reproducibility",
        "validate_reproducibility",
    )
    validate_observations = load_function(
        OBSERVATIONS_PATH,
        "processing_observations",
        "validate_observations",
    )

    for example in (simplify_example, lod_example):
        if validate_reproducibility(example):
            raise AssertionError("valid exact receipt failed reproducibility validation")
        if validate_observations(example):
            raise AssertionError("valid receipt failed observation validation")

    mismatched_repeat = copy.deepcopy(simplify_example)
    mismatched_repeat["reproducibility"]["repeatOutputSha256"] = "2" * 64
    assert_cross_field_error(validate_reproducibility(mismatched_repeat), "output.sha256")

    structural = copy.deepcopy(simplify_example)
    structural["reproducibility"] = {
        "state": "structural",
        "evidence": {"reason": "backend is not byte-deterministic"},
    }
    validator.validate(structural)
    if validate_reproducibility(structural):
        raise AssertionError("valid structural evidence failed validation")

    mismatched_source = copy.deepcopy(simplify_example)
    mismatched_source["observations"]["sourceTriangleCount"] = 4095
    assert_cross_field_error(
        validate_observations(mismatched_source),
        "sourceTriangleCount",
    )

    invalid_index_count = copy.deepcopy(simplify_example)
    invalid_index_count["observations"]["resultIndexCount"] += 1
    assert_cross_field_error(
        validate_observations(invalid_index_count),
        "resultTriangleCount * 3",
    )

    exceeded_error = copy.deepcopy(simplify_example)
    exceeded_error["observations"]["relativeError"] = 0.02
    assert_cross_field_error(
        validate_observations(exceeded_error),
        "targetError",
    )

    mismatched_lod_ratio = copy.deepcopy(lod_example)
    mismatched_lod_ratio["observations"]["levels"][1]["triangleRatio"] = 0.34
    assert_cross_field_error(
        validate_observations(mismatched_lod_ratio),
        "triangleRatio",
    )

    nondecreasing_lod_budget = copy.deepcopy(lod_example)
    nondecreasing_lod_budget["observations"]["levels"][1]["requestedTriangleCount"] = 2700
    assert_cross_field_error(
        validate_observations(nondecreasing_lod_budget),
        "strictly decreasing",
    )

    print("processing receipt contract valid")


if __name__ == "__main__":
    main()
