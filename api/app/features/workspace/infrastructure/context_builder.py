"""Context builder — pick primary/related and read subset for LLM."""

from __future__ import annotations

from dataclasses import dataclass

from app.features.workspace.domain.models import FileMeta, SearchQuery
from app.features.workspace.infrastructure.import_hints import stems_from_paths
from app.ports.workspace import WorkspacePort


@dataclass
class BuiltContext:
    primary_path: str | None
    primary_content: str
    related: list[dict]  # {path, content, role}
    candidates: list[str]
    reason: str


class ContextBuilder:
    def __init__(self, port: WorkspacePort):
        self.port = port

    def build_for_tokens(
        self,
        workspace_id: str,
        tokens: list[str],
        *,
        max_related: int = 12,
        max_bytes: int = 400_000,
    ) -> BuiltContext:
        candidates: list[FileMeta] = []
        seen: set[str] = set()
        for tok in tokens:
            t = (tok or "").strip()
            if len(t) < 2:
                continue
            for hit in self.port.search(
                workspace_id, SearchQuery(by="token", query=t, limit=20)
            ):
                if hit.relative_path not in seen:
                    seen.add(hit.relative_path)
                    candidates.append(hit)
            for hit in self.port.search(
                workspace_id, SearchQuery(by="name", query=t, limit=10)
            ):
                if hit.relative_path not in seen:
                    seen.add(hit.relative_path)
                    candidates.append(hit)

        # Expand with sibling stems (import-light heuristic)
        for stem in stems_from_paths([c.relative_path for c in candidates[:15]], limit=12):
            for hit in self.port.search(
                workspace_id, SearchQuery(by="token", query=stem, limit=8)
            ):
                if hit.relative_path not in seen:
                    seen.add(hit.relative_path)
                    candidates.append(hit)

        if not candidates:
            return BuiltContext(
                primary_path=None,
                primary_content="",
                related=[],
                candidates=[],
                reason="No candidate files for tokens",
            )

        paths = [c.relative_path for c in candidates[: max_related + 1]]
        reads = self.port.read_files(
            workspace_id, paths, max_bytes_per_file=max_bytes
        )
        by_path = {r.relative_path: r for r in reads if not r.error}
        primary = paths[0]
        primary_content = by_path.get(primary).content if primary in by_path else ""
        related = []
        for p in paths[1:]:
            r = by_path.get(p)
            if r and r.content:
                related.append({"path": p, "content": r.content, "role": "dependency"})
        return BuiltContext(
            primary_path=primary,
            primary_content=primary_content or "",
            related=related,
            candidates=paths,
            reason=f"Matched tokens: {', '.join(tokens[:6])}",
        )
