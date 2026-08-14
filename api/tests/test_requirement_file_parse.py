"""Requirement file parse — speed: no base64 image previews."""

from __future__ import annotations

import io
import zipfile

from app.features.requirement_studio.dto import (
    MAX_EXTRACTED_TEXT_CHARS,
    truncate_extracted_text,
    truncate_preview,
)
from app.services.requirement_file_parse import parse_docx_document, parse_requirement_file


def _minimal_docx_with_png() -> bytes:
    """Tiny docx zip with one paragraph + fake media png."""
    # Minimal OOXML structure python-docx can open is heavy; use zip that
    # parse_docx_bytes may fail — instead test parse_docx_document path via
    # mocking is harder. Build with python-docx if available.
    from docx import Document

    buf = io.BytesIO()
    doc = Document()
    doc.add_paragraph("FR-01: Tao moi vat chung")
    doc.add_paragraph("Business rule: ma duy nhat")
    doc.save(buf)
    raw = buf.getvalue()
    # Inject a fake media part so media_n > 0
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(raw), "r") as zin, zipfile.ZipFile(
        out, "w"
    ) as zout:
        for item in zin.infolist():
            zout.writestr(item, zin.read(item.filename))
        # 1x1 PNG
        png = (
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
            b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f"
            b"\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
        )
        zout.writestr("word/media/image1.png", png)
    return out.getvalue()


def test_docx_preview_skips_base64_images():
    raw = _minimal_docx_with_png()
    parsed = parse_docx_document(raw)
    assert "FR-01" in parsed.text or "Tao moi" in parsed.text
    assert "data:image" not in (parsed.html or "")
    assert "base64" not in (parsed.html or "").lower()
    assert parsed.warning and "ảnh" in parsed.warning.lower() or "anh" in (
        parsed.warning or ""
    ).lower() or "ảnh" in (parsed.warning or "")


def test_truncate_helpers_cap_size():
    huge = "x" * (MAX_EXTRACTED_TEXT_CHARS + 5000)
    t = truncate_extracted_text(huge)
    assert t is not None
    assert len(t) <= MAX_EXTRACTED_TEXT_CHARS
    html = "<p>" + ("y" * 100_000) + "</p>"
    p = truncate_preview(html)
    assert p is not None
    assert len(p) <= 40_000 + 40


def test_md_upload_parse_fast():
    raw = b"# Feature\n\nFR-01 create item\n\n## Rules\n\nBR-1 unique code\n"
    parsed = parse_requirement_file(raw, "srs.md")
    assert parsed.parser == "text"
    assert "FR-01" in parsed.text
    assert "data:image" not in (parsed.html or "")
