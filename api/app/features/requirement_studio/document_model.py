"""Structured document model for Phân tích — heading / table / entity index.

Parses RequirementFile.extracted_text into section units used by heuristic
ranking and per-criteria retrieval (no vector DB).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

SectionKind = Literal["heading", "table", "entity", "prose"]

_MD_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
_NUMBERED_HEADING = re.compile(
    r"^(?:"
    r"\d+(?:\.\d+){0,3}\.?\s+|"  # 1. / 1.1 / 1.1.1
    r"(?:FR|UC|BR|NFR|AC)[\s\-_]*\d+\s*[:\-–.]?\s*"
    r")(.+)$",
    re.IGNORECASE,
)
_PIPE_ROW = re.compile(r"^\s*\|.+\|\s*$")
_ENTITY_HINT = re.compile(
    r"(?i)\b(?:bảng|table|entity|entities|model)\s+[`'\"]?([A-Za-z_][\w]*)[`'\"]?"
)


@dataclass(frozen=True)
class DocumentSection:
    heading: str | None
    body: str
    kind: SectionKind
    source_file: str | None = None

    def as_pair(self) -> tuple[str | None, str]:
        label = self.heading
        if self.source_file and label:
            label = f"{self.source_file} › {label}"
        elif self.source_file and not label:
            label = self.source_file
        return label, self.body


def _is_heading_line(line: str) -> str | None:
    raw = (line or "").strip()
    if not raw or len(raw) > 160:
        return None
    m = _MD_HEADING.match(raw)
    if m:
        return m.group(2).strip()
    # All-caps short titles (avoid code/API lines)
    if (
        len(raw) <= 80
        and raw.upper() == raw
        and any(c.isalpha() for c in raw)
        and not raw.startswith("|")
        and "/" not in raw
    ):
        return raw
    m2 = _NUMBERED_HEADING.match(raw)
    if m2 and not _PIPE_ROW.match(raw):
        # Prefer full line as heading when FR/UC coded; else capture group
        if re.match(r"(?i)^(?:FR|UC|BR|NFR|AC)\b", raw):
            return raw
        title = m2.group(1).strip()
        if title and len(title) >= 2:
            return raw if len(raw) <= 120 else title
    return None


def _classify_body(heading: str | None, body: str) -> SectionKind:
    lines = [ln for ln in (body or "").splitlines() if ln.strip()]
    if not lines:
        return "prose"
    pipe = sum(1 for ln in lines if _PIPE_ROW.match(ln))
    if pipe >= 2 or (pipe >= 1 and len(lines) <= 8):
        return "table"
    blob = f"{heading or ''}\n{body}"
    if _ENTITY_HINT.search(blob):
        return "entity"
    if heading:
        return "heading"
    return "prose"


def build_document_index(
    text: str,
    *,
    file_name: str | None = None,
) -> list[DocumentSection]:
    """Split extracted SRS text into heading / table / entity / prose sections."""
    raw = (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return []

    lines = raw.split("\n")
    sections: list[DocumentSection] = []
    cur_heading: str | None = None
    buf: list[str] = []

    def flush() -> None:
        nonlocal buf, cur_heading
        body = "\n".join(buf).strip()
        if not body and not cur_heading:
            buf = []
            return
        if not body:
            buf = []
            cur_heading = None
            return
        kind = _classify_body(cur_heading, body)
        sections.append(
            DocumentSection(
                heading=cur_heading,
                body=body,
                kind=kind,
                source_file=file_name,
            )
        )
        buf = []

    for line in lines:
        h = _is_heading_line(line)
        if h is not None:
            flush()
            cur_heading = h
            continue
        buf.append(line)
        # Split on double blank when buffer is already large (orphan prose)
        if (
            line.strip() == ""
            and len(buf) >= 2
            and buf[-2].strip() == ""
            and sum(len(x) for x in buf) > 1200
            and cur_heading is None
        ):
            flush()

    flush()

    # If nothing split (no headings), one prose section for whole file
    if not sections and raw:
        sections.append(
            DocumentSection(
                heading=file_name,
                body=raw,
                kind=_classify_body(file_name, raw),
                source_file=file_name,
            )
        )
    return sections


def index_to_chunk_pairs(
    sections: list[DocumentSection],
) -> list[tuple[str | None, str]]:
    """Convert index sections to (heading, body) pairs for heuristic / prompts."""
    out: list[tuple[str | None, str]] = []
    for sec in sections:
        pair = sec.as_pair()
        if (pair[1] or "").strip():
            out.append(pair)
    return out


def build_chunk_pairs_from_files(
    files: list[tuple[str, str]],
) -> list[tuple[str | None, str]]:
    """files = [(file_name, extracted_text), ...] → section-level pairs."""
    pairs: list[tuple[str | None, str]] = []
    for name, text in files:
        sections = build_document_index(text, file_name=name)
        pairs.extend(index_to_chunk_pairs(sections))
    return pairs
