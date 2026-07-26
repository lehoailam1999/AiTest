"""DI wiring for workspace feature."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from app.config import get_settings
from app.features.workspace.application import WorkspaceApplicationService
from app.features.workspace.infrastructure.local_adapter import LocalDiskWorkspaceAdapter
from app.features.workspace.infrastructure.memory_index import MemorySessionIndex
from app.features.workspace.infrastructure.scanner import WorkspaceScanner
from app.features.workspace.infrastructure.sqlite_cache import SqliteWorkspaceCache


def _workspace_db_path() -> Path:
    settings = get_settings()
    raw = getattr(settings, "workspace_meta_db", None)
    if raw:
        return Path(str(raw))
    # default: api/.aitest_workspace/meta.db (beside process cwd)
    return Path.cwd() / ".aitest_workspace" / "meta.db"


@lru_cache
def get_workspace_adapter() -> LocalDiskWorkspaceAdapter:
    cache = SqliteWorkspaceCache(_workspace_db_path())
    memory = MemorySessionIndex()
    enable_watcher = bool(getattr(get_settings(), "workspace_enable_watcher", False))
    return LocalDiskWorkspaceAdapter(
        cache=cache,
        memory=memory,
        scanner=WorkspaceScanner(),
        enable_watcher=enable_watcher,
    )


@lru_cache
def get_workspace_service() -> WorkspaceApplicationService:
    return WorkspaceApplicationService(get_workspace_adapter())
