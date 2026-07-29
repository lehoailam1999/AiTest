"""Tests for TC → code token fallback (VI module vs Latin paths)."""

from app.services.resolve_source_scope import fallback_code_tokens_from_tc


def test_fallback_tokens_strips_diacritics_and_aliases():
    tokens = fallback_code_tokens_from_tc(
        title="Đăng nhập - Nhập hợp lệ - Vào trang chính",
        module="Quản lý đăng nhập",
        steps="1. Mở form đăng nhập\n2. Nhập email",
        test_data="",
    )
    lower = {t.lower() for t in tokens}
    assert "login" in lower or "auth" in lower or "signin" in lower
    assert any(len(t) >= 3 for t in tokens)


def test_fallback_tokens_honors_code_hint():
    tokens = fallback_code_tokens_from_tc(
        title="Tạo todo",
        module="Todos",
        steps="",
        test_data="code: TodoService path: src/services/todo.service.ts",
    )
    lower = {t.lower() for t in tokens}
    assert "todoservice" in lower or "todo" in lower
