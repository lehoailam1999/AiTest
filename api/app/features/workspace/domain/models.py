"""Workspace domain models — metadata only, never source content."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any


class WorkspaceState(str, Enum):
    INDEXING = "indexing"
    READY = "ready"
    ERROR = "error"
    CLOSED = "closed"


@dataclass
class FileMeta:
    workspace_id: str
    path: str
    relative_path: str
    extension: str
    language: str
    size: int
    last_modified: float  # unix mtime
    meta_hash: str  # size|mtime key — not content hash by default

    def to_dict(self) -> dict[str, Any]:
        return {
            "workspaceId": self.workspace_id,
            "path": self.path,
            "relativePath": self.relative_path,
            "extension": self.extension,
            "language": self.language,
            "size": self.size,
            "lastModified": self.last_modified,
            "hash": self.meta_hash,
        }


@dataclass
class WorkspaceSession:
    workspace_id: str
    project_id: str
    root_path: str
    status: WorkspaceState
    opened_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    file_count: int = 0
    progress: float = 0.0  # 0..1
    error_message: str | None = None
    scan_generation: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "workspaceId": self.workspace_id,
            "projectId": self.project_id,
            "rootPath": self.root_path,
            "status": self.status.value,
            "openedAt": self.opened_at.isoformat(),
            "fileCount": self.file_count,
            "progress": self.progress,
            "errorMessage": self.error_message,
            "scanGeneration": self.scan_generation,
        }


@dataclass
class WorkspaceStatus:
    workspace_id: str
    status: WorkspaceState
    file_count: int
    progress: float
    error_message: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "workspaceId": self.workspace_id,
            "status": self.status.value,
            "fileCount": self.file_count,
            "progress": self.progress,
            "errorMessage": self.error_message,
        }


@dataclass
class SearchQuery:
    by: str = "name"  # name | ext | token | keyword
    query: str = ""
    limit: int = 50


@dataclass
class FileReadResult:
    relative_path: str
    content: str
    truncated: bool = False
    size: int = 0
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "relativePath": self.relative_path,
            "content": self.content,
            "truncated": self.truncated,
            "size": self.size,
            "error": self.error,
        }
