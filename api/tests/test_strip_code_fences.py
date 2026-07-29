"""strip_code_fences must drop CLI narration before the real fence."""

from app.llm.base import strip_code_fences


def test_strip_fences_with_leading_prose():
    raw = (
        "Đang suy nghĩ về mâu thuẫn JSON vs code.\n"
        "Sẽ trả về mã trong fence.\n"
        "```typescript\n"
        "import { x } from 'y';\n"
        "describe('t', () => { it('ok', () => expect(1).toBe(1)); });\n"
        "```\n"
    )
    out = strip_code_fences(raw)
    assert out.startswith("import")
    assert "Đang suy nghĩ" not in out
    assert "```" not in out


def test_strip_fences_glued_to_prose():
    raw = (
        "Đã hoàn thiện khối mã.```typescript\n"
        "const a = 1;\n"
        "```"
    )
    assert strip_code_fences(raw) == "const a = 1;"


def test_strip_fences_unclosed_fence_after_vi_narration():
    raw = (
        "Đã quyết định viết test.```typescript\n"
        "/// <reference types=\"jest\" />\n"
        "import { setAuthToken } from 'src/api';\n"
        "describe('t', () => {});"
    )
    out = strip_code_fences(raw)
    assert out.startswith("/// <reference")
    assert "Đã quyết định" not in out


def test_strip_fences_narration_without_fence():
    raw = (
        "Đang cân nhắc thêm hàm isMobileViewport.\n"
        "Sẽ bắt đầu soạn khối mã Jest.\n"
        "import { setAuthToken } from 'src/api';\n"
        "describe('x', () => {});"
    )
    out = strip_code_fences(raw)
    assert out.startswith("import")
    assert "Đang cân nhắc" not in out


def test_strip_fences_plain_code_passthrough():
    assert strip_code_fences("export const n = 1;") == "export const n = 1;"
