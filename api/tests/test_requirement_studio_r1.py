"""R2 unit tests — document chunking."""

from app.features.requirement_studio.chunking import chunk_document_text
from app.features.requirement_studio.dto import truncate_preview, PREVIEW_HTML_MAX


def test_chunk_empty():
    assert chunk_document_text("") == []
    assert chunk_document_text("   ") == []


def test_chunk_short_single():
    chunks = chunk_document_text("Hello world requirement text.")
    assert len(chunks) == 1
    assert chunks[0].ordinal == 0
    assert "Hello world" in chunks[0].text


def test_chunk_by_headings():
    text = """# Intro
Alpha paragraph.

## Rules
Rule one is important.

## Actors
User and Admin.
"""
    chunks = chunk_document_text(text, max_chars=800, overlap=40)
    assert len(chunks) >= 2
    headings = {c.heading for c in chunks if c.heading}
    assert "Rules" in headings or "Actors" in headings
    ordinals = [c.ordinal for c in chunks]
    assert ordinals == list(range(len(chunks)))


def test_chunk_long_window():
    body = ("Paragraph about login validation. " * 80).strip()
    chunks = chunk_document_text(body, max_chars=400, overlap=50)
    assert len(chunks) > 1
    assert all(len(c.text) <= 450 for c in chunks)


def test_truncate_preview_long():
    html = "x" * (PREVIEW_HTML_MAX + 10)
    out = truncate_preview(html)
    assert out is not None and "truncated" in out
