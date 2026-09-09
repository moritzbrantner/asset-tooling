#!/usr/bin/env python3
"""Validate cross-field processing observations after JSON Schema validation."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any


def _same_number(left: Any, right: Any) -> bool:
    return isinstance(left, (int, float)) and isinstance(right, (int, float)) and math.isclose(
        float(left), float(right), rel_tol=1e-9, abs_tol=1e-12
    )


def validate_observations(receipt: dict[str, Any]) -> list[str]:
    operation = receipt.get("operation")
    parameters = receipt.get("parameters")
    observations = receipt.get("observations")
    if not isinstance(parameters, dict) or not isinstance(observations, dict):
        return ["receipt must be schema-valid before observation validation"]

    errors: list[str] = []

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
        if isinstance(relative_error, (int, float)) and isinstance(target_error, (int, float)):
            if float(relative_error) > float(target_error):
                errors.append("observations.relativeError must not exceed parameters.targetError")

    elif operation == "mesh.lod_chain":
        if observations.get("sourceTriangleCount") != parameters.get("sourceTriangleCount"):
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
                if observed.get("level") != index:
                    errors.append(f"observations.levels[{index - 1}].level must equal {index}")
                if not _same_number(observed.get("triangleRatio"), requested.get("triangleRatio")):
                    errors.append(
                        f"observations.levels[{index - 1}].triangleRatio must equal the requested triangleRatio"
                    )
                result_triangles = observed.get("resultTriangleCount")
                result_indices = observed.get("resultIndexCount")
                source_triangles = observations.get("sourceTriangleCount")
                requested_triangles = observed.get("requestedTriangleCount")
                if isinstance(result_triangles, int) and isinstance(result_indices, int):
                    if result_indices != result_triangles * 3:
                        errors.append(
                            f"observations.levels[{index - 1}].resultIndexCount must equal resultTriangleCount * 3"
                        )
                if isinstance(result_triangles, int) and isinstance(source_triangles, int):
                    if result_triangles > source_triangles:
                        errors.append(
                            f"observations.levels[{index - 1}].resultTriangleCount must not exceed sourceTriangleCount"
                        )
                if isinstance(requested_triangles, int):
                    if previous_requested is not None and requested_triangles >= previous_requested:
                        errors.append("LOD requestedTriangleCount values must be strictly decreasing")
                    previous_requested = requested_triangles
                relative_error = observed.get("relativeError")
                target_error = requested.get("targetError")
                if isinstance(relative_error, (int, float)) and isinstance(target_error, (int, float)):
                    if float(relative_error) > float(target_error):
                        errors.append(
                            f"observations.levels[{index - 1}].relativeError must not exceed the requested targetError"
                        )

    elif operation == "animation.resample":
        start = parameters.get("sourceStartSeconds")
        end = parameters.get("sourceEndSeconds")
        times = parameters.get("targetTimesSeconds")
        if isinstance(start, (int, float)) and isinstance(end, (int, float)) and float(end) < float(start):
            errors.append("parameters.sourceEndSeconds must not precede sourceStartSeconds")
        if isinstance(times, list):
            for index in range(1, len(times)):
                if float(times[index]) <= float(times[index - 1]):
                    errors.append("parameters.targetTimesSeconds must be strictly increasing")
                    break
            if isinstance(start, (int, float)) and isinstance(end, (int, float)):
                if any(float(time) < float(start) or float(time) > float(end) for time in times):
                    errors.append("parameters.targetTimesSeconds must stay inside the source time domain")

    elif operation == "animation.reduce":
        source_count = observations.get("sourceKeyframeCount")
        result_count = observations.get("resultKeyframeCount")
        if isinstance(source_count, int) and isinstance(result_count, int) and result_count > source_count:
            errors.append("animation reduction must not increase the keyframe count")
        comparisons = [
            ("maxTranslationError", "translationError"),
            ("maxRotationErrorRadians", "rotationErrorRadians"),
            ("maxScaleError", "scaleError"),
        ]
        for observed_name, parameter_name in comparisons:
            observed_value = observations.get(observed_name)
            configured_value = parameters.get(parameter_name)
            if isinstance(observed_value, (int, float)) and isinstance(configured_value, (int, float)):
                if float(observed_value) > float(configured_value):
                    errors.append(
                        f"observations.{observed_name} must not exceed parameters.{parameter_name}"
                    )

    else:
        errors.append("receipt must be schema-valid before observation validation")

    return errors


def validate_file(path: Path) -> list[str]:
    try:
        receipt = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return [f"could not read JSON: {error}"]
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
