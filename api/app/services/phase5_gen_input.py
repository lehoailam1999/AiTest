"""Phase 5 — optional generate body extras (planner / contextFiles / indexVersion).

All fields are additive: missing or invalid values are ignored so legacy clients
(POST body with only packet / sourceCode) keep working unchanged.
"""

from __future__ import annotations

import json
from typing import Any


def parse_planner(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict) or not raw:
        return None
    return raw


def parse_context_files(raw: Any) -> list[tuple[str, str]]:
    """Return [(path, content), ...] from body.contextFiles."""
    if not isinstance(raw, list):
        return []
    out: list[tuple[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        path = str(item.get("path") or item.get("pathRel") or "").strip()
        content = item.get("content")
        if not path or content is None:
            continue
        out.append((path, str(content)))
    return out


def parse_index_version(raw: Any) -> str:
    if raw is None:
        return ""
    return str(raw).strip()


def merge_related_from_context_files(
    related: list[tuple[str, str]],
    context_files: list[tuple[str, str]],
    *,
    primary_path: str = "",
) -> list[tuple[str, str]]:
    """Use contextFiles as related only when related is empty (packet/workspace win)."""
    if related or not context_files:
        return related
    primary = (primary_path or "").replace("\\", "/").lstrip("./")
    out: list[tuple[str, str]] = []
    for path, content in context_files:
        p = path.replace("\\", "/").lstrip("./")
        if primary and p == primary:
            continue
        out.append((path, content))
    return out


def format_unit_planner_hint(planner: dict[str, Any] | None) -> str:
    """Compact AAA guidance for unit_user_prompt (empty if no planner)."""
    if not planner:
        return ""
    test_type = str(planner.get("testType") or planner.get("test_type") or "Unit").strip()
    module = str(planner.get("module") or "").strip()
    action = str(planner.get("action") or "").strip()
    keywords = planner.get("keywords") or []
    if isinstance(keywords, list):
        kw = ", ".join(str(k) for k in keywords[:12] if k)
    else:
        kw = str(keywords).strip()
    hints = planner.get("hints") if isinstance(planner.get("hints"), dict) else {}
    fw = str((hints or {}).get("framework") or "").strip()
    lines = [
        "## Generation plan (Phase 5 — Mock → Arrange → Act → Assert)",
        f"testType: {test_type or 'Unit'}",
    ]
    if module:
        lines.append(f"module: {module}")
    if action:
        lines.append(f"action: {action}")
    if kw:
        lines.append(f"keywords: {kw}")
    if fw:
        lines.append(f"framework hint: {fw}")
    lines.append(
        "Emit one focused unit test: Mock only external deps proven in Related/SUT, "
        "then Arrange → Act → Assert using the Testing stack above. "
        "Do not invent APIs; prefer public surface of the source under test."
    )
    return "\n".join(lines) + "\n"


def format_e2e_planner_hint(planner: dict[str, Any] | None) -> str:
    """Compact Fixture→…→Cleanup guidance for e2e_user_prompt."""
    if not planner:
        return ""
    test_type = str(planner.get("testType") or planner.get("test_type") or "E2E").strip()
    module = str(planner.get("module") or "").strip()
    action = str(planner.get("action") or "").strip()
    keywords = planner.get("keywords") or []
    if isinstance(keywords, list):
        kw = ", ".join(str(k) for k in keywords[:12] if k)
    else:
        kw = str(keywords).strip()
    hints = planner.get("hints") if isinstance(planner.get("hints"), dict) else {}
    feature_path = str((hints or {}).get("featurePath") or "").strip()
    lines = [
        "## Generation plan (Phase 5 — Fixture → Locator → Action → Assertion → Cleanup)",
        f"testType: {test_type or 'E2E'}",
    ]
    if module:
        lines.append(f"module: {module}")
    if action:
        lines.append(f"action: {action}")
    if kw:
        lines.append(f"keywords: {kw}")
    if feature_path:
        lines.append(f"featurePath hint: {feature_path}")
    lines.append(
        "Follow E2ECG: ground locators in FE/DOM contract; map TC steps to POM methods; "
        "assert business outcomes; cleanup only what the test created."
    )
    return "\n".join(lines) + "\n"


def planner_as_json_fragment(planner: dict[str, Any] | None) -> str:
    """Optional debug-sized JSON (bounded)."""
    if not planner:
        return ""
    try:
        return json.dumps(planner, ensure_ascii=False)[:1500]
    except (TypeError, ValueError):
        return ""
