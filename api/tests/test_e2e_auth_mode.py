"""E2E auth mode single source of truth."""

from __future__ import annotations

from app.services.e2e_auth_mode import (
    is_login_or_auth_tc,
    is_public_no_auth_signal,
    resolve_auth_mode,
    wants_no_auth_artifacts,
    wants_storage_state,
    wants_ui_auth_helper,
)


def test_resolve_auth_mode_storage_first():
    # Checkbox alone must NOT enable storage (ENOENT without JSON).
    assert resolve_auth_mode(use_storage=True) == "ui_helper"
    assert resolve_auth_mode(has_valid_storage_json=True) == "storage"
    assert resolve_auth_mode() == "ui_helper"
    assert resolve_auth_mode(use_storage=True, is_login_tc=True) == "none"
    assert resolve_auth_mode(has_valid_storage_json=True, is_login_tc=True) == "none"


def test_public_overrides_storage_checkbox():
    assert resolve_auth_mode(use_storage=True, app_public=True) == "public"
    assert resolve_auth_mode(has_valid_storage_json=True, app_public=True) == "public"
    assert wants_no_auth_artifacts("public")
    assert not wants_storage_state("public")
    assert not wants_ui_auth_helper("public")


def test_login_tc_detection():
    assert is_login_or_auth_tc("Đăng nhập thành công")
    assert is_login_or_auth_tc("User Logout")
    assert not is_login_or_auth_tc("Cập nhật job title")
    # «Không đăng nhập» is public access — not a Login journey
    assert not is_login_or_auth_tc("Không đăng nhập - Vẫn xem được danh sách")
    assert not is_login_or_auth_tc("Xem danh sách không cần đăng nhập")
    # Feature step wording must not flip a validation TC into Login mode
    assert not is_login_or_auth_tc(
        "Hệ thống chặn",
        "specs/validation.spec.ts\n0. Mở ứng dụng (PUBLIC — không đăng nhập)",
    )
    assert not is_login_or_auth_tc("feature after login")
    assert not is_login_or_auth_tc("Login succeeds and leaves login page")
    assert not is_login_or_auth_tc("Establish authenticated session for features")
    # Module/file names containing «auth» must not force Login-TC mode
    assert not is_login_or_auth_tc(
        "Establish authenticated session for features",
        "AItest/E2ETest/AuthSmoke/specs/auth-smoke.spec.ts",
    )
    # Category tag [E2E-Auth/Permission] + phiên đã xác thực = feature, not Login
    assert not is_login_or_auth_tc(
        "[E2E-Auth/Permission] Thêm tài liệu liên quan - Phiên đã xác thực theo Execution Context"
    )
    assert not is_login_or_auth_tc(
        "Thêm tài liệu",
        "AItest/E2ETest/Req/E2E-Auth-Permission-Them/specs/x.spec.ts",
    )
    assert is_login_or_auth_tc("Đăng nhập thành công", "specs/login.spec.ts")
    assert is_login_or_auth_tc("Login fails", "auth/login.spec.ts")


def test_public_no_auth_signals():
    assert is_public_no_auth_signal(
        title="Không đăng nhập - Vẫn xem được danh sách"
    )
    assert is_public_no_auth_signal(
        hints="Không yêu cầu đăng nhập trong phiên bản này."
    )
    assert is_public_no_auth_signal(
        hints="Ngoài phạm vi: Đăng ký / đăng nhập / phân quyền"
    )
    # Happy-path title alone is not enough
    assert not is_public_no_auth_signal(title="Xem danh sách công việc")
    # Landing/home DOM without password must NOT auto-public (JHipster/Angular apps)
    dom = (
        "main heading Danh sách công việc button Thêm mới "
        "listitem ABC checkbox form title description "
        "section todo-list status Chờ xử lý "
    ) * 2
    assert not is_public_no_auth_signal(dom_snapshot=dom)
    login_dom = "heading Đăng nhập textbox Email textbox password button Đăng nhập " * 3
    assert not is_public_no_auth_signal(dom_snapshot=login_dom)


def test_wants_helpers():
    assert wants_storage_state("storage")
    assert not wants_storage_state("ui_helper")
    assert wants_ui_auth_helper("ui_helper")
    assert not wants_ui_auth_helper("storage")
    assert not wants_ui_auth_helper("none")
    assert wants_no_auth_artifacts("none")
