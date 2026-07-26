"""Build / parse structured requirement content (UserStory + SRS + Feature + notes)."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import PurePosixPath
from typing import Any

SECTION_USER_STORY = "UserStory"
SECTION_SRS = "SRS"
SECTION_NOTES = "Requirement"
SECTION_FEATURE = "Feature"

KNOWN_SECTIONS = (SECTION_USER_STORY, SECTION_SRS, SECTION_NOTES)
_SECTION_RE = re.compile(
    r"^###\s*(UserStory|SRS|Requirement)\s*$",
    re.MULTILINE | re.IGNORECASE,
)
_FEATURE_RE = re.compile(
    r"^###\s*Feature:\s*(.+?)\s*$",
    re.MULTILINE | re.IGNORECASE,
)
_FILE_MARK_RE = re.compile(
    r"^---\s*(.+?)\s*---\s*$",
    re.MULTILINE,
)


def content_hash(content: str) -> str:
    return hashlib.sha256((content or "").encode("utf-8")).hexdigest()[:16]


def normalize_function_label(raw: str | None) -> str:
    """Tên chức năng/module thống nhất — 'Tạo+mới' và 'Tạo mới' cùng một nhãn."""
    t = (raw or "").strip()
    if not t:
        return ""
    t = t.replace("+", " ")
    try:
        from urllib.parse import unquote

        t = unquote(t)
    except (ValueError, TypeError):
        pass
    t = re.sub(r"[\s_]+", " ", t).strip()
    return t


def feature_title_from_filename(file_name: str | None) -> str:
    """Derive chức năng name from uploaded file name."""
    raw = (file_name or "").strip()
    if not raw:
        return "Chức năng"
    first = raw.split(",")[0].strip()
    stem = PurePosixPath(first.replace("\\", "/")).stem.strip()
    label = normalize_function_label(stem)
    return label or "Chức năng"


def disambiguate_feature_title(
    base: str, file_name: str | None, used: set[str]
) -> str:
    """Tên chức năng duy nhất — ưu tiên thêm tên file thay vì chỉ (2), (3)."""
    label = normalize_function_label(base) or "Chức năng"
    key = label.lower()
    if key not in used:
        used.add(key)
        return label
    fn = (file_name or "").strip()
    if fn:
        short = PurePosixPath(fn.replace("\\", "/")).name
        cand = f"{label} — {short}"
        ck = cand.lower()
        if ck not in used:
            used.add(ck)
            return cand
    n = 2
    while True:
        cand = f"{label} ({n})"
        ck = cand.lower()
        if ck not in used:
            used.add(ck)
            return cand
        n += 1


def expand_sources(sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Normalize FE/API sources so mỗi tài liệu chức năng là một Feature.
    - Tách blob SRS/Feature có nhiều marker --- filename ---
    - SRS 1 file → Feature
    - Giữ UserStory / Requirement nguyên
    """
    out: list[dict[str, Any]] = []
    used_titles: set[str] = set()

    for s in sources:
        st = (s.get("sourceType") or "").strip()
        content = (s.get("content") or "").strip()
        if not content:
            continue
        fn = (s.get("fileName") or "").strip()
        title = (s.get("title") or "").strip()
        preview = s.get("previewHtml")

        if st in (SECTION_SRS, SECTION_FEATURE) or st.lower() == "feature":
            marks = list(_FILE_MARK_RE.finditer(content))
            if len(marks) >= 2:
                for i, m in enumerate(marks):
                    part_fn = (m.group(1) or "").strip()
                    start = m.end()
                    end = marks[i + 1].start() if i + 1 < len(marks) else len(content)
                    body = content[start:end].strip()
                    if not body:
                        continue
                    label = disambiguate_feature_title(
                        feature_title_from_filename(part_fn), part_fn, used_titles
                    )
                    row: dict[str, Any] = {
                        "sourceType": SECTION_FEATURE,
                        "content": body,
                        "fileName": part_fn,
                        "title": label,
                    }
                    if preview and i == 0:
                        row["previewHtml"] = preview
                    out.append(row)
                continue

            label = disambiguate_feature_title(
                title or feature_title_from_filename(fn) or "Chức năng",
                fn.split(",")[0].strip() if fn else "",
                used_titles,
            )
            row = {
                "sourceType": SECTION_FEATURE,
                "content": content,
                "fileName": fn.split(",")[0].strip() if fn else "",
                "title": label,
            }
            if preview:
                row["previewHtml"] = preview
            out.append(row)
            continue

        if st in KNOWN_SECTIONS:
            row = {"sourceType": st, "content": content, "fileName": fn or None}
            if title:
                row["title"] = title
            if preview:
                row["previewHtml"] = preview
            out.append(row)
    return out


