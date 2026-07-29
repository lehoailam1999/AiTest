"""Resolve primary/related source contents for generate-* when workspaceId is set."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.features.workspace.infrastructure.import_extract import (
    candidate_paths_for_spec,
    extract_import_specs,
    normalize_rel,
    resolve_relative_spec,
    search_tokens_for_spec,
)

MAX_RELATED = 12
MAX_BYTES = 400_000
MAX_EXPAND_SPECS = 20
_CODE_EXT = {".ts", ".tsx", ".js", ".jsx", ".cs", ".py", ".java", ".go", ".rs", ".kt"}


def _posix(path: str) -> str:
    return normalize_rel(path)


def _files_index(reads: dict[str, Any]) -> dict[str, dict]:
    by_exact: dict[str, dict] = {}
    by_lower: dict[str, dict] = {}
    for f in reads.get("files") or []:
        if not isinstance(f, dict):
            continue
        rel = _posix(str(f.get("relativePath") or f.get("path") or ""))
        if not rel:
            continue
        row = {**f, "relativePath": rel}
        by_exact[rel] = row
        by_lower[rel.lower()] = row
    return {"_exact": by_exact, "_lower": by_lower}  # type: ignore[return-value]


def _get_file(index: dict[str, dict], path: str) -> dict | None:
    p = _posix(path)
    exact: dict = index.get("_exact") or {}  # type: ignore[assignment]
    lower: dict = index.get("_lower") or {}  # type: ignore[assignment]
    return exact.get(p) or lower.get(p.lower())


def _read_paths(svc: Any, workspace_id: str, paths: list[str]) -> dict[str, dict]:
    uniq: list[str] = []
    seen: set[str] = set()
    for p in paths:
        n = _posix(str(p))
        if not n:
            continue
        key = n.lower()
        if key in seen:
            continue
        seen.add(key)
        uniq.append(n)
    if not uniq:
        return {"_exact": {}, "_lower": {}}
    reads = svc.read(
        workspace_id,
        {"paths": uniq[:40], "maxBytesPerFile": MAX_BYTES},
    )
    return _files_index(reads if isinstance(reads, dict) else {})


def _search_paths(svc: Any, workspace_id: str, query: str, *, limit: int = 6) -> list[str]:
    q = (query or "").strip()
    if len(q) < 2:
        return []
    out: list[str] = []
    for by in ("token", "name"):
        try:
            res = svc.search(workspace_id, {"by": by, "query": q, "limit": limit})
        except Exception:  # noqa: BLE001
            continue
        items = res.get("items") if isinstance(res, dict) else None
        if not isinstance(items, list):
            continue
        for it in items:
            if not isinstance(it, dict):
                continue
            rel = _posix(str(it.get("relativePath") or it.get("path") or ""))
            if rel:
                out.append(rel)
    return out


def _same_feature_area(primary: str, candidate: str) -> bool:
    """Keep related near SUT (same folder / parent / grandparent), not whole repo."""
    p = _posix(primary)
    c = _posix(candidate)
    p_dir = str(Path(p).parent).replace("\\", "/")
    c_dir = str(Path(c).parent).replace("\\", "/")
    if p_dir in (".", "") and c_dir in (".", ""):
        return True
    if c_dir == p_dir:
        return True
    if p_dir not in (".", "") and (c_dir.startswith(p_dir + "/") or p_dir.startswith(c_dir + "/")):
        return True
    p_grand = str(Path(p_dir).parent).replace("\\", "/") if p_dir not in (".", "") else ""
    c_grand = str(Path(c_dir).parent).replace("\\", "/") if c_dir not in (".", "") else ""
    return bool(p_grand and p_grand == c_grand and p_grand not in (".", ""))


def _materialize_relative(svc: Any, workspace_id: str, primary: str, specs: list[str]) -> list[str]:
    cands: list[str] = []
    for spec in specs:
        if not spec.startswith("."):
            continue
        cands.extend(candidate_paths_for_spec(spec, primary))
        rel = resolve_relative_spec(spec, primary)
        if rel:
            cands.append(rel)
    if not cands:
        return []
    index = _read_paths(svc, workspace_id, cands)
    exact = index.get("_exact") or {}
    return [p for p, row in exact.items() if row.get("content")]


def _expand_from_imports(
    svc: Any,
    workspace_id: str,
    *,
    primary: str,
    content: str,
    already: set[str],
    language: str = "",
) -> list[str]:
    specs = extract_import_specs(content, path=primary, language=language)[:MAX_EXPAND_SPECS]
    found: list[str] = []

    found.extend(_materialize_relative(svc, workspace_id, primary, specs))

    primary_dir = str(Path(_posix(primary)).parent).replace("\\", "/")
    for spec in specs:
        if spec.startswith("."):
            continue
        for tok in search_tokens_for_spec(spec):
            for hit in _search_paths(svc, workspace_id, tok, limit=5):
                if hit.lower() in already or hit.lower() == primary.lower():
                    continue
                if Path(hit).suffix.lower() not in _CODE_EXT:
                    continue
                if _same_feature_area(primary, hit):
                    found.append(hit)
        # Same-folder type basename
        base = spec.replace("\\", "/").split("/")[-1].split(".")[-1]
        if base and base[0].isupper():
            for hit in _search_paths(svc, workspace_id, base, limit=4):
                if hit.lower() in already:
                    continue
                if str(Path(hit).parent).replace("\\", "/") == primary_dir:
                    if Path(hit).suffix.lower() in _CODE_EXT:
                        found.append(hit)

    out: list[str] = []
    seen: set[str] = set()
    for p in found:
        k = _posix(p).lower()
        if k in seen or k == primary.lower() or k in already:
            continue
        seen.add(k)
        out.append(_posix(p))
    return out


def _rank_related(primary: str, paths: list[str]) -> list[str]:
    prim = _posix(primary)
    parent = str(Path(prim).parent).replace("\\", "/")

    def score(p: str) -> tuple[int, int, int, str]:
        n = _posix(p)
        same = 0 if parent not in (".", "") and str(Path(n).parent).replace("\\", "/") == parent else 1
        near = 0 if _same_feature_area(prim, n) else 2
        return (same, near, len(n), n.lower())

    return sorted({_posix(p) for p in paths}, key=score)


def _pick_related(primary: str, candidates: list[str], *, limit: int) -> list[str]:
    related_paths: list[str] = []
    seen: set[str] = set()
    for p in _rank_related(primary, candidates):
        if not _same_feature_area(primary, p):
            continue
        k = p.lower()
        if k in seen or k == primary.lower():
            continue
        seen.add(k)
        related_paths.append(p)
        if len(related_paths) >= limit:
            break
    return related_paths


async def resolve_generate_scope(
    svc: Any,
    workspace_id: str,
    *,
    module: str,
    title: str,
    body: dict,
) -> dict:
    """Build primary + related; expand only imports near the SUT."""
    forced_primary = _posix(str(body.get("sourceFileName") or "").strip())
    forced_related_raw = body.get("relatedPaths") or []
    if not isinstance(forced_related_raw, list):
        forced_related_raw = []
    forced_related = [_posix(str(p)) for p in forced_related_raw if str(p).strip()]
    language = str(body.get("language") or "").strip()

    if forced_primary:
        index = _read_paths(svc, workspace_id, [forced_primary, *forced_related])
        primary_row = _get_file(index, forced_primary)
        primary_content = (primary_row or {}).get("content") or ""
        if not primary_content:
            for row in (index.get("_exact") or {}).values():
                if row.get("content"):
                    primary_row = row
                    primary_content = row.get("content") or ""
                    forced_primary = row.get("relativePath") or forced_primary
                    break

        already = {forced_primary.lower()}
        expanded: list[str] = []
        if primary_content:
            expanded = _expand_from_imports(
                svc,
                workspace_id,
                primary=forced_primary,
                content=primary_content,
                already=already,
                language=language,
            )

        related_paths = _pick_related(
            forced_primary,
            [*forced_related, *expanded],
            limit=MAX_RELATED,
        )

        index2 = _read_paths(svc, workspace_id, [forced_primary, *related_paths])
        primary_row2 = _get_file(index2, forced_primary) or primary_row
        primary_content = (primary_row2 or {}).get("content") or primary_content

        related: list[dict[str, str]] = []
        for p in related_paths:
            f = _get_file(index2, p)
            if f and f.get("content"):
                related.append({"path": f.get("relativePath") or p, "content": f["content"]})

        return {
            "primary": forced_primary,
            "primaryContent": primary_content,
            "related": related,
            "expandedCount": len(related),
        }

    blob = f"{module or ''} {title or ''}"
    # VI Feature titles → Latin-ish tokens (cùng fallback Unit resolve_scope).
    from app.services.resolve_source_scope import fallback_code_tokens_from_tc

    tokens = fallback_code_tokens_from_tc(
        title=title or "",
        module=module,
        steps="",
        test_data=str(body.get("testData") or body.get("test_data") or "") or None,
        max_tokens=16,
    )
    if not tokens:
        tokens = [w for w in blob.replace("-", " ").split() if len(w) >= 3][:12]
    ctx = svc.build_context(workspace_id, tokens, max_related=MAX_RELATED)
    primary = ctx.primary_path
    primary_content = ctx.primary_content or ""
    related = [
        r
        for r in (ctx.related or [])
        if primary and _same_feature_area(primary, str(r.get("path") or ""))
    ]

    if primary and primary_content:
        already = {primary.lower(), *[str(r.get("path") or "").lower() for r in related]}
        expanded = _expand_from_imports(
            svc,
            workspace_id,
            primary=primary,
            content=primary_content,
            already=already,
            language=language,
        )
        for p in _pick_related(primary, expanded, limit=MAX_RELATED):
            if p.lower() in already:
                continue
            index = _read_paths(svc, workspace_id, [p])
            f = _get_file(index, p)
            if f and f.get("content"):
                related.append({"path": f.get("relativePath") or p, "content": f["content"]})
                already.add(p.lower())
            if len(related) >= MAX_RELATED:
                break

    return {
        "primary": primary,
        "primaryContent": primary_content,
        "related": related[:MAX_RELATED],
    }
