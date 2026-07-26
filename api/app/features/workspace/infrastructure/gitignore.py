"""Minimal .gitignore parser (root-level + common patterns)."""

from __future__ import annotations

import fnmatch
from pathlib import Path


class GitIgnoreMatcher:
    def __init__(self, patterns: list[str]):
        self._raw = [p.strip() for p in patterns if p.strip() and not p.strip().startswith("#")]

    @classmethod
    def from_root(cls, root: Path) -> GitIgnoreMatcher:
        gi = root / ".gitignore"
        if not gi.is_file():
            return cls([])
        try:
            text = gi.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return cls([])
        return cls(text.splitlines())

    def matches_file(self, path: Path, root: Path) -> bool:
        return self._match(path, root, is_dir=False)

    def matches_dir(self, path: Path, root: Path) -> bool:
        return self._match(path, root, is_dir=True)

    def _match(self, path: Path, root: Path, *, is_dir: bool) -> bool:
        try:
            rel = path.resolve(strict=False).relative_to(root.resolve(strict=False)).as_posix()
        except ValueError:
            return False
        name = path.name
        for pat in self._raw:
            negate = pat.startswith("!")
            p = pat[1:] if negate else pat
            p = p.strip()
            if not p:
                continue
            dir_only = p.endswith("/")
            if dir_only:
                p = p.rstrip("/")
                if not is_dir:
                    continue
            hit = False
            if "/" in p:
                hit = fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(rel, p + "/*")
            else:
                hit = fnmatch.fnmatch(name, p) or fnmatch.fnmatch(rel, "*/" + p)
            if hit:
                return not negate
        return False
