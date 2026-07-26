"""Walk project tree — emit FileMeta only (no content)."""

from __future__ import annotations

import logging
import os
from collections.abc import Callable, Iterator
from pathlib import Path

from app.features.workspace.domain.models import FileMeta
from app.features.workspace.infrastructure.directory_filter import DirectoryFilter
from app.features.workspace.infrastructure.gitignore import GitIgnoreMatcher
from app.features.workspace.infrastructure.hash_service import FileHashService
from app.features.workspace.infrastructure.language_detector import LanguageDetector
from app.features.workspace.infrastructure.path_jail import to_relative

logger = logging.getLogger(__name__)


class WorkspaceScanner:
    def __init__(
        self,
        *,
        language_detector: LanguageDetector | None = None,
        hash_service: FileHashService | None = None,
        max_files: int = 200_000,
    ):
        self.languages = language_detector or LanguageDetector()
        self.hashes = hash_service or FileHashService()
        self.max_files = max_files

    def scan(
        self,
        root: Path,
        workspace_id: str,
        *,
        on_progress: Callable[[int, float], None] | None = None,
        source_exts_only: bool = False,
    ) -> list[FileMeta]:
        gitignore = GitIgnoreMatcher.from_root(root)
        filt = DirectoryFilter(root, gitignore=gitignore)
        results: list[FileMeta] = []
        seen = 0
        # rough progress: count visited dirs
        for meta in self._walk(root, workspace_id, filt, source_exts_only=source_exts_only):
            results.append(meta)
            seen += 1
            if on_progress and seen % 200 == 0:
                on_progress(seen, min(0.95, seen / max(self.max_files, 1)))
            if seen >= self.max_files:
                logger.warning("workspace scan hit max_files=%s", self.max_files)
                break
        if on_progress:
            on_progress(len(results), 1.0)
        return results

    def _walk(
        self,
        root: Path,
        workspace_id: str,
        filt: DirectoryFilter,
        *,
        source_exts_only: bool,
    ) -> Iterator[FileMeta]:
        # os.walk is faster than Path.rglob for large trees; prune dirs in-place
        root_s = str(root)
        for dirpath, dirnames, filenames in os.walk(root_s, topdown=True, followlinks=False):
            base = Path(dirpath)
            # prune
            keep: list[str] = []
            for name in dirnames:
                child = base / name
                if filt.should_skip_dir(child, name):
                    continue
                keep.append(name)
            dirnames[:] = keep

            for fname in filenames:
                fpath = base / fname
                if filt.should_skip_file(fpath):
                    continue
                ext = fpath.suffix.lower()
                if source_exts_only and not self.languages.is_source_ext(ext):
                    continue
                try:
                    st = fpath.stat()
                except OSError:
                    continue
                if not os.path.isfile(fpath):
                    continue
                try:
                    rel = to_relative(root, fpath)
                except ValueError:
                    continue
                yield FileMeta(
                    workspace_id=workspace_id,
                    path=str(fpath.resolve(strict=False)),
                    relative_path=rel,
                    extension=ext,
                    language=self.languages.detect(ext or fpath.name),
                    size=int(st.st_size),
                    last_modified=float(st.st_mtime),
                    meta_hash=self.hashes.meta_hash(int(st.st_size), float(st.st_mtime)),
                )
