"""Workspace application service — use-case facade."""

from __future__ import annotations

import logging
from typing import Any

from app.features.workspace.domain.errors import WorkspaceError
from app.features.workspace.domain.models import SearchQuery, WorkspaceSession
from app.features.workspace.infrastructure.context_builder import BuiltContext, ContextBuilder
from app.ports.workspace import WorkspacePort

logger = logging.getLogger(__name__)


class WorkspaceApplicationService:
    def __init__(self, port: WorkspacePort):
        self.port = port
        self.context_builder = ContextBuilder(port)

    def open(self, project_id: str, root_path: str) -> WorkspaceSession:
        logger.info("workspace.open project=%s root=%s", project_id, root_path)
        return self.port.open(project_id, root_path)

    def get(self, workspace_id: str) -> WorkspaceSession | None:
        return self.port.get_session(workspace_id)

    def active_workspace_for_project(self, project_id: str) -> WorkspaceSession | None:
        getter = getattr(self.port, "get_active_workspace_id", None)
        if not callable(getter):
            return None
        wid = getter(project_id)
        if not wid:
            return None
        return self.port.get_session(wid)

    def status(self, workspace_id: str) -> dict[str, Any] | None:
        st = self.port.get_status(workspace_id)
        return st.to_dict() if st else None

    def close(self, workspace_id: str) -> None:
        self.port.close(workspace_id)

    def refresh(self, workspace_id: str, *, full: bool = False) -> WorkspaceSession:
        return self.port.refresh(workspace_id, full=full)

    def list_files(
        self,
        workspace_id: str,
        *,
        ext: str | None = None,
        q: str | None = None,
        limit: int = 100,
        cursor: int = 0,
    ) -> dict[str, Any]:
        items, total = self.port.list_files(
            workspace_id, ext=ext, q=q, limit=limit, cursor=cursor
        )
        return {
            "items": [i.to_dict() for i in items],
            "totalCount": total,
            "limit": limit,
            "cursor": cursor,
        }

    def search(self, workspace_id: str, body: dict[str, Any]) -> dict[str, Any]:
        q = SearchQuery(
            by=str(body.get("by") or "name"),
            query=str(body.get("query") or ""),
            limit=int(body.get("limit") or 50),
        )
        items = self.port.search(workspace_id, q)
        return {"items": [i.to_dict() for i in items]}

    def read(self, workspace_id: str, body: dict[str, Any]) -> dict[str, Any]:
        paths = body.get("paths") or []
        if not isinstance(paths, list):
            raise WorkspaceError("paths must be an array", code="invalid_paths")
        max_bytes = int(body.get("maxBytesPerFile") or 512_000)
        results = self.port.read_files(
            workspace_id,
            [str(p) for p in paths],
            max_bytes_per_file=max_bytes,
        )
        return {"files": [r.to_dict() for r in results]}

    def build_context(
        self,
        workspace_id: str,
        tokens: list[str],
        *,
        max_related: int = 12,
    ) -> BuiltContext:
        return self.context_builder.build_for_tokens(
            workspace_id, tokens, max_related=max_related
        )
