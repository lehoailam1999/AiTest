"""Post-gen Unit TC guard — drop UI/wizard; strip Class.Method from title."""

from __future__ import annotations

from types import SimpleNamespace

from app.services.unit_tc_gen_guard import (
    decide_unit_tc_draft,
    filter_unit_tc_drafts,
    sanitize_unit_tc_title,
)


def test_keeps_backend_br_tc():
    r = decide_unit_tc_draft(
        title="Tạo đơn - Từ chối khi thiếu mã",
        module="Tạo đơn",
        steps="1. Chuẩn bị command thiếu mã\n2. Gọi Handle\n3. Assert exception",
        expected_result="Ném ValidationException",
        test_data="trace: BUSINESS_RULES/BR-1",
    )
    assert r.decision == "keep"
    assert r.code is None


def test_drops_wizard_buoc():
    r = decide_unit_tc_draft(
        title="Thực hiện quy trình tạo vật chứng theo 2 bước - KhoiTao - OK",
        steps="1. Gọi khởi tạo quy trình hai bước\n2. Assert",
        expected_result="Có bước 1 và bước 2",
        test_data="trace: FEATURES/FR-1",
    )
    assert r.decision == "drop"
    assert r.code in ("FAIL_UI_WIZARD", "FAIL_FEATURES_ONLY")


def test_drops_chuyen_buoc():
    r = decide_unit_tc_draft(
        title="Quy trình - KiemTraChuyenBuoc - Từ chối",
        steps="1. Gọi đơn vị chuyển bước\n2. Assert từ chối chuyển sang bước 2",
        expected_result="Không chuyển bước",
        test_data="trace: BUSINESS_RULES/BR-1",
    )
    assert r.decision == "drop"
    assert r.code == "FAIL_UI_WIZARD"


def test_drops_dieu_huong_buoc():
    r = decide_unit_tc_draft(
        title="Điều hướng bước tạo vật chứng - Đã hoàn tất giai đoạn thông tin - Cho phép sang giai đoạn tài liệu",
        steps="1. Đánh dấu hoàn tất giai đoạn\n2. Assert được điều hướng bước tiếp",
        expected_result="Cho phép sang giai đoạn tài liệu",
        test_data="trace: FEATURES/FR-1",
    )
    assert r.decision == "drop"
    assert r.code in ("FAIL_UI_WIZARD", "FAIL_FEATURES_ONLY")


def test_drops_chuyen_giai_doan():
    r = decide_unit_tc_draft(
        title="Tạo mới - Từ chối chuyển giai đoạn khi thông tin chưa hoàn tất - Không cho phép tiếp tục",
        steps="1. Chuẩn bị input thiếu\n2. Gọi đơn vị kiểm tra điều kiện chuyển giai đoạn\n3. Assert từ chối",
        expected_result="Từ chối chuyển sang giai đoạn tài liệu liên quan",
        test_data="trace: BUSINESS_RULES/BR-1",
    )
    assert r.decision == "drop"
    assert r.code == "FAIL_UI_WIZARD"


def test_drops_ui_verbs():
    r = decide_unit_tc_draft(
        title="Đăng nhập - Login - OK",
        steps="1. Điền form\n2. Click nút Đăng nhập\n3. Assert",
        expected_result="Vào trang chủ",
        test_data="trace: FEATURES/FR-1",
    )
    assert r.decision == "drop"
    assert r.code in ("FAIL_UI_VERBS", "FAIL_UI_WIZARD", "FAIL_FEATURES_ONLY")


def test_drops_enable_disable_ui():
    r = decide_unit_tc_draft(
        title="Chọn vị trí - DichVu.TrangThaiTu - Tủ chỉ enable",
        steps="1. Chọn phòng\n2. Assert tủ enable và disable khi chưa chọn",
        expected_result="Tủ mặc định disable; sau chọn phòng thì enable",
        test_data="trace: BUSINESS_RULES/BR-12",
    )
    assert r.decision == "drop"
    assert r.code == "FAIL_UI_ENABLE"


def test_drops_invent_http_without_source_signal():
    r = decide_unit_tc_draft(
        title="Tạo đơn - Từ chối khi thiếu mã",
        module="Tạo đơn",
        steps="1. Gọi Handle\n2. Assert HTTP 400",
        expected_result="Trả về status 400",
        test_data="trace: VALIDATION/V1",
    )
    assert r.decision == "drop"
    assert r.code == "FAIL_NO_SOURCE_SIGNAL"


