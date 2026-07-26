"""Fast metadata hash (size|mtime) — no content read by default."""

from __future__ import annotations

import hashlib
from pathlib import Path


class FileHashService:
    def meta_hash(self, size: int, mtime: float) -> str:
        return f"{size}|{mtime:.6f}"

    def content_hash(self, path: Path, *, max_bytes: int = 2_000_000) -> str | None:
        """Optional lazy content hash (xxhash-like via blake2b truncated)."""
        try:
            h = hashlib.blake2b(digest_size=16)
            with path.open("rb") as f:
                remaining = max_bytes
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    h.update(chunk)
                    remaining -= len(chunk)
            return h.hexdigest()
        except OSError:
            return None
