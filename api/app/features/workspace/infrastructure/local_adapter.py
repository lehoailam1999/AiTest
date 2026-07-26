"""Local disk implementation of WorkspacePort."""

from __future__ import annotations

import logging
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from app.features.workspace.domain.errors import (
    ScanFailed,
    WorkspaceNotFound,
    WorkspaceNotReady,
)
from app.features.workspace.domain.models import (
    FileMeta,
    FileReadResult,
    SearchQuery,
    WorkspaceSession,
    WorkspaceState,
    WorkspaceStatus,
)
from app.features.workspace.infrastructure.file_reader import SafeFileReader
from app.features.workspace.infrastructure.file_searcher import FileSearcher
from app.features.workspace.infrastructure.memory_index import MemorySessionIndex
from app.features.workspace.infrastructure.path_jail import normalize_root
from app.features.workspace.infrastructure.scanner import WorkspaceScanner
from app.features.workspace.infrastructure.sqlite_cache import SqliteWorkspaceCache
from app.features.workspace.infrastructure.watcher import WorkspaceWatcher

logger = logging.getLogger(__name__)


class LocalDiskWorkspaceAdapter:
    def __init__(
        self,
        cache: SqliteWorkspaceCache,
        memory: MemorySessionIndex,
        scanner: WorkspaceScanner | None = None,
        *,
        enable_watcher: bool = False,
    ):
        self.cache = cache
        self.memory = memory
        self.scanner = scanner or WorkspaceScanner()
        self.searcher = FileSearcher(cache, memory)
        self._sessions: dict[str, WorkspaceSession] = {}
        self._project_active: dict[str, str] = {}  # project_id -> workspace_id
        self._lock = threading.RLock()
        self._watcher: WorkspaceWatcher | None = None
        if enable_watcher:
            self._watcher = WorkspaceWatcher()

    def open(self, project_id: str, root_path: str) -> WorkspaceSession:
        root = normalize_root(root_path)
        with self._lock:
            # close previous active for same project
            old_id = self._project_active.get(project_id)
            if old_id and old_id in self._sessions:
                self._sessions[old_id].status = WorkspaceState.CLOSED
            workspace_id = str(uuid.uuid4())
            session = WorkspaceSession(
                workspace_id=workspace_id,
                project_id=project_id,
                root_path=str(root),
                status=WorkspaceState.INDEXING,
                opened_at=datetime.now(timezone.utc),
                progress=0.0,
            )
            self._sessions[workspace_id] = session
            self._project_active[project_id] = workspace_id

        t = threading.Thread(
            target=self._run_scan,
            args=(workspace_id, root, False),
            name=f"ws-scan-{workspace_id[:8]}",
            daemon=True,
        )
        t.start()
        return session

    def get_session(self, workspace_id: str) -> WorkspaceSession | None:
        with self._lock:
            return self._sessions.get(workspace_id)

    def get_status(self, workspace_id: str) -> WorkspaceStatus | None:
        s = self.get_session(workspace_id)
        if s is None:
            return None
        return WorkspaceStatus(
            workspace_id=s.workspace_id,
            status=s.status,
            file_count=s.file_count,
            progress=s.progress,
            error_message=s.error_message,
        )

    def close(self, workspace_id: str) -> None:
        with self._lock:
            s = self._sessions.get(workspace_id)
            if s is None:
                raise WorkspaceNotFound(workspace_id)
            s.status = WorkspaceState.CLOSED
            if self._project_active.get(s.project_id) == workspace_id:
                self._project_active.pop(s.project_id, None)
        self.memory.clear(workspace_id)
        if self._watcher:
            self._watcher.stop(workspace_id)

    def refresh(self, workspace_id: str, *, full: bool = False) -> WorkspaceSession:
        s = self.get_session(workspace_id)
        if s is None:
            raise WorkspaceNotFound(workspace_id)
        if s.status == WorkspaceState.CLOSED:
            raise WorkspaceNotReady(workspace_id, s.status.value)
        root = Path(s.root_path)
        with self._lock:
            s.status = WorkspaceState.INDEXING
            s.progress = 0.0
            s.error_message = None
            s.scan_generation += 1
        t = threading.Thread(
            target=self._run_scan,
            args=(workspace_id, root, not full),
            name=f"ws-refresh-{workspace_id[:8]}",
            daemon=True,
        )
        t.start()
        return s

    def list_files(
        self,
        workspace_id: str,
        *,
        ext: str | None = None,
        q: str | None = None,
        limit: int = 100,
        cursor: int = 0,
    ) -> tuple[list[FileMeta], int]:
        self._require_ready_or_indexing(workspace_id)
        return self.cache.list_files(
            workspace_id, ext=ext, q=q, limit=limit, cursor=cursor
        )

    def search(self, workspace_id: str, query: SearchQuery) -> list[FileMeta]:
        self._require_ready_or_indexing(workspace_id)
        return self.searcher.search(workspace_id, query)

    def read_files(
        self,
        workspace_id: str,
        paths: list[str],
        *,
        max_bytes_per_file: int = 512_000,
    ) -> list[FileReadResult]:
        s = self.get_session(workspace_id)
        if s is None:
            raise WorkspaceNotFound(workspace_id)
        if s.status == WorkspaceState.CLOSED:
            raise WorkspaceNotReady(workspace_id, s.status.value)
        reader = SafeFileReader(Path(s.root_path))
        return reader.read_many(paths, max_bytes_per_file=max_bytes_per_file)

    def _require_ready_or_indexing(self, workspace_id: str) -> WorkspaceSession:
        s = self.get_session(workspace_id)
        if s is None:
            raise WorkspaceNotFound(workspace_id)
        if s.status == WorkspaceState.CLOSED:
            raise WorkspaceNotReady(workspace_id, s.status.value)
        return s

    def _run_scan(self, workspace_id: str, root: Path, incremental: bool) -> None:
        try:

            def on_progress(count: int, progress: float) -> None:
                with self._lock:
                    s = self._sessions.get(workspace_id)
                    if s and s.status == WorkspaceState.INDEXING:
                        s.file_count = count
                        s.progress = progress

            files = self.scanner.scan(root, workspace_id, on_progress=on_progress)
            if incremental:
                # Keep unchanged meta_hash rows from previous index when possible
                old = {
                    f.relative_path: f
                    for f in self.memory.all(workspace_id)
                }
                if old:
                    merged: list = []
                    for f in files:
                        prev = old.get(f.relative_path)
                        if prev and prev.meta_hash == f.meta_hash:
                            merged.append(prev)
                        else:
                            merged.append(f)
                    files = merged
            self.cache.replace_files(workspace_id, files)
            self.memory.replace(workspace_id, files)
            with self._lock:
                s = self._sessions.get(workspace_id)
                if s and s.status != WorkspaceState.CLOSED:
                    s.file_count = len(files)
                    s.progress = 1.0
                    s.status = WorkspaceState.READY
                    s.error_message = None
            if self._watcher:
                self._watcher.start(
                    workspace_id,
                    root,
                    on_change=lambda wid: self.refresh(wid, full=False),
                )
            logger.info(
                "workspace scan done id=%s files=%s root=%s",
                workspace_id,
                len(files),
                root,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("workspace scan failed id=%s", workspace_id)
            with self._lock:
                s = self._sessions.get(workspace_id)
                if s:
                    s.status = WorkspaceState.ERROR
                    s.error_message = str(exc)[:500]
                    s.progress = 0.0
            raise ScanFailed(str(exc)) from exc