def test_drops_invent_http_when_only_ir_markers():
    """SRS IR markers alone must not excuse invented HTTP codes."""
    r = decide_unit_tc_draft(
        title="Tạo đơn - Từ chối khi thiếu mã",
        module="Tạo đơn",
        steps="1. Thực hiện tạo mới\n2. Assert HTTP 400",
        expected_result="Trả về status 400",
        test_data=(
            "trace: VALIDATION_DATA/VAL-1\n"
            "primaryBucket: VALIDATION_DATA\n"
            "behaviorId: VAL-1-B01\n"
            "target.constraint: required"
        ),
    )
    assert r.decision == "drop"
    assert r.code == "FAIL_NO_SOURCE_SIGNAL"


def test_keeps_invent_shape_when_layer_hint_present():
    r = decide_unit_tc_draft(
        title="Tạo đơn - Từ chối khi thiếu mã",
        module="Tạo đơn",
        steps="1. Gọi Handle\n2. Assert ValidationException",
        expected_result="Ném ValidationException",
        test_data="trace: VALIDATION/V1\nlayerHint: dto\nsourceSignal: Required",
    )
    assert r.decision == "keep"


def test_drops_soft_ui_without_be_outcome():
    r = decide_unit_tc_draft(
        title="Tạo mới - Hiển thị danh sách - OK",
        steps="1. Người dùng mở form\n2. Xem chi tiết",
        expected_result="Hiển thị danh sách trên UI",
        test_data="trace: FEATURES/FR-1",
    )
    assert r.decision == "drop"
    assert r.code in ("FAIL_SOFT_UI", "FAIL_FEATURES_ONLY", "FAIL_UI_WIZARD")


def test_drops_e2e_type_not_coerced():
    r = decide_unit_tc_draft(
        title="Đăng nhập thành công",
        steps="1. Mở trang\n2. Điền form",
        expected_result="Vào trang chủ",
        test_data="path: /login",
        type="E2E",
    )
    assert r.decision == "drop"
    assert r.code == "FAIL_E2E_TYPE"


def test_keeps_be_with_primary_trace():
    r = decide_unit_tc_draft(
        title="Tạo đơn - Từ chối khi thiếu mã",
        steps="1. Chuẩn bị input thiếu mã\n2. Thực hiện tạo mới\n3. Assert từ chối",
        expected_result="REJECT — từ chối vì bắt buộc",
        test_data="trace: BUSINESS_RULES/BR-1\nprimaryBucket: BUSINESS_RULES\nbehaviorId: BR-1-B01",
    )
    assert r.decision == "keep"


def test_sanitize_strips_latin_class_method():
    cleaned, changed = sanitize_unit_tc_title(
        "Khai báo thiết bị kỹ thuật số - DeviceTypeService.Resolve - "
        "Tạo mới loại thiết bị khi chưa có trong master data"
    )
    assert changed is True
    assert "DeviceTypeService" not in cleaned
    assert cleaned.startswith("Khai báo thiết bị kỹ thuật số")
    assert "Tạo mới loại thiết bị" in cleaned


def test_sanitize_strips_handler_handle():
    cleaned, changed = sanitize_unit_tc_title(
        "Tạo đơn - CreateOrderHandler.Handle - Từ chối khi thiếu mã"
    )
    assert changed is True
    assert "CreateOrderHandler" not in cleaned
    assert cleaned == "Tạo đơn - Từ chối khi thiếu mã"


def test_filter_unit_tc_drafts_sanitizes_title():
    drafts = [
        SimpleNamespace(
            title="OK - Pass",
            module="Order",
            steps="1. Arrange\n2. Act\n3. Assert từ chối",
            expected_result="OK",
            test_data="trace: BUSINESS_RULES/BR-1\nprimaryBucket: BUSINESS_RULES",
            type="Unit",
        ),
        SimpleNamespace(
            title="Wizard theo 2 bước - X - Y",
            module="Flow",
            steps="1. Chuyển bước",
            expected_result="Sang bước 2",
            test_data="trace: FEATURES/F2",
            type="Unit",
        ),
        SimpleNamespace(
            title="Search - CaseSearchHandler.Handle - OK",
            module="Search",
            steps="1. Gọi\n2. Assert",
            expected_result="OK",
            test_data="trace: BUSINESS_RULES/BR-1\nprimaryBucket: BUSINESS_RULES",
            type="Unit",
        ),
    ]
    kept, dropped, sanitized = filter_unit_tc_drafts(drafts)
    assert dropped == 1
    assert sanitized == 1
    assert len(kept) == 2
    search_draft = next(d for d in kept if d.module == "Search")
    assert "CaseSearchHandler" not in search_draft.title
    assert search_draft.title == "Search - OK"
