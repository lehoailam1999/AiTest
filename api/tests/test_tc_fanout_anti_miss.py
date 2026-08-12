from __future__ import annotations

from types import SimpleNamespace

from app.routers.jobs import _missing_modules_for_retry, _module_has_any_draft


def _d(module: str):
    return SimpleNamespace(module=module)


def test_module_has_any_draft_accepts_normalized_match():
    drafts = [_d("Quan ly vat chung"), _d("Dang nhap")]
    assert _module_has_any_draft("Quản lý vật chứng", drafts) is True
    assert _module_has_any_draft("Đăng nhập", drafts) is True
    assert _module_has_any_draft("Thanh toán", drafts) is False


def test_missing_modules_for_retry_returns_only_uncovered_modules():
    modules = ["Quản lý vật chứng", "Đăng nhập", "Quản lý vật chứng"]
    drafts = [_d("Quan ly vat chung")]
    missing = _missing_modules_for_retry(modules, drafts)
    assert missing == ["Đăng nhập"]

