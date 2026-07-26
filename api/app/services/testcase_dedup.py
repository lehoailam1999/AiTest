"""Detect duplicate test cases when re-generating for the same requirement."""

from __future__ import annotations

import re

_WS_RE = re.compile(r"\s+")


def _norm(text: str | None) -> str:
    return _WS_RE.sub(" ", (text or "").strip().lower())


def dup_key(title: str | None, steps: str | None) -> str:
    """Duplicate when normalized title + steps match."""
    return f"{_norm(title)}||{_norm(steps)}"


def title_key(title: str | None) -> str:
    return _norm(title)
