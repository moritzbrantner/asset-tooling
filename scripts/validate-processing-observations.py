#!/usr/bin/env python3
"""Validate cross-field processing observations after v2 JSON Schema validation."""

from __future__ import annotations

from decimal import Decimal
import json
import math
import sys
from pathlib import Path
from typing import Any


def _decimal_number(value: Any) -> Decimal | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        return Decimal(str(value))
    if isinstance(value, Decimal):
        return value if value.is_finite() else None
    return None


def _finite_number(value: Any) -> bool:
    return _decimal_number(value) is not None


def _same_number(left: Any, right: Any) -> bool:
    left_number = _decimal_number(left)
    right_number = _decimal_number(right)
    if left_number is None or right_number is None:
        return False

    difference = abs(left_number - right_number)
    scale = max(abs(left_number), abs(right_number))
    tolerance = max(Decimal("1e-12"), Decimal("1e-9") * scale)
    return difference <= tolerance


def _non_finite_errors(value: Any, path: str = "$." ) -> list[str]:
    errors: list[str] = []
    if isinstance(value, float) and not math.isfinite(value):
        errors.append(f"{path.rstrip('.')} contains a non-finite number")
    elif isinstance(value, Decimal) and not value.is_finite():
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
    ratio = _decimal_number(triangle_ratio)
    if ratio is None:
        return None

    numerator, denominator = ratio.as_integer_ratio()
    scaled = source_triangle_count * numerator
    quotient, remainder = divmod(scaled, denominator)
    if remainder * 2 >= denominator:
        quotient += 1
    return max(1, min(quotient, source_triangle_count - 1))


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
        relative_error = _decimal_number(observations.get("relativeError"))
        target_error = _decimal_number(parameters.get("targetError"))
        if relative_error is not None and target_error is not None:
            if relative_error > target_error:
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
            previous_result: int | None = None
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
                if isinstance(result_triangles, int):
                    if previous_result is not None and result_triangles > previous_result:
                        errors.append("LOD resultTriangleCount values must be non-increasing")
                    previous_result = result_triangles
                if isinstance(requested_triangles, int):
                    if previous_requested is not None and requested_triangles >= previous_requested:
                        errors.append("LOD requestedTriangleCount values must be strictly decreasing")
                    previous_requested = requested_triangles
                relative_error = _decimal_number(observed.get("relativeError"))
                target_error = _decimal_number(requested.get("targetError"))
                if relative_error is not None and target_error is not None:
                    if relative_error > target_error:
                        errors.append(
                            f"observations.{level_path}.relativeError must not exceed the requested targetError"
                        )

    elif operation == "animation.resample":
        start = _decimal_number(parameters.get("sourceStartSeconds"))
        end = _decimal_number(parameters.get("sourceEndSeconds"))
        times = parameters.get("targetTimesSeconds")
        if start is not None and end is not None and end < start:
            errors.append("parameters.sourceEndSeconds must not precede sourceStartSeconds")
        if isinstance(times, list):
            time_values = [_decimal_number(time) for time in times]
            if all(time is not None for time in time_values):
                normalized_times = [time for time in time_values if time is not None]
                for index in range(1, len(normalized_times)):
                    if normalized_times[index] <= normalized_times[index - 1]:
                        errors.append("parameters.targetTimesSeconds must be strictly increasing")
                        break
                if start is not None and end is not None:
                    if any(time < start or time > end for time in normalized_times):
                        errors.append("parameters.targetTimesSeconds must stay inside the source time domain")

                channel_count = observations.get("channelCount")
                result_count = observations.get("resultKeyframeCount")
                if isinstance(channel_count, int) and isinstance(result_count, int):
                    expected_result_count = len(normalized_times) * channel_count
                    if result_count != expected_result_count:
                        errors.append(
                            "observations.resultKeyframeCount must equal len(parameters.targetTimesSeconds) * observations.channelCount"
                        )

                if normalized_times:
                    duration = observations.get("durationSeconds")
                    expected_duration = normalized_times[-1] - normalized_times[0]
                    if not _same_number(duration, expected_duration):
                        errors.append(
                            "observations.durationSeconds must equal the elapsed span of parameters.targetTimesSeconds"
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
            observed_value = _decimal_number(observations.get(observed_name))
            configured_value = _decimal_number(parameters.get(parameter_name))
            if observed_value is not None and configured_value is not None:
                if observed_value > configured_value:
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
            parse_float=Decimal,
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
