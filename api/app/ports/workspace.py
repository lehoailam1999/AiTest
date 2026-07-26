"""WorkspacePort — disk I/O abstraction (Local Agent swap later)."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from app.features.workspace.domain.models import (
    FileMeta,
    FileReadResult,
    SearchQuery,
    WorkspaceSession,
    WorkspaceStatus,
)


@runtime_checkable
class WorkspacePort(Protocol):
    def open(self, project_id: str, root_path: str) -> WorkspaceSession:
        """Bind root path, create/reuse session, start metadata scan."""
        ...

    def get_session(self, workspace_id: str) -> WorkspaceSession | None: ...

    def get_status(self, workspace_id: str) -> WorkspaceStatus | None: ...

    def close(self, workspace_id: str) -> None: ...

    def refresh(self, workspace_id: str, *, full: bool = False) -> WorkspaceSession: ...

    def list_files(
        self,
        workspace_id: str,
        *,
        ext: str | None = None,
        q: str | None = None,
        limit: int = 100,
        cursor: int = 0,
    ) -> tuple[list[FileMeta], int]:
        """Return (items, total). Metadata only."""
        ...

    def search(self, workspace_id: str, query: SearchQuery) -> list[FileMeta]: ...

    def read_files(
        self,
        workspace_id: str,
        paths: list[str],
        *,
        max_bytes_per_file: int = 512_000,
    ) -> list[FileReadResult]:
        """Read text contents for paths under workspace root only."""
        ...
