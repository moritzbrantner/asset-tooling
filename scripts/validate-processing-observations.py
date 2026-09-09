#!/usr/bin/env python3
"""Validate cross-field processing observations after v2 JSON Schema validation."""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
import json
import math
import sys
from pathlib import Path
from typing import Any


def _finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _same_number(left: Any, right: Any) -> bool:
    return _finite_number(left) and _finite_number(right) and math.isclose(
        float(left), float(right), rel_tol=1e-9, abs_tol=1e-12
    )


def _non_finite_errors(value: Any, path: str = "$.") -> list[str]:
    errors: list[str] = []
    if isinstance(value, float) and not math.isfinite(value):
        errors.append(f"{path.rstrip('.')} contains a non-finite number")
    elif isinstance(value, dict):
        for key, nested in value.items():
            errors.extend(_non_finite_errors(nested, f"{path}{key}."))
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            errors.extend(_non_finite_errors(nested, f"{path}[{index}]."))
    return errors


def _reject_json_constant(token: str) -> None:
    raise ValueError(f"non-standard JSON numeric constant {token!r} is not allowed")


def _derived_lod_target(source_triangle_count: int, triangle_ratio: Any) -> int | None:
    if not _finite_number(triangle_ratio):
        return None
    ratio = Decimal(str(triangle_ratio))
    requested = int((Decimal(source_triangle_count) * ratio).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    return max(1, min(requested, source_triangle_count - 1))


def validate_observations(receipt: dict[str, Any]) -> list[str]:
    if receipt.get("schemaVersion") != 2:
        return ["processing observations require a schemaVersion 2 receipt"]

    parameters = receipt.get("parameters")
    observations = receipt.get("observations")
    if not isinstance(parameters, dict) or not isinstance(observations, dict):
        return ["receipt must be schema-valid before observation validation"]

    errors = _non_finite_errors(receipt)
    if errors:
        return errors

    operation = receipt.get("operation")

    if operation == "mesh.simplify":
        if observations.get("sourceTriangleCount") != parameters.get("sourceTriangleCount"):
            errors.append("observations.sourceTriangleCount must equal parameters.sourceTriangleCount")
        if observations.get("requestedTriangleCount") != parameters.get("targetTriangleCount"):
            errors.append("observations.requestedTriangleCount must equal parameters.targetTriangleCount")
        result_triangles = observations.get("resultTriangleCount")
        result_indices = observations.get("resultIndexCount")
        source_triangles = observations.get("sourceTriangleCount")
        if isinstance(result_triangles, int) and isinstance(result_indices, int):
            if result_indices != result_triangles * 3:
                errors.append("observations.resultIndexCount must equal resultTriangleCount * 3")
        if isinstance(result_triangles, int) and isinstance(source_triangles, int):
            if result_triangles > source_triangles:
                errors.append("observations.resultTriangleCount must not exceed sourceTriangleCount")
        relative_error = observations.get("relativeError")
        target_error = parameters.get("targetError")
        if _finite_number(relative_error) and _finite_number(target_error):
            if float(relative_error) > float(target_error):
                errors.append("observations.relativeError must not exceed parameters.targetError")

    elif operation == "mesh.lod_chain":
        source_parameter = parameters.get("sourceTriangleCount")
        if observations.get("sourceTriangleCount") != source_parameter:
            errors.append("observations.sourceTriangleCount must equal parameters.sourceTriangleCount")
        if observations.get("sourceBased") is not parameters.get("sourceBased"):
            errors.append("observations.sourceBased must equal parameters.sourceBased")

        requested_levels = parameters.get("levels")
        observed_levels = observations.get("levels")
        if isinstance(requested_levels, list) and isinstance(observed_levels, list):
            if len(requested_levels) != len(observed_levels):
                errors.append("observations.levels must have the same length as parameters.levels")
            previous_requested: int | None = None
            for index, (requested, observed) in enumerate(zip(requested_levels, observed_levels), start=1):
                if not isinstance(requested, dict) or not isinstance(observed, dict):
                    continue
                level_path = f"levels[{index - 1}]"
                if observed.get("level") != index:
                    errors.append(f"observations.{level_path}.level must equal {index}")
                if not _same_number(observed.get("triangleRatio"), requested.get("triangleRatio")):
                    errors.append(
                        f"observations.{level_path}.triangleRatio must equal the requested triangleRatio"
                    )

                parameter_target = requested.get("targetTriangleCount")
                if isinstance(source_parameter, int):
                    derived_target = _derived_lod_target(source_parameter, requested.get("triangleRatio"))
                    if derived_target is not None and parameter_target != derived_target:
                        errors.append(
                            f"parameters.{level_path}.targetTriangleCount must equal the declared ratio budget {derived_target}"
                        )
                if observed.get("requestedTriangleCount") != parameter_target:
                    errors.append(
                        f"observations.{level_path}.requestedTriangleCount must equal parameters.{level_path}.targetTriangleCount"
                    )

                result_triangles = observed.get("resultTriangleCount")
                result_indices = observed.get("resultIndexCount")
                source_triangles = observations.get("sourceTriangleCount")
                requested_triangles = observed.get("requestedTriangleCount")
                if isinstance(result_triangles, int) and isinstance(result_indices, int):
                    if result_indices != result_triangles * 3:
                        errors.append(
                            f"observations.{level_path}.resultIndexCount must equal resultTriangleCount * 3"
                        )
                if isinstance(result_triangles, int) and isinstance(source_triangles, int):
                    if result_triangles > source_triangles:
                        errors.append(
                            f"observations.{level_path}.resultTriangleCount must not exceed sourceTriangleCount"
                        )
                if isinstance(requested_triangles, int):
                    if previous_requested is not None and requested_triangles >= previous_requested:
                        errors.append("LOD requestedTriangleCount values must be strictly decreasing")
                    previous_requested = requested_triangles
                relative_error = observed.get("relativeError")
                target_error = requested.get("targetError")
                if _finite_number(relative_error) and _finite_number(target_error):
                    if float(relative_error) > float(target_error):
                        errors.append(
                            f"observations.{level_path}.relativeError must not exceed the requested targetError"
                        )

    elif operation == "animation.resample":
        start = parameters.get("sourceStartSeconds")
        end = parameters.get("sourceEndSeconds")
        times = parameters.get("targetTimesSeconds")
        if _finite_number(start) and _finite_number(end) and float(end) < float(start):
            errors.append("parameters.sourceEndSeconds must not precede sourceStartSeconds")
        if isinstance(times, list) and all(_finite_number(time) for time in times):
            for index in range(1, len(times)):
                if float(times[index]) <= float(times[index - 1]):
                    errors.append("parameters.targetTimesSeconds must be strictly increasing")
                    break
            if _finite_number(start) and _finite_number(end):
                if any(float(time) < float(start) or float(time) > float(end) for time in times):
                    errors.append("parameters.targetTimesSeconds must stay inside the source time domain")

            channel_count = observations.get("channelCount")
            result_count = observations.get("resultKeyframeCount")
            if isinstance(channel_count, int) and isinstance(result_count, int):
                expected_result_count = len(times) * channel_count
                if result_count != expected_result_count:
                    errors.append(
                        "observations.resultKeyframeCount must equal len(parameters.targetTimesSeconds) * observations.channelCount"
                    )

    elif operation == "animation.reduce":
        source_count = observations.get("sourceKeyframeCount")
        result_count = observations.get("resultKeyframeCount")
        if isinstance(source_count, int) and isinstance(result_count, int) and result_count > source_count:
            errors.append("animation reduction must not increase the keyframe count")

        if parameters.get("preserveEndpoints") is True:
            if observations.get("endpointsPreserved") is not True:
                errors.append(
                    "observations.endpointsPreserved must be true when parameters.preserveEndpoints is true"
                )
            if isinstance(source_count, int) and source_count > 1 and isinstance(result_count, int) and result_count < 2:
                errors.append("endpoint-preserving reduction with multiple source keys must retain at least two keys")

        comparisons = [
            ("maxTranslationError", "translationError"),
            ("maxRotationErrorRadians", "rotationErrorRadians"),
            ("maxScaleError", "scaleError"),
        ]
        for observed_name, parameter_name in comparisons:
            observed_value = observations.get(observed_name)
            configured_value = parameters.get(parameter_name)
            if _finite_number(observed_value) and _finite_number(configured_value):
                if float(observed_value) > float(configured_value):
                    errors.append(
                        f"observations.{observed_name} must not exceed parameters.{parameter_name}"
                    )

    else:
        errors.append("receipt must be schema-valid before observation validation")

    return errors


def validate_file(path: Path) -> list[str]:
    try:
        receipt = json.loads(
            path.read_text(encoding="utf-8"),
            parse_constant=_reject_json_constant,
        )
    except (OSError, ValueError) as error:
        return [f"could not read strict JSON: {error}"]
    if not isinstance(receipt, dict):
        return ["receipt root must be a JSON object"]
    return validate_observations(receipt)


def main(arguments: list[str]) -> int:
    if len(arguments) < 2:
        print(f"usage: {arguments[0]} RECEIPT.json [RECEIPT.json ...]", file=sys.stderr)
        return 2

    failed = False
    for raw_path in arguments[1:]:
        path = Path(raw_path)
        errors = validate_file(path)
        if errors:
            failed = True
            for error in errors:
                print(f"{path}: {error}", file=sys.stderr)
        else:
            print(f"{path}: processing observations valid")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
