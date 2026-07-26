"""Split extracted document text into ordered chunks (R2 ChunkStore)."""

from __future__ import annotations

import re
from dataclasses import dataclass

DEFAULT_MAX_CHARS = 1500
DEFAULT_OVERLAP = 120


@dataclass(frozen=True)
class TextChunk:
    ordinal: int
    text: str
    heading: str | None


_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)


def _split_sections(text: str) -> list[tuple[str | None, str]]:
    """Split on markdown headings when present; else whole doc."""
    matches = list(_HEADING_RE.finditer(text))
    if not matches:
        return [(None, text.strip())]

    sections: list[tuple[str | None, str]] = []
    if matches[0].start() > 0:
        preamble = text[: matches[0].start()].strip()
        if preamble:
            sections.append((None, preamble))

    for i, m in enumerate(matches):
        heading = m.group(2).strip()[:500]
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[start:end].strip()
        block = f"{m.group(0).strip()}\n{body}".strip() if body else m.group(0).strip()
        sections.append((heading, block))
    return sections


def _window(text: str, max_chars: int, overlap: int) -> list[str]:
    text = text.strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]

    parts: list[str] = []
    start = 0
    n = len(text)
    while start < n:
        end = min(start + max_chars, n)
        if end < n:
            # Prefer break at paragraph / sentence
            window = text[start:end]
            br = max(window.rfind("\n\n"), window.rfind("\n"), window.rfind(". "))
            if br > max_chars // 3:
                end = start + br + (1 if window[br] == "." else 0)
                if window[br] == ".":
                    end = start + br + 1
        chunk = text[start:end].strip()
        if chunk:
            parts.append(chunk)
        if end >= n:
            break
        start = max(end - overlap, start + 1)
    return parts


def chunk_document_text(
    text: str,
    *,
    max_chars: int = DEFAULT_MAX_CHARS,
    overlap: int = DEFAULT_OVERLAP,
) -> list[TextChunk]:
    """
    Produce ordered chunks for Knowledge Builder (R3).
    Prefer heading-aware sections, then size windows with light overlap.
    """
    raw = (text or "").strip()
    if not raw:
        return []

    out: list[TextChunk] = []
    ordinal = 0
    for heading, section in _split_sections(raw):
        for piece in _window(section, max_chars, overlap):
            out.append(TextChunk(ordinal=ordinal, text=piece, heading=heading))
            ordinal += 1
    return out