def build_content(sources: list[dict[str, Any]]) -> str:
    """Serialize sources → markdown. Mỗi file Feature = một khối ### Feature:."""
    parts: list[str] = []
    for s in expand_sources(sources):
        st = (s.get("sourceType") or "").strip()
        content = (s.get("content") or "").strip()
        if not content:
            continue
        fn = (s.get("fileName") or "").strip()
        title = (s.get("title") or "").strip()

        if st == SECTION_FEATURE or st.lower() == "feature":
            label = title or feature_title_from_filename(fn)
            parts.append(f"### Feature: {label}\n{content}")
            continue

        if st in KNOWN_SECTIONS:
            parts.append(f"### {st}\n{content}")
    return "\n\n".join(parts)


def parse_sections(content: str) -> dict[str, str]:
    if not (content or "").strip():
        return {}

    matches = list(_SECTION_RE.finditer(content))
    if not matches:
        # May be feature-only document
        if _FEATURE_RE.search(content):
            return {}
        return {SECTION_NOTES: content.strip()}

    sections: dict[str, str] = {}
    for i, m in enumerate(matches):
        key = _normalize_section(m.group(1))
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
        # Stop at next Feature block if it sits inside section span
        body = content[start:end]
        feat = _FEATURE_RE.search(body)
        if feat and feat.start() == 0:
            body = ""
        elif feat:
            # Features after section header belong to parse_features, keep preamble only
            body = body[: feat.start()]
        body = body.strip()
        if body:
            sections[key] = body
    return sections


def parse_features(content: str) -> list[dict[str, str]]:
    """Extract ### Feature: blocks; fallback split --- file --- markers in SRS."""
    text = content or ""
    matches = list(_FEATURE_RE.finditer(text))
    out: list[dict[str, str]] = []
    if matches:
        for i, m in enumerate(matches):
            title = (m.group(1) or "").strip()
            start = m.end()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
            body = text[start:end].strip()
            # Trim trailing classic sections accidentally included
            sec = _SECTION_RE.search(body)
            if sec:
                body = body[: sec.start()].strip()
            if title and body:
                out.append({"title": title, "content": body})
        return out

    # Legacy: merged docs with --- filename ---
    sections = parse_sections(text)
    for key in (SECTION_SRS, SECTION_NOTES, SECTION_USER_STORY):
        blob = (sections.get(key) or "").strip()
        if not blob:
            continue
        marks = list(_FILE_MARK_RE.finditer(blob))
        if len(marks) < 2:
            continue
        for i, m in enumerate(marks):
            fn = (m.group(1) or "").strip()
            start = m.end()
            end = marks[i + 1].start() if i + 1 < len(marks) else len(blob)
            body = blob[start:end].strip()
            if body:
                out.append(
                    {
                        "title": feature_title_from_filename(fn),
                        "content": body,
                        "fileName": fn,
                    }
                )
        if out:
            return out
    return out


def enrich_features_with_files(
    features: list[dict[str, str]], description: str | None
) -> list[dict[str, str]]:
    """Gắn fileName từ meta documentFiles — khớp topic ↔ file khi sinh TC."""
    docs = parse_document_files(description)
    if not docs:
        return features
    out: list[dict[str, str]] = []
    for i, f in enumerate(features):
        row = dict(f)
        if (row.get("fileName") or "").strip():
            out.append(row)
            continue
        title = (row.get("title") or "").strip()
        fn = ""
        for d in docs:
            dt = (d.get("title") or "").strip()
            if (
                dt
                and normalize_function_label(dt).lower()
                == normalize_function_label(title).lower()
            ):
                fn = str(d.get("fileName") or "")
                break
        if not fn and i < len(docs):
            fn = str(docs[i].get("fileName") or "")
        if fn:
            row["fileName"] = fn
        out.append(row)
    return out


def _normalize_section(name: str) -> str:
    n = (name or "").strip().lower()
    if n == "userstory":
        return SECTION_USER_STORY
    if n == "srs":
        return SECTION_SRS
    return SECTION_NOTES


