"""File searcher — name/ext/token/keyword over memory + SQLite."""

from __future__ import annotations

from app.features.workspace.domain.models import FileMeta, SearchQuery
from app.features.workspace.infrastructure.memory_index import MemorySessionIndex
from app.features.workspace.infrastructure.sqlite_cache import SqliteWorkspaceCache


class FileSearcher:
    def __init__(self, cache: SqliteWorkspaceCache, memory: MemorySessionIndex):
        self.cache = cache
        self.memory = memory

    def search(self, workspace_id: str, query: SearchQuery) -> list[FileMeta]:
        by = (query.by or "name").lower()
        q = (query.query or "").strip()
        limit = max(1, min(query.limit or 50, 200))
        if not q:
            return []

        # Prefer memory if warm
        mem_files = self.memory.all(workspace_id)
        if mem_files:
            if by == "ext":
                return self.memory.by_ext(workspace_id, q)[:limit]
            if by == "token":
                # exact stem first, then substring
                hits = self.memory.by_stem(workspace_id, q)
                if len(hits) < limit:
                    for f in self.memory.search_name(workspace_id, q, limit=limit):
                        if f not in hits:
                            hits.append(f)
                        if len(hits) >= limit:
                            break
                return hits[:limit]
            return self.memory.search_name(workspace_id, q, limit=limit)

        return self.cache.search(workspace_id, by=by, query=q, limit=limit)
