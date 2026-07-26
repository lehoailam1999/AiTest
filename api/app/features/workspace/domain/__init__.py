"""Domain package."""

from app.features.workspace.domain.errors import (
    FileTooLarge,
    InvalidRootPath,
    PathOutsideRoot,
    ScanFailed,
    WorkspaceError,
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

__all__ = [
    "FileMeta",
    "FileReadResult",
    "FileTooLarge",
    "InvalidRootPath",
    "PathOutsideRoot",
    "ScanFailed",
    "SearchQuery",
    "WorkspaceError",
    "WorkspaceNotFound",
    "WorkspaceNotReady",
    "WorkspaceSession",
    "WorkspaceState",
    "WorkspaceStatus",
]
