"""In-memory L1 index for hot search within a session."""

from __future__ import annotations

from collections import defaultdict

from app.features.workspace.domain.models import FileMeta


class MemorySessionIndex:
    def __init__(self) -> None:
        self._by_workspace: dict[str, list[FileMeta]] = {}
        self._by_stem: dict[str, dict[str, list[FileMeta]]] = {}
        self._by_ext: dict[str, dict[str, list[FileMeta]]] = {}

    def replace(self, workspace_id: str, files: list[FileMeta]) -> None:
        self._by_workspace[workspace_id] = list(files)
        stems: dict[str, list[FileMeta]] = defaultdict(list)
        exts: dict[str, list[FileMeta]] = defaultdict(list)
        for f in files:
            name = f.relative_path.rsplit("/", 1)[-1]
            stem = name[: -len(f.extension)] if f.extension and name.endswith(f.extension) else name
            stems[stem.lower()].append(f)
            if f.extension:
                exts[f.extension.lower()].append(f)
        self._by_stem[workspace_id] = dict(stems)
        self._by_ext[workspace_id] = dict(exts)

    def clear(self, workspace_id: str) -> None:
        self._by_workspace.pop(workspace_id, None)
        self._by_stem.pop(workspace_id, None)
        self._by_ext.pop(workspace_id, None)

    def all(self, workspace_id: str) -> list[FileMeta]:
        return list(self._by_workspace.get(workspace_id, []))

    def by_stem(self, workspace_id: str, stem: str) -> list[FileMeta]:
        return list(self._by_stem.get(workspace_id, {}).get(stem.lower(), []))

    def by_ext(self, workspace_id: str, ext: str) -> list[FileMeta]:
        e = ext if ext.startswith(".") else f".{ext}"
        return list(self._by_ext.get(workspace_id, {}).get(e.lower(), []))

    def search_name(self, workspace_id: str, query: str, *, limit: int = 50) -> list[FileMeta]:
        q = query.lower().replace("\\", "/")
        if not q:
            return []
        out: list[FileMeta] = []
        for f in self._by_workspace.get(workspace_id, []):
            if q in f.relative_path.lower():
                out.append(f)
                if len(out) >= limit:
                    break
        return out
