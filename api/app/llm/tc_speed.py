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
    engine default.
    - E2E default: **fast** (wall-clock).
    - Unit default: **full** (preserve analysis coverage by default).
    ``fast`` = shorter prompts + anti-bloat; E2E still covers Output signals (soft cap).
    """
    hint = engine_hint if isinstance(engine_hint, dict) else {}
    raw = str(hint.get("speed") or "").strip().lower()
    if raw in ("fast", "full"):
        return raw

    eng = (preferred_engine or "").strip().lower()
    if eng == "e2e":
        env = (os.environ.get("AITEST_TC_E2E_SPEED") or "fast").strip().lower()
        return "full" if env in ("full", "complete") else "fast"
    if eng == "unit":
        env = (os.environ.get("AITEST_TC_UNIT_SPEED") or "full").strip().lower()
        return "full" if env in ("full", "complete") else "fast"
    return "fast"


def resolve_max_tc_per_module(
    preferred_engine: str | None,
    speed: str,
    engine_hint: dict[str, Any] | None = None,
) -> int | None:
    """
    Optional numeric ceiling.

    E2E speed=fast: soft default 10/module (AITEST_TC_E2E_FAST_MAX_PER_MODULE;
    set 0 to disable). Explicit maxPerModule / AITEST_TC_E2E_MAX_PER_MODULE win.
    E2E speed=full: no default ceiling (signal-driven) unless env/hint set.

    Unit: no implicit default ceiling (signal-driven). Cap only when explicitly
    set via hint/env.
    """
    hint = engine_hint if isinstance(engine_hint, dict) else {}
    eng = (preferred_engine or "").strip().lower()

    # Explicit hint always wins (any engine / speed)
    for key in ("maxPerModule", "maxTcPerModule"):
        if hint.get(key) is not None:
            try:
                n = int(hint[key])
                return max(2, min(40, n))
            except (TypeError, ValueError):
                pass

    if eng == "e2e":
        # Opt-in hard env always applies
        raw = (os.environ.get("AITEST_TC_E2E_MAX_PER_MODULE") or "").strip()
        if raw:
            try:
                return max(2, min(40, int(raw)))
            except ValueError:
                pass
        if (speed or "").strip().lower() == "fast":
            fast_cap = (os.environ.get("AITEST_TC_E2E_FAST_MAX_PER_MODULE") or "10").strip()
            if fast_cap in ("", "0", "none", "off"):
                return None
            try:
                return max(2, min(40, int(fast_cap)))
            except ValueError:
                return 10
        return None

    if (speed or "").strip().lower() != "fast":
        return None

    env_key = (
        "AITEST_TC_UNIT_MAX_PER_MODULE"
        if eng == "unit"
        else "AITEST_TC_MAX_PER_MODULE"
    )
    default = ""
    try:
        raw = (os.environ.get(env_key) or default).strip()
        if not raw:
            return None
        n = int(raw)
    except ValueError:
        return None
    return max(2, min(40, n))


def knowledge_enough_skip_source_scan(
    bundle: dict[str, Any] | None,
    preferred_engine: str | None,
) -> bool:
    """
    Skip workspace file scan when freeze Knowledge already has enough signals.

    - E2E: UI/AC/rule signals (override AITEST_TC_E2E_FORCE_SOURCE_SCAN=1 to always scan)
    - Unit: **never** skip for "Knowledge đủ" — Unit TCs must see Handler/Service excerpts.
      Opt out of scan only with AITEST_TC_UNIT_SKIP_SOURCE_SCAN=1.
    """
    eng = (preferred_engine or "").strip().lower()
    if eng == "e2e":
        if _env_truthy("AITEST_TC_E2E_FORCE_SOURCE_SCAN"):
            return False
    elif eng == "unit":
        # Unit must ground reject/validate/persist on real SUT excerpts.
        # Skip only when explicitly opted out (debug / no workspace).
        return _env_truthy("AITEST_TC_UNIT_SKIP_SOURCE_SCAN")
    else:
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
    if eng == "e2e":
        signals = (
            _len("acceptanceCriteria")
            + _len("validationRules")
            + _len("businessRules")
            + _len("actors")
        )
        return modules >= 1 and signals >= 3

    return False


def resolve_fanout_batch_size(*, is_cursor: bool) -> int:
    """
    How many modules to pack into one LLM call (Phase C).
    Default 3 — fewer Cursor cold starts; 1 = one-module-per-call.
    """
    env_key = (
        "AITEST_TC_FANOUT_BATCH_MODULES_CURSOR"
        if is_cursor
        else "AITEST_TC_FANOUT_BATCH_MODULES"
    )
    try:
        n = int(os.environ.get(env_key, "3"))
    except ValueError:
        n = 3
    return max(1, min(4, n))


def speed_prompt_addon(
    *,
    speed: str,
    max_per_module: int | None,
    preferred_engine: str | None = None,
) -> str:
    """Extra system/user lines for fast / anti-bloat (E2E never invents a default N)."""
    eng = (preferred_engine or "").strip().lower()
    is_fast = (speed or "").strip().lower() == "fast"

    if eng == "e2e":
        lines = [
            "\nE2E COVERAGE = tín hiệu Output (không trần số TC cố định):",
            "- Mọi item FEATURES/FLOWS/BR/VALIDATION/AC/ERROR/(ACTORS RBAC)/EXEC_CONTEXT → ≥1 TC.",
            "- Cấm thừa: trùng `trace:`, cùng journey+expected chỉ đổi wording, pad checklist giả.",
            "- 1 tín hiệu chính / 1 TC; expected 1–3 assert observable.",
        ]
        if max_per_module:
            lines.append(
                f"- Trần tùy chọn ≤{max_per_module}: chỉ bỏ journey phụ/trùng assert — "
                "KHÔNG bỏ lớp bắt buộc có tín hiệu."
            )
        elif is_fast:
            lines.append(
                "- SPEED=fast: prompt gọn + ưu tiên Cao/Nghiêm trọng trước — vẫn đủ lớp bắt buộc."
            )
        return "\n".join(lines) + "\n"

    if not is_fast or not max_per_module:
        return ""
    return (
        f"\nSPEED MODE=fast (trần mềm ≤{max_per_module} TC/module):\n"
        f"- Ưu tiên: 1 happy + validation/negative quan trọng + 1 permission/boundary "
        f"nếu có tín hiệu — tối đa {max_per_module} TC.\n"
        f"- Không pad checklist; tiếng Việt; bám tài liệu.\n"
    )