def find_feature_for_scope(
    features: list[dict[str, str]],
    scope_title: str,
    topic_notes: str | None = None,
) -> dict[str, str] | None:
    """Khớp Feature với chủ đề job (tên, file trong notes, gần đúng)."""
    scope = normalize_function_label(scope_title).lower()
    if not scope and not (topic_notes or "").strip():
        return None

    for f in features:
        ft = normalize_function_label(f.get("title") or "").lower()
        if scope and ft == scope:
            return f

    notes = (topic_notes or "").strip()
    if notes:
        fn_hint = ""
        if "Từ tài liệu:" in notes:
            fn_hint = notes.split("Từ tài liệu:", 1)[-1].strip().lower()
        elif notes.lower().endswith((".docx", ".doc", ".pdf", ".txt")):
            fn_hint = notes.lower()
        if fn_hint:
            for f in features:
                ffn = (f.get("fileName") or "").strip().lower()
                stem = PurePosixPath(ffn.replace("\\", "/")).stem.lower() if ffn else ""
                if fn_hint in ffn or (stem and fn_hint in stem) or ffn.endswith(fn_hint):
                    return f

    if scope:
        for f in features:
            ft = normalize_function_label(f.get("title") or "").lower()
            if scope in ft or ft in scope:
                return f

    if len(features) == 1:
        return features[0]
    return None


def parse_description_meta(description: str | None) -> dict[str, Any]:
    if not description:
        return {}
    try:
        data = json.loads(description)
        if isinstance(data, dict):
            return data
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    return {"note": description}


def content_meta_from_description(description: str | None) -> tuple[str | None, int]:
    meta = parse_description_meta(description)
    h = meta.get("contentHash")
    version = int(meta.get("contentVersion") or 1)
    return (str(h) if h else None, version)


def change_summary_from_description(description: str | None) -> str | None:
    meta = parse_description_meta(description)
    summary = meta.get("changeSummary")
    if isinstance(summary, str) and summary.strip():
        return summary.strip()
    return None


_SECTION_LABELS = {
    SECTION_USER_STORY: "User Story",
    SECTION_SRS: "SRS",
    SECTION_NOTES: "Yêu cầu",
}


def infer_change_summary(old_content: str, new_content: str) -> str:
    old_s = parse_sections(old_content or "")
    new_s = parse_sections(new_content or "")
    old_f = {f["title"] for f in parse_features(old_content or "")}
    new_f = {f["title"] for f in parse_features(new_content or "")}
    parts: list[str] = []
    for key in KNOWN_SECTIONS:
        old_text = (old_s.get(key) or "").strip()
        new_text = (new_s.get(key) or "").strip()
        if old_text == new_text:
            continue
        label = _SECTION_LABELS[key]
        if not old_text and new_text:
            parts.append(f"Thêm {label}")
        elif old_text and not new_text:
            parts.append(f"Xoá {label}")
        else:
            parts.append(f"Cập nhật {label}")
    added = new_f - old_f
    removed = old_f - new_f
    if added:
        parts.append(f"Thêm chức năng: {', '.join(sorted(added))}")
    if removed:
        parts.append(f"Xoá chức năng: {', '.join(sorted(removed))}")
    return "; ".join(parts) if parts else "Nội dung requirement thay đổi"


def source_content_hash(content: str, description: str | None) -> str:
    h, _ = content_meta_from_description(description)
    return h or content_hash(content)


def parse_attachment_meta(description: str | None) -> dict[str, str]:
    meta = parse_description_meta(description)
    attachments = meta.get("attachments")
    if isinstance(attachments, dict):
        return {str(k): str(v) for k, v in attachments.items()}
    return {}


def parse_document_files(description: str | None) -> list[dict[str, Any]]:
    meta = parse_description_meta(description)
    raw = meta.get("documentFiles")
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for row in raw:
        if isinstance(row, dict) and (row.get("fileName") or row.get("title")):
            out.append(row)
    return out


def parse_rich_previews(description: str | None) -> dict[str, str]:
    meta = parse_description_meta(description)
    previews = meta.get("richPreviews")
    if isinstance(previews, dict):
        return {str(k): str(v) for k, v in previews.items() if v}
    return {}


def rich_previews_from_sources(sources: list[dict[str, Any]]) -> dict[str, str]:
    """HTML preview: section key or feature title → html."""
    max_chars = 1_200_000
    out: dict[str, str] = {}
    for s in sources:
        st = (s.get("sourceType") or "").strip()
        html = (s.get("previewHtml") or "").strip()
        if not html:
            continue
        if len(html) > max_chars:
            html = html[:max_chars] + "<!-- truncated -->"
        if st == SECTION_FEATURE or st.lower() == "feature":
            key = (s.get("title") or feature_title_from_filename(s.get("fileName"))).strip()
            if key:
                out[f"Feature:{key}"] = html
        elif st in KNOWN_SECTIONS:
            out[st] = html
    return out


