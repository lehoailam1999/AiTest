"""R1 unit tests — FileRef DTO helpers."""

from app.features.requirement_studio.dto import truncate_preview, PREVIEW_HTML_MAX


def test_truncate_preview_long():
    html = "x" * (PREVIEW_HTML_MAX + 10)
    out = truncate_preview(html)
    assert out is not None and "truncated" in out


def test_truncate_preview_short():
    assert truncate_preview("hi") == "hi"
    assert truncate_preview(None) is None
