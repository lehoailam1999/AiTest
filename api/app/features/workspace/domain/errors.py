"""Workspace domain errors."""

from __future__ import annotations


class WorkspaceError(Exception):
    """Base workspace error."""

    def __init__(self, message: str, *, code: str = "workspace_error"):
        super().__init__(message)
        self.message = message
        self.code = code


class WorkspaceNotFound(WorkspaceError):
    def __init__(self, workspace_id: str):
        super().__init__(f"Workspace not found: {workspace_id}", code="workspace_not_found")
        self.workspace_id = workspace_id


class WorkspaceNotReady(WorkspaceError):
    def __init__(self, workspace_id: str, status: str):
        super().__init__(
            f"Workspace {workspace_id} not ready (status={status})",
            code="workspace_not_ready",
        )
        self.workspace_id = workspace_id
        self.status = status


class PathOutsideRoot(WorkspaceError):
    def __init__(self, path: str):
        super().__init__(f"Path outside workspace root: {path}", code="path_outside_root")
        self.path = path


class InvalidRootPath(WorkspaceError):
    def __init__(self, path: str, reason: str = "invalid root path"):
        super().__init__(f"{reason}: {path}", code="invalid_root_path")
        self.path = path


class FileTooLarge(WorkspaceError):
    def __init__(self, path: str, size: int, limit: int):
        super().__init__(
            f"File too large ({size} > {limit}): {path}",
            code="file_too_large",
        )
        self.path = path
        self.size = size
        self.limit = limit


class ScanFailed(WorkspaceError):
    def __init__(self, message: str):
        super().__init__(message, code="scan_failed")