def document_files_from_sources(sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    files: list[dict[str, Any]] = []
    for s in expand_sources(sources):
        st = (s.get("sourceType") or "").strip()
        fn = (s.get("fileName") or "").strip()
        title = (s.get("title") or "").strip()
        if st == SECTION_FEATURE or st.lower() == "feature":
            label = title or feature_title_from_filename(fn)
            files.append(
                {
                    "sourceType": SECTION_FEATURE,
                    "fileName": fn,
                    "title": label,
                }
            )
        elif st in KNOWN_SECTIONS and fn:
            files.append({"sourceType": st, "fileName": fn, "title": title or st})
    return files


def attachment_meta_from_sources(sources: list[dict[str, Any]]) -> dict[str, Any]:
    attachments: dict[str, str] = {}
    for s in sources:
        st = (s.get("sourceType") or "").strip()
        fn = (s.get("fileName") or "").strip()
        if st in KNOWN_SECTIONS and fn and st not in attachments:
            attachments[st] = fn
    return {"attachments": attachments} if attachments else {}


def encode_requirement_meta(
    content: str,
    sources: list[dict[str, Any]],
    note: str | None,
    old_description: str | None,
    old_content: str | None = None,
    change_summary: str | None = None,
) -> str:
    meta = parse_description_meta(old_description)
    # Rule sinh TC nằm ở BE (llm/tc_generation_rules.py), không lưu theo requirement
    meta.pop("tcGenerationRules", None)
    att = attachment_meta_from_sources(sources)
    if att.get("attachments"):
        meta["attachments"] = att["attachments"]

    docs = document_files_from_sources(sources)
    if docs:
        meta["documentFiles"] = docs

    previews = rich_previews_from_sources(sources)
    if previews:
        meta["richPreviews"] = previews

    new_hash = content_hash(content)
    old_hash = meta.get("contentHash")
    version = int(meta.get("contentVersion") or 0)
    version_bumped = False
    if old_hash and old_hash != new_hash:
        version += 1
        version_bumped = True
    elif not old_hash:
        version = 1
    meta["contentHash"] = new_hash
    meta["contentVersion"] = version

    if version_bumped:
        summary = (change_summary or "").strip()
        if not summary and old_content is not None:
            summary = infer_change_summary(old_content, content)
        if summary:
            meta["changeSummary"] = summary

    if note is not None:
        note = note.strip()
        if note:
            meta["note"] = note
        elif "note" in meta:
            del meta["note"]

    return json.dumps(meta, ensure_ascii=False)


def encode_description(
    body_description: str | None, sources: list[dict[str, Any]]
) -> str | None:
    """Legacy helper — use encode_requirement_meta when content is available."""
    meta = attachment_meta_from_sources(sources)
    note = (body_description or "").strip()
    if meta and note:
        meta["note"] = note
        return json.dumps(meta, ensure_ascii=False)
    if meta:
        return json.dumps(meta, ensure_ascii=False)
    return note or None


def sources_for_detail(content: str, description: str | None) -> list[dict[str, str]]:
    """Expand stored content back to UI sources (Feature per file + classic sections)."""
    attachments = parse_attachment_meta(description)
    previews = parse_rich_previews(description)
    docs = parse_document_files(description)
    features = parse_features(content)
    out: list[dict[str, str]] = []

    sections = parse_sections(content)
    for key in KNOWN_SECTIONS:
        text = sections.get(key, "").strip()
        if not text:
            continue
        row: dict[str, str] = {
            "sourceType": key,
            "content": text,
            "fileName": attachments.get(key) or "",
        }
        if previews.get(key):
            row["previewHtml"] = previews[key]
        out.append(row)

    for i, f in enumerate(features):
        title = f.get("title") or f"Chức năng {i + 1}"
        fn = ""
        if i < len(docs) and (docs[i].get("title") or "").strip().lower() == title.lower():
            fn = str(docs[i].get("fileName") or "")
        else:
            for d in docs:
                if (d.get("title") or "").strip().lower() == title.lower():
                    fn = str(d.get("fileName") or "")
                    break
        row = {
            "sourceType": SECTION_FEATURE,
            "content": f.get("content") or "",
            "fileName": fn or f.get("fileName") or f"{title}.txt",
            "title": title,
        }
        html = previews.get(f"Feature:{title}")
        if html:
            row["previewHtml"] = html
        out.append(row)

    return out
