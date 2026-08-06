"""Rule registry loader (Phase 1).

Reads rule blocks from ``rule_registry.yaml`` with safe fallback behavior.
The file currently uses JSON syntax (valid YAML subset) to avoid extra deps.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parent
_REGISTRY_PATH = _ROOT / "rule_registry.yaml"


class RuleRegistryError(RuntimeError):
    """Raised when rule registry content is invalid."""


def _parse_registry_text(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if not text:
        raise RuleRegistryError("Rule registry is empty")
    # JSON is a valid subset of YAML and keeps stdlib-only parsing.
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuleRegistryError(f"Invalid registry JSON/YAML subset: {exc}") from exc
    if not isinstance(data, dict):
        raise RuleRegistryError("Rule registry root must be an object")
    return data


def _validate_registry(data: dict[str, Any]) -> dict[str, Any]:
    rules = data.get("rules")
    if not isinstance(rules, list):
        raise RuleRegistryError("Rule registry must contain 'rules' list")
    seen: set[str] = set()
    for row in rules:
        if not isinstance(row, dict):
            raise RuleRegistryError("Each rule item must be an object")
        rid = str(row.get("id") or "").strip()
        content = row.get("content")
        content_file = str(row.get("content_file") or "").strip()
        if not rid:
            raise RuleRegistryError("Rule item missing id")
        if rid in seen:
            raise RuleRegistryError(f"Duplicate rule id: {rid}")
        seen.add(rid)
        has_inline = isinstance(content, str) and bool(content.strip())
        has_file = bool(content_file)
        if not has_inline and not has_file:
            raise RuleRegistryError(
                f"Rule '{rid}' must define either content or content_file"
            )
        if has_file:
            ref = (_ROOT / content_file).resolve()
            if not ref.is_file():
                raise RuleRegistryError(
                    f"Rule '{rid}' content_file does not exist: {content_file}"
                )
    return data


@lru_cache(maxsize=1)
def load_rule_registry() -> dict[str, Any]:
    raw = _REGISTRY_PATH.read_text(encoding="utf-8")
    data = _parse_registry_text(raw)
    return _validate_registry(data)


def invalidate_rule_registry_cache() -> None:
    load_rule_registry.cache_clear()


def resolve_rule_content(row: dict[str, Any]) -> str:
    content = row.get("content")
    if isinstance(content, str) and content.strip():
        return content.strip()
    content_file = str(row.get("content_file") or "").strip()
    if content_file:
        ref = (_ROOT / content_file).resolve()
        try:
            return ref.read_text(encoding="utf-8").strip()
        except Exception:
            return ""
    return ""


def get_rule_text(rule_id: str, *, fallback: str = "") -> str:
    rid = (rule_id or "").strip()
    if not rid:
        return fallback
    try:
        data = load_rule_registry()
    except Exception:
        return fallback
    for row in data.get("rules", []):
        if str(row.get("id") or "").strip() == rid:
            content = resolve_rule_content(row)
            return content or fallback
    return fallback

