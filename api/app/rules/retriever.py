"""Rule retrieval helpers (Phase 2 MVP).

MVP scope:
- profile-driven selection by tags/priority/budget
- deterministic ordering
- returns concatenated rule text for prompt injection
"""

from __future__ import annotations

from typing import Any

from app.rules.profiles import RULE_PROFILES
from app.rules.registry_loader import load_rule_registry, resolve_rule_content

_PRIORITY_SCORE = {"required": 0, "recommended": 1, "optional": 2}


def _row_tags(row: dict[str, Any]) -> set[str]:
    tags = row.get("tags")
    if not isinstance(tags, list):
        return set()
    return {str(t).strip().lower() for t in tags if str(t).strip()}


def _row_priority(row: dict[str, Any]) -> str:
    return str(row.get("priority") or "optional").strip().lower()


def _matches_profile(row: dict[str, Any], profile_id: str) -> bool:
    profile = RULE_PROFILES.get(profile_id)
    if not profile:
        return False
    domains = {d.lower() for d in profile.get("domains", ())}
    row_domain = str(row.get("domain") or "").strip().lower()
    if domains and row_domain not in domains:
        return False
    tags = _row_tags(row)
    required = {t.lower() for t in profile["required_tags"]}
    optional = {t.lower() for t in profile["optional_tags"]}
    exclude = {t.lower() for t in profile["exclude_tags"]}
    if tags & exclude:
        return False
    if required and not required.issubset(tags):
        return False
    return bool(tags & (required | optional))


def retrieve_rule_rows(profile_id: str) -> list[dict[str, Any]]:
    profile = RULE_PROFILES.get(profile_id)
    if not profile:
        return []
    rows = load_rule_registry().get("rules", [])
    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        if not _matches_profile(row, profile_id):
            continue
        content = resolve_rule_content(row)
        if not content:
            continue
        out.append(row)
    out.sort(
        key=lambda r: (
            _PRIORITY_SCORE.get(_row_priority(r), 9),
            str(r.get("id") or ""),
        )
    )
    return out


def render_rules_for_profile(profile_id: str) -> str:
    profile = RULE_PROFILES.get(profile_id)
    if not profile:
        return ""
    budget = int(profile.get("max_chars_budget") or 0)
    rows = retrieve_rule_rows(profile_id)
    if not rows:
        return ""
    blocks: list[str] = []
    used = 0
    for row in rows:
        txt = resolve_rule_content(row)
        if not txt:
            continue
        delta = len(txt) + (2 if blocks else 0)
        if budget > 0 and used + delta > budget:
            # keep required rows even when they overflow (MVP safety)
            if _row_priority(row) != "required":
                continue
        blocks.append(txt)
        used += delta
    return "\n\n".join(blocks).strip()


def render_rules_for_profile_with_meta(profile_id: str) -> tuple[str, list[str], int]:
    """Return rendered text + selected rule IDs + char count."""
    profile = RULE_PROFILES.get(profile_id)
    if not profile:
        return "", [], 0
    budget = int(profile.get("max_chars_budget") or 0)
    rows = retrieve_rule_rows(profile_id)
    if not rows:
        return "", [], 0
    blocks: list[str] = []
    ids: list[str] = []
    used = 0
    for row in rows:
        txt = resolve_rule_content(row)
        if not txt:
            continue
        delta = len(txt) + (2 if blocks else 0)
        if budget > 0 and used + delta > budget:
            if _row_priority(row) != "required":
                continue
        blocks.append(txt)
        ids.append(str(row.get("id") or ""))
        used += delta
    text = "\n\n".join(blocks).strip()
    return text, ids, len(text)

