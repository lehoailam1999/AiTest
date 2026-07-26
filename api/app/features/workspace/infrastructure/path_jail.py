"""Path jail — resolve realpath and ensure under workspace root."""

from __future__ import annotations

import os
from pathlib import Path

from app.features.workspace.domain.errors import InvalidRootPath, PathOutsideRoot


def normalize_root(root_path: str) -> Path:
    raw = (root_path or "").strip()
    if not raw or "\x00" in raw:
        raise InvalidRootPath(raw or "(empty)", "empty or invalid root path")
    try:
        root = Path(raw).expanduser().resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise InvalidRootPath(raw, f"cannot resolve root ({exc})") from exc
    if not root.is_dir():
        raise InvalidRootPath(str(root), "root is not a directory")
    return root


def resolve_under_root(root: Path, rel_or_abs: str) -> Path:
    """Resolve a user-supplied path and ensure it stays under root."""
    if not rel_or_abs or "\x00" in rel_or_abs:
        raise PathOutsideRoot(rel_or_abs or "(empty)")
    candidate = Path(rel_or_abs)
    if not candidate.is_absolute():
        candidate = root / candidate
    try:
        resolved = candidate.resolve(strict=False)
    except (OSError, RuntimeError) as exc:
        raise PathOutsideRoot(rel_or_abs) from exc

    root_resolved = root.resolve(strict=False)
    try:
        resolved.relative_to(root_resolved)
    except ValueError as exc:
        # Windows: compare normalized case-insensitive strings
        r = os.path.normcase(str(resolved))
        base = os.path.normcase(str(root_resolved))
        if not (r == base or r.startswith(base + os.sep)):
            raise PathOutsideRoot(rel_or_abs) from exc
    return resolved


def to_relative(root: Path, absolute: Path) -> str:
    rel = absolute.resolve(strict=False).relative_to(root.resolve(strict=False))
    return rel.as_posix()
