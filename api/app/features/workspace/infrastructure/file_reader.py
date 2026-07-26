"""Safe file reader — path jail + size limits. No preload."""

from __future__ import annotations

from pathlib import Path

from app.features.workspace.domain.errors import FileTooLarge, PathOutsideRoot
from app.features.workspace.domain.models import FileReadResult
from app.features.workspace.infrastructure.path_jail import resolve_under_root, to_relative


class SafeFileReader:
    DEFAULT_MAX_BYTES = 512_000

    def __init__(self, root: Path):
        self.root = root

    def read(
        self,
        rel_or_abs: str,
        *,
        max_bytes: int | None = None,
    ) -> FileReadResult:
        limit = max_bytes if max_bytes is not None else self.DEFAULT_MAX_BYTES
        try:
            path = resolve_under_root(self.root, rel_or_abs)
        except PathOutsideRoot as exc:
            return FileReadResult(
                relative_path=rel_or_abs.replace("\\", "/"),
                content="",
                error=str(exc),
            )
        rel = to_relative(self.root, path)
        if not path.is_file():
            return FileReadResult(relative_path=rel, content="", error="not a file")
        try:
            size = path.stat().st_size
        except OSError as exc:
            return FileReadResult(relative_path=rel, content="", error=str(exc))
        if size > limit * 4:
            # refuse extremely large before read
            return FileReadResult(
                relative_path=rel,
                content="",
                size=size,
                error=f"file too large ({size} bytes)",
            )
        try:
            raw = path.read_bytes()
        except OSError as exc:
            return FileReadResult(relative_path=rel, content="", size=size, error=str(exc))
        truncated = False
        if len(raw) > limit:
            raw = raw[:limit]
            truncated = True
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("utf-8", errors="replace")
        if truncated:
            text += "\n/* …truncated… */"
        return FileReadResult(
            relative_path=rel,
            content=text,
            truncated=truncated,
            size=size,
        )

    def read_many(
        self,
        paths: list[str],
        *,
        max_bytes_per_file: int = DEFAULT_MAX_BYTES,
        max_files: int = 40,
    ) -> list[FileReadResult]:
        out: list[FileReadResult] = []
        for p in paths[:max_files]:
            out.append(self.read(p, max_bytes=max_bytes_per_file))
        return out
