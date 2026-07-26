"""Chủ đề & mục con — lưu trong Source.description (JSON meta), không tách bảng."""

from __future__ import annotations

import uuid
from typing import Any

from app.services.requirement_content import (
    disambiguate_feature_title,
    feature_title_from_filename,
    normalize_function_label,
    parse_description_meta,
)


def topics_from_description(description: str | None) -> list[dict[str, Any]]:
    meta = parse_description_meta(description)
    raw = meta.get("topics")
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for row in raw:
        if not isinstance(row, dict):
            continue
        tid = str(row.get("id") or "").strip() or str(uuid.uuid4())
        title = str(row.get("title") or "").strip()
        if not title:
            continue
        items_raw = row.get("items")
        items: list[dict[str, str]] = []
        if isinstance(items_raw, list):
            for it in items_raw:
                if not isinstance(it, dict):
                    continue
                iid = str(it.get("id") or "").strip() or str(uuid.uuid4())
                it_title = str(it.get("title") or "").strip()
                if not it_title:
                    continue
                items.append(
                    {
                        "id": iid,
                        "title": it_title,
                        "notes": str(it.get("notes") or "").strip(),
                    }
                )
        out.append({"id": tid, "title": title, "notes": str(row.get("notes") or "").strip(), "items": items})
    return out


def _topic_file_key(notes: str) -> str:
    n = (notes or "").strip()
    if "Từ tài liệu:" in n:
        return n.split("Từ tài liệu:", 1)[-1].strip().lower()
    return ""


def format_topic_scope_for_prompt(topic: dict[str, Any]) -> str:
    title = topic.get("title") or "Chủ đề"
    notes = (topic.get("notes") or "").strip()
    items = topic.get("items") or []
    lines = [
        f"Chỉ sinh test case thuộc chủ đề: **{title}**.",
        "Trường module của mỗi test case phải đặt đúng tên chủ đề này.",
        "Không sinh test case cho module/chức năng khác ngoài phạm vi chủ đề.",
    ]
    if notes:
        lines.append(f"Mô tả chủ đề: {notes}")
    if items:
        lines.append("Các mục cần cover (mỗi mục ít nhất một test case phù hợp):")
        for i, it in enumerate(items, 1):
            t = it.get("title") or ""
            n = (it.get("notes") or "").strip()
            lines.append(f"{i}. {t}" + (f" — {n}" if n else ""))
    else:
        lines.append("Chưa có mục chi tiết — suy luận từ tài liệu trong phạm vi chủ đề.")
    return "\n".join(lines)


def tc_matches_module_scope(tc_module: str | None, scope_module: str | None) -> bool:
    """True nếu TC thuộc phạm vi module (chủ đề). scope_module None = toàn requirement."""
    if not (scope_module or "").strip():
        return True
    a = normalize_function_label(tc_module or "")
    b = normalize_function_label(scope_module or "")
    if not a or not b:
        return (tc_module or "").strip() == (scope_module or "").strip()
    return a.lower() == b.lower()


def merge_topics_into_description(description: str | None, topics: list[dict[str, Any]]) -> str:
    import json

    meta = parse_description_meta(description)
    meta["topics"] = topics
    return json.dumps(meta, ensure_ascii=False)


def sync_topics_from_features(
    description: str | None,
    features: list[dict[str, str]],
    *,
    replace_empty_only: bool = False,
) -> str:
    """
    Đồng bộ chủ đề = đúng danh sách Feature (1 file → 1 chủ đề).
    Thay thế toàn bộ topics (không cộng dồn) để tránh lặp (2), (3)… khi gọi nhiều lần.
    """
    if not features:
        if replace_empty_only:
            return description or "{}"
        return merge_topics_into_description(description, [])

    existing = topics_from_description(description)
    if replace_empty_only and existing:
        return description or "{}"

    by_file: dict[str, dict[str, Any]] = {}
    by_title: dict[str, dict[str, Any]] = {}
    for t in existing:
        fk = _topic_file_key(str(t.get("notes") or ""))
        if fk and fk not in by_file:
            by_file[fk] = t
        tit = normalize_function_label(str(t.get("title") or "")).lower()
        if tit and tit not in by_title:
            by_title[tit] = t

    used_titles: set[str] = set()
    new_topics: list[dict[str, Any]] = []

    for f in features:
        fn = (f.get("fileName") or "").strip()
        raw_title = (f.get("title") or "").strip()
        base = (
            normalize_function_label(raw_title)
            or raw_title
            or feature_title_from_filename(fn)
            or "Chức năng"
        )
        display = disambiguate_feature_title(base, fn or None, used_titles)

        old = by_file.get(fn.lower()) if fn else None
        if not old:
            old = by_title.get(display.lower()) or by_title.get(base.lower())

        tid = str(old.get("id") if old else "") or str(uuid.uuid4())
        items = old.get("items") if old and isinstance(old.get("items"), list) else []
        notes = f"Từ tài liệu: {fn}" if fn else "Từ khối Feature trong requirement"
        new_topics.append(
            {
                "id": tid,
                "title": display,
                "notes": notes,
                "items": items,
            }
        )

    return merge_topics_into_description(description, new_topics)
