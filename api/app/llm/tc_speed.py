"""TC generation speed knobs (E2E/Unit fan-out) — env + engineHint.speed."""

from __future__ import annotations

import os
from typing import Any


def _env_truthy(name: str, default: str = "0") -> bool:
    raw = (os.environ.get(name) or default).strip().lower()
    return raw in ("1", "true", "yes", "on")


def resolve_tc_speed_mode(
    preferred_engine: str | None,
    engine_hint: dict[str, Any] | None = None,
) -> str:
    """
    Return ``fast`` | ``full``.

    Precedence: engineHint.speed → AITEST_TC_E2E_SPEED / AITEST_TC_UNIT_SPEED →
    default fast for E2E, full for Unit/mixed.
    """
    hint = engine_hint if isinstance(engine_hint, dict) else {}
    raw = str(hint.get("speed") or "").strip().lower()
    if raw in ("fast", "full"):
        return raw

    eng = (preferred_engine or "").strip().lower()
    if eng == "e2e":
        env = (os.environ.get("AITEST_TC_E2E_SPEED") or "fast").strip().lower()
        return "fast" if env not in ("full", "complete", "max") else "full"
    if eng == "unit":
        env = (os.environ.get("AITEST_TC_UNIT_SPEED") or "full").strip().lower()
        return "fast" if env in ("fast", "quick") else "full"
    return "full"


def resolve_max_tc_per_module(
    preferred_engine: str | None,
    speed: str,
    engine_hint: dict[str, Any] | None = None,
) -> int | None:
    """
    Soft cap for prompt anti-lazy when speed=fast.
    None = no artificial ceiling (full coverage mode).
    """
    if (speed or "").strip().lower() != "fast":
        return None

    hint = engine_hint if isinstance(engine_hint, dict) else {}
    for key in ("maxPerModule", "maxTcPerModule"):
        if hint.get(key) is not None:
            try:
                n = int(hint[key])
                return max(2, min(30, n))
            except (TypeError, ValueError):
                pass

    eng = (preferred_engine or "").strip().lower()
    env_key = (
        "AITEST_TC_E2E_MAX_PER_MODULE"
        if eng == "e2e"
        else "AITEST_TC_UNIT_MAX_PER_MODULE"
        if eng == "unit"
        else "AITEST_TC_MAX_PER_MODULE"
    )
    default = "6" if eng == "e2e" else "8"
    try:
        n = int(os.environ.get(env_key, default))
    except ValueError:
        n = 6 if eng == "e2e" else 8
    return max(2, min(30, n))


def knowledge_enough_skip_source_scan(
    bundle: dict[str, Any] | None,
    preferred_engine: str | None,
) -> bool:
    """
    E2E: skip workspace file scan when freeze Knowledge already has UI/AC signals.
    Override with AITEST_TC_E2E_FORCE_SOURCE_SCAN=1.
    """
    if (preferred_engine or "").strip().lower() != "e2e":
        return False
    if _env_truthy("AITEST_TC_E2E_FORCE_SOURCE_SCAN"):
        return False
    if not isinstance(bundle, dict):
        return False
    knowledge = (
        bundle.get("knowledge")
        if isinstance(bundle.get("knowledge"), dict)
        else bundle
    )
    if not isinstance(knowledge, dict):
        return False

    def _len(key: str) -> int:
        v = knowledge.get(key)
        return len(v) if isinstance(v, list) else 0

    modules = _len("features") + _len("useCases")
    signals = (
        _len("acceptanceCriteria")
        + _len("validationRules")
        + _len("businessRules")
        + _len("actors")
    )
    # At least one module bucket + several testable signals
    return modules >= 1 and signals >= 3


def speed_prompt_addon(
    *,
    speed: str,
    max_per_module: int | None,
    preferred_engine: str | None = None,
) -> str:
    """Extra system/user lines when fast mode caps coverage."""
    if (speed or "").strip().lower() != "fast" or not max_per_module:
        return ""
    eng = (preferred_engine or "").strip().lower()
    kind = "journey E2E" if eng == "e2e" else "TC"
    return (
        f"\nSPEED MODE=fast (trần mềm ≤{max_per_module} {kind}/module):\n"
        f"- Ưu tiên: 1 happy path + validation/negative quan trọng + 1 permission/boundary "
        f"nếu tài liệu có tín hiệu — tối đa {max_per_module} TC cho module này.\n"
        f"- Không bịa thêm case «cho đủ checklist»; bỏ journey phụ/ít tín hiệu.\n"
        f"- Vẫn type đúng engine; tiếng Việt; bám tài liệu.\n"
    )
