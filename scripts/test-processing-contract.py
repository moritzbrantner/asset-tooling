#!/usr/bin/env python3
"""Contract tests for processing receipt schemas and cross-field evidence."""

from __future__ import annotations

import copy
import importlib.util
import json
import tempfile
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_V1_PATH = ROOT / "schemas" / "processing-receipt-v1.schema.json"
SCHEMA_V2_PATH = ROOT / "schemas" / "processing-receipt-v2.schema.json"
EXAMPLE_PATHS = [
    ROOT / "examples" / "mesh-simplify-receipt.json",
    ROOT / "examples" / "mesh-lod-chain-receipt.json",
    ROOT / "examples" / "animation-resample-receipt.json",
    ROOT / "examples" / "animation-reduce-receipt.json",
]
REPRODUCIBILITY_PATH = ROOT / "scripts" / "validate-reproducibility.py"
OBSERVATIONS_PATH = ROOT / "scripts" / "validate-processing-observations.py"


def reject_json_constant(token: str) -> None:
    raise ValueError(f"non-standard JSON numeric constant {token!r} is not allowed")


def load_json(path: Path) -> dict:
    value = json.loads(
        path.read_text(encoding="utf-8"),
        parse_constant=reject_json_constant,
    )
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
    schema_v1 = load_json(SCHEMA_V1_PATH)
    schema_v2 = load_json(SCHEMA_V2_PATH)
    Draft202012Validator.check_schema(schema_v1)
    Draft202012Validator.check_schema(schema_v2)
    validator_v1 = Draft202012Validator(schema_v1)
    validator_v2 = Draft202012Validator(schema_v2)

    simplify_example, lod_example, resample_example, reduce_example = [
        load_json(path) for path in EXAMPLE_PATHS
    ]
    examples = [simplify_example, lod_example, resample_example, reduce_example]
    for example in examples:
        validator_v2.validate(example)

    legacy_v1 = copy.deepcopy(simplify_example)
    legacy_v1["schemaVersion"] = 1
    del legacy_v1["observations"]
    validator_v1.validate(legacy_v1)

    missing_target = copy.deepcopy(simplify_example)
    del missing_target["parameters"]["targetTriangleCount"]
    assert_invalid(validator_v2, missing_target, "targetTriangleCount")

    missing_observations = copy.deepcopy(simplify_example)
    del missing_observations["observations"]
    assert_invalid(validator_v2, missing_observations, "observations")

    exact_without_repeat = copy.deepcopy(simplify_example)
    del exact_without_repeat["reproducibility"]["repeatOutputSha256"]
    assert_invalid(validator_v2, exact_without_repeat, "repeatOutputSha256")

    structural_without_evidence = copy.deepcopy(simplify_example)
    structural_without_evidence["reproducibility"] = {"state": "structural"}
    assert_invalid(validator_v2, structural_without_evidence, "evidence")

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
    validate_observation_file = load_function(
        OBSERVATIONS_PATH,
        "processing_observations_file",
        "validate_file",
    )

    for example in examples:
        if validate_reproducibility(example):
            raise AssertionError("valid exact receipt failed reproducibility validation")
        if validate_observations(example):
            raise AssertionError("valid v2 receipt failed observation validation")

    mismatched_repeat = copy.deepcopy(simplify_example)
    mismatched_repeat["reproducibility"]["repeatOutputSha256"] = "2" * 64
    assert_cross_field_error(validate_reproducibility(mismatched_repeat), "output.sha256")

    structural = copy.deepcopy(simplify_example)
    structural["reproducibility"] = {
        "state": "structural",
        "evidence": {"reason": "backend is not byte-deterministic"},
    }
    validator_v2.validate(structural)
    if validate_reproducibility(structural):
        raise AssertionError("valid structural evidence failed validation")

    mismatched_source = copy.deepcopy(simplify_example)
    mismatched_source["observations"]["sourceTriangleCount"] = 4095
    assert_cross_field_error(validate_observations(mismatched_source), "sourceTriangleCount")

    invalid_index_count = copy.deepcopy(simplify_example)
    invalid_index_count["observations"]["resultIndexCount"] += 1
    assert_cross_field_error(validate_observations(invalid_index_count), "resultTriangleCount * 3")

    exceeded_error = copy.deepcopy(simplify_example)
    exceeded_error["observations"]["relativeError"] = 0.02
    assert_cross_field_error(validate_observations(exceeded_error), "targetError")

    non_finite_error = copy.deepcopy(simplify_example)
    non_finite_error["observations"]["relativeError"] = float("nan")
    assert_cross_field_error(validate_observations(non_finite_error), "non-finite")

    mismatched_lod_ratio = copy.deepcopy(lod_example)
    mismatched_lod_ratio["observations"]["levels"][1]["triangleRatio"] = 0.34
    assert_cross_field_error(validate_observations(mismatched_lod_ratio), "triangleRatio")

    wrong_derived_budget = copy.deepcopy(lod_example)
    wrong_derived_budget["parameters"]["levels"][1]["targetTriangleCount"] = 1400
    assert_cross_field_error(validate_observations(wrong_derived_budget), "declared ratio budget 1434")

    mismatched_applied_budget = copy.deepcopy(lod_example)
    mismatched_applied_budget["observations"]["levels"][1]["requestedTriangleCount"] = 1400
    assert_cross_field_error(validate_observations(mismatched_applied_budget), "targetTriangleCount")

    nondecreasing_lod_budget = copy.deepcopy(lod_example)
    nondecreasing_lod_budget["parameters"]["levels"][1]["targetTriangleCount"] = 2700
    nondecreasing_lod_budget["observations"]["levels"][1]["requestedTriangleCount"] = 2700
    errors = validate_observations(nondecreasing_lod_budget)
    assert_cross_field_error(errors, "strictly decreasing")

    increasing_lod_result = copy.deepcopy(lod_example)
    first_result_count = increasing_lod_result["observations"]["levels"][0]["resultTriangleCount"]
    increasing_lod_result["observations"]["levels"][1]["resultTriangleCount"] = first_result_count + 1
    increasing_lod_result["observations"]["levels"][1]["resultIndexCount"] = (first_result_count + 1) * 3
    assert_cross_field_error(validate_observations(increasing_lod_result), "non-increasing")

    wrong_resample_count = copy.deepcopy(resample_example)
    wrong_resample_count["observations"]["resultKeyframeCount"] = 1
    assert_cross_field_error(validate_observations(wrong_resample_count), "targetTimesSeconds")

    wrong_resample_duration = copy.deepcopy(resample_example)
    wrong_resample_duration["observations"]["durationSeconds"] = 999
    assert_cross_field_error(validate_observations(wrong_resample_duration), "durationSeconds")

    large_timeline = copy.deepcopy(resample_example)
    large_time = 10**400
    large_timeline["parameters"]["sourceEndSeconds"] = large_time
    large_timeline["parameters"]["targetTimesSeconds"] = [0, large_time]
    large_timeline["observations"]["resultKeyframeCount"] = (
        2 * large_timeline["observations"]["channelCount"]
    )
    large_timeline["observations"]["durationSeconds"] = large_time
    validator_v2.validate(large_timeline)
    large_timeline_errors = validate_observations(large_timeline)
    if large_timeline_errors:
        raise AssertionError(
            "schema-valid large integer timeline failed observation validation:\n"
            + "\n".join(large_timeline_errors)
        )

    missing_endpoint_evidence = copy.deepcopy(reduce_example)
    missing_endpoint_evidence["observations"]["endpointsPreserved"] = False
    assert_cross_field_error(validate_observations(missing_endpoint_evidence), "endpointsPreserved")

    impossible_endpoint_count = copy.deepcopy(reduce_example)
    impossible_endpoint_count["observations"]["resultKeyframeCount"] = 1
    assert_cross_field_error(validate_observations(impossible_endpoint_count), "at least two keys")

    with tempfile.TemporaryDirectory() as directory:
        invalid_json_path = Path(directory) / "nan-receipt.json"
        invalid_json_path.write_text('{"schemaVersion":2,"relativeError":NaN}', encoding="utf-8")
        assert_cross_field_error(validate_observation_file(invalid_json_path), "non-standard JSON numeric constant")

        exact_decimal_path = Path(directory) / "exact-decimal-lod-receipt.json"
        exact_decimal_receipt = {
            "schemaVersion": 2,
            "operation": "mesh.lod_chain",
            "parameters": {
                "sourceTriangleCount": 10,
                "sourceBased": True,
                "budgetRounding": "nearest-ties-away-from-zero",
                "levels": [
                    {
                        "triangleRatio": "__EXACT_RATIO__",
                        "targetTriangleCount": 2,
                        "targetError": 0,
                        "lockBorder": False,
                    }
                ],
            },
            "observations": {
                "sourceTriangleCount": 10,
                "sourceVertexCount": 10,
                "sourceBased": True,
                "sharedSourceVertexBuffer": True,
                "levels": [
                    {
                        "level": 1,
                        "triangleRatio": "__EXACT_RATIO__",
                        "requestedTriangleCount": 2,
                        "resultTriangleCount": 2,
                        "resultIndexCount": 6,
                        "relativeError": 0,
                        "indexSha256": "0" * 64,
                    }
                ],
            },
        }
        exact_decimal_text = json.dumps(exact_decimal_receipt).replace(
            '"__EXACT_RATIO__"', "0.14999999999999999"
        )
        exact_decimal_path.write_text(exact_decimal_text, encoding="utf-8")
        assert_cross_field_error(
            validate_observation_file(exact_decimal_path),
            "declared ratio budget 1",
        )

    print("processing receipt v1 compatibility and v2 observation contracts valid")


if __name__ == "__main__":
    main()
