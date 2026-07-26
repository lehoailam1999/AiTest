"""Lightweight import/dependency hints from relative paths (no AST day-1)."""

from __future__ import annotations

import re

# Heuristic: file name tokens that often appear in import lines
_IMPORTISH = re.compile(
    r"(?:^|[/\\])([A-Za-z_][\w]*)\.(?:cs|ts|tsx|js|jsx|py|java|go|rs)$",
    re.I,
)


def stems_from_paths(paths: list[str], *, limit: int = 40) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for p in paths:
        m = _IMPORTISH.search(p.replace("\\", "/"))
        if not m:
            continue
        stem = m.group(1)
        key = stem.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(stem)
        if len(out) >= limit:
            break
    return out
