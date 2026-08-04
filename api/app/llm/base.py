from __future__ import annotations

import json
import re
import hashlib
from dataclasses import dataclass, field


@dataclass
class TestCaseDraft:
    title: str
    steps: str
    expected_result: str
    type: str = "Functional"
    priority: str = "Medium"
    severity: str = "Major"
    module: str | None = None
    precondition: str | None = None
    test_data: str | None = None
    automation_ready: bool = False


@dataclass
class UnitRequest:
    test_case_title: str
    test_case_type: str
    priority: str
    steps: str
    expected_result: str
    precondition: str
    test_data: str
    source_file_name: str
    source_code: str
    class_name: str
    method_name: str
    framework: str
    language: str = ""
    related_sources: list[tuple[str, str]] = field(default_factory=list)
    repair_context: str = ""
    open_api_spec: str = ""
    # Business module from Approved TC — AItest/{Kind}/{Module}/…
    module: str = ""
    # Optional package root from Desktop FS ("" = repo root AItest)
    package_prefix: str | None = None
    # From Desktop context packet (testing stack + strategy)
    testing_framework: str = ""
    mock_framework: str = ""
    assertion_library: str = ""
    source_under_test_summary: str = ""
    unit_strategy_summary: str = ""
    test_samples: list[tuple[str, str]] = field(default_factory=list)
    context_gaps: list[str] = field(default_factory=list)
    requirement_title: str = ""
    requirement_description: str = ""
    # 3-tier AI rules (Project / User) — System lives in unit_system_prompt
    project_rules: str = ""
    user_rules: str = ""


@dataclass
class UnitResult:
    code: str
    suggested_path: str
    file_name: str


def truncate(s: str, n: int) -> str:
    if len(s) <= n:
        return s
    return s[:n] + "\n…[truncated]"


def coerce_tc_text(value: object | None) -> str:
    """Normalize LLM TC fields — models often return steps/expected as list."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value).strip()
    if isinstance(value, list):
        parts: list[str] = []
        for i, item in enumerate(value, 1):
            if isinstance(item, dict):
                chunk = " — ".join(
                    str(v).strip()
                    for v in item.values()
                    if v is not None and str(v).strip()
                )
            else:
                chunk = str(item).strip()
            if not chunk:
                continue
            if re.match(r"^\d+[\.\)]\s*", chunk):
                parts.append(chunk)
            else:
                parts.append(f"{i}. {chunk}")
        return "\n".join(parts).strip()
    if isinstance(value, dict):
        return " — ".join(
            str(v).strip() for v in value.values() if v is not None and str(v).strip()
        ).strip()
    return str(value).strip()


@dataclass
class GenerateContext:
    mode: str = "append"
    content_version: int = 1
    change_summary: str | None = None
    existing_cases: list[tuple[str, str]] = field(default_factory=list)
    source_context: str | None = None
    topic_scope: str | None = None
    scope_topic_notes: str | None = None
    requirement_description: str | None = None
    """System-tier BE rules (tc_generation_rules + engine overlay). Not user-editable."""
    custom_rules: str | None = None
    """Project-tier rules from project.meta.aiRules (auto + extra)."""
    project_rules: str | None = None
    """User-tier freeform rules from project.meta.aiRules.user."""
    user_rules: str | None = None
    feature_titles: list[str] = field(default_factory=list)
    # Studio engine lock: unit | e2e | None (mixed)
    preferred_engine: str | None = None
    # fast | full — E2E default full via tc_speed.resolve_tc_speed_mode
    speed_mode: str | None = None
    # Soft cap: Unit when fast; E2E only if opt-in maxPerModule/env (None = signal-driven)
    max_tc_per_module: int | None = None


# Ví dụ schema-only — placeholder, KHÔNG phải domain mẫu để copy vào dự án thật.
_VIETNAMESE_TC_EXAMPLE_UNIT = (
    '{"testCases":['
    '{"title":"[Tên chức năng trong Phân tích] - [Hàm/method] - [Kết quả kỳ vọng]",'
    '"type":"Unit","priority":"Cao","severity":"Nặng",'
    '"module":"[Tên FEATURES trong Phân tích]",'
    '"precondition":"Mock dependency theo Phân tích/source (nếu có)",'
    '"steps":"1. Chuẩn bị input + mock\\n2. Gọi đơn vị cần test\\n3. Assert kết quả",'
    '"expectedResult":"Return/exception/state đúng mục Phân tích",'
    '"testData":"trace: FEATURES/[tên]; input=... (từ VALIDATION/BR)",'
    '"automationReady":true}'
    "]}"
)

_VIETNAMESE_TC_EXAMPLE_E2E = (
    '{"testCases":['
    '{"title":"[Tên chức năng] - [Hành động người dùng] - [Kết quả trên UI]",'
    '"type":"E2E","priority":"Cao","severity":"Nặng",'
    '"module":"[Tên màn hình/Feature trong tài liệu]",'
    '"precondition":"Điểm bắt đầu theo tài liệu; auth/role chỉ nếu tài liệu yêu cầu",'
    '"steps":"1. [Hành động] -> [Element] -> [Dữ liệu]\\n2. ...\\n3. Kiểm tra kết quả",'
    '"expectedResult":"UI/state đúng tài liệu; URL chỉ khi có điều hướng",'
    '"testData":"baseURL=<target URL nếu job có>; dữ liệu fill từ tài liệu",'
    '"automationReady":true}'
    "]}"
)

_VIETNAMESE_TC_EXAMPLE = (
    '{"testCases":['
    '{"title":"[Chức năng] - [Đơn vị logic] - [Kết quả]",'
    '"type":"Unit","priority":"Cao","severity":"Nặng",'
    '"module":"[Module trong tài liệu]","precondition":"Mock theo tài liệu",'
    '"steps":"1. Gọi đơn vị cần test\\n2. Assert",'
    '"expectedResult":"Kết quả đúng mô tả","testData":"","automationReady":true},'
    '{"title":"[Chức năng] - [Hành động UI] - [Kết quả]",'
    '"type":"E2E","priority":"Cao","severity":"Nặng",'
    '"module":"[Màn hình trong tài liệu]",'
    '"precondition":"Ứng dụng sẵn sàng theo tài liệu",'
    '"steps":"1. Mở màn hình/chức năng\\n2. Thực hiện thao tác\\n3. Kiểm tra UI",'
    '"expectedResult":"Hiển thị/trạng thái đúng tài liệu",'
    '"testData":"theo tài liệu","automationReady":true}'
    "]}"
)

_ENGLISH_TC_HINT = re.compile(
    r"\b(successful|login|password|registration|verify|click|incorrect|reset|"
    r"boundary|validation|credentials|duplicate|expected|user|flow|with|the)\b",
    re.IGNORECASE,
)

_VI_CHARS = re.compile(
    r"[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ"
    r"ÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]",
)


def _field_looks_english(text: str) -> bool:
    text = (text or "").strip()
    if not text:
        return False
    if _VI_CHARS.search(text):
        return False
    if _ENGLISH_TC_HINT.search(text):
        return True
    # Tiêu đề/steps toàn chữ Latin ASCII (vd. "Login with correct credentials") — coi là tiếng Anh
    letters = [c for c in text if c.isalpha()]
    if letters and all(ord(c) < 128 for c in letters):
        vi_tokens = (
            "voi", "khi", "dang", "thanh", "he thong", "nguoi", "mat khau",
            "trang", "nhap", "kiem tra", "du lieu", "ket qua", "buoc",
        )
        lower = text.lower()
        if not any(tok in lower for tok in vi_tokens):
            return True
    return False


def drafts_look_english(drafts: list[TestCaseDraft]) -> bool:
    """Heuristic: model returned English narrative instead of Vietnamese."""
    if not drafts:
        return False
    for d in drafts:
        for field in (d.title, d.steps, d.expected_result, d.precondition or "", d.module or ""):
            if _field_looks_english(field):
                return True
    return False


def vietnamese_translate_prompt(drafts: list[TestCaseDraft]) -> tuple[str, str]:
    """Last-resort: translate existing JSON test cases to Vietnamese."""
    payload = []
    for d in drafts:
        payload.append(
            {
                "title": d.title,
                "type": d.type,
                "priority": d.priority,
                "severity": d.severity,
                "module": d.module,
                "precondition": d.precondition,
                "steps": d.steps,
                "expectedResult": d.expected_result,
                "testData": d.test_data,
                "automationReady": d.automation_ready,
            }
        )
    system = (
        "Bạn là biên dịch test case QA. Nhiệm vụ: chuyển nội dung test case sang TIẾNG VIỆT.\n"
        "Giữ nguyên cấu trúc JSON. Dịch TẤT CẢ: title, type, priority, severity, module, "
        "precondition, steps, expectedResult, testData.\n"
        "type dùng: Unit|E2E|API|Chức năng|Phủ định|Biên (giữ Unit/E2E/API nếu đã đúng engine)\n"
        "priority dùng: Thấp|Trung bình|Cao|Nghiêm trọng\n"
        "severity dùng: Nhẹ|Nặng|Nghiêm trọng\n"
        "Trả CHỈ JSON hợp lệ: {\"testCases\":[...]}"
    )
    user = (
        "Dịch các test case sau sang tiếng Việt hoàn toàn:\n"
        + json.dumps({"testCases": payload}, ensure_ascii=False, indent=2)
    )
    return system, user


def vietnamese_retry_suffix() -> str:
    return (
        "\n\n=== BẮT BUỘC ===\n"
        "Lần trước bạn trả test case bằng tiếng Anh — KHÔNG CHẤP NHẬN.\n"
        "Viết lại TOÀN BỘ bằng tiếng Việt: title, type, priority, severity, module, "
        "precondition, steps, expectedResult, testData.\n"
        "Ví dụ title đúng: «Đăng ký tài khoản thành công» — sai: «Successful user registration».\n"
        "type: Unit|E2E|API|Chức năng|Phủ định|Biên · priority: Thấp|Trung bình|Cao|Nghiêm trọng."
    )


def system_prompt(ctx: GenerateContext | None = None) -> str:
    ctx = ctx or GenerateContext()
    eng = (ctx.preferred_engine or "").strip().lower()
    if eng == "unit":
        type_block = (
            "PHIÊN ENGINE = UNIT: mọi TC type=Unit; không UI/E2E. "
            "SoT + map 11 tiêu chí + trace → khối «UNIT ← PHÂN TÍCH» trong QUY TẮC HỆ THỐNG.\n"
        )
        example = _VIETNAMESE_TC_EXAMPLE_UNIT
        type_schema = "Unit"
    elif eng == "e2e":
        type_block = (
            "PHIÊN ENGINE = E2E: mọi TC type=E2E. "
            "SoT + gate + trace → khối «E2E ← PHÂN TÍCH» trong QUY TẮC HỆ THỐNG.\n"
        )
        example = _VIETNAMESE_TC_EXAMPLE_E2E
        type_schema = "E2E"
    else:
        type_block = (
            "PHÂN LOẠI type (engine):\n"
            "- Unit: test 1 hàm/class/service (không UI browser).\n"
            "- E2E: user journey UI theo tài liệu.\n"
            "- API: HTTP endpoint status/body khi tài liệu mô tả API.\n"
            "- Không gộp Unit+E2E trong cùng một TC — tách 2 case.\n"
        )
        example = _VIETNAMESE_TC_EXAMPLE
        type_schema = "Unit|E2E|API|Chức năng|Phủ định|Biên"

    if eng == "unit":
        doc_usage = (
            "Tài liệu: Freeze/DB Knowledge = SoT; SRS+source bổ sung chi tiết tín hiệu đã có. "
            "Chi tiết coverage → QUY TẮC HỆ THỐNG (UNIT ← PHÂN TÍCH).\n\n"
        )
    elif eng == "e2e":
        doc_usage = (
            "Freeze/DB Knowledge = SoT Output-driven — "
            "chi tiết trong QUY TẮC HỆ THỐNG (E2E ← PHÂN TÍCH).\n\n"
        )
    else:
        doc_usage = (
            "Cách dùng tài liệu:\n"
            "- Knowledge / Phân tích (Freeze hoặc DB) = checklist coverage chính (11 tiêu chí).\n"
            "- User Story / SRS bổ sung chi tiết cho tín hiệu đã có trong Phân tích — không invent bucket mới.\n"
            "- Mỗi feature trong Phân tích = một module; trường module khớp tên feature.\n"
            "- Nếu có «KẾT QUẢ PHÂN TÍCH ĐÃ LƯU DB» hoặc «Knowledge workspace»: cover đủ itemCount>0; [] → bỏ qua.\n"
            "- Nếu có «NGỮ CẢNH SOURCE CODE»: bổ sung nhánh logic cho tín hiệu Phân tích (map class/hàm), không thêm requirement mới.\n"
            "- Không bịa yêu cầu không có trong Phân tích/input.\n\n"
            "CHECKLIST ANTI-MISS (chỉ mục có tín hiệu trong tài liệu):\n"
            "- Happy path, validation/negative, business rules, permission/auth (nếu có), exception, boundary/data integrity.\n"
            "- Không bỏ sót module/chức năng đã xuất hiện trong tài liệu/analysis/source context.\n"
            "- Mỗi TC: thao tác + dữ liệu + expected result kiểm được, bám tài liệu.\n\n"
        )

    base = (
        "Bạn là kỹ sư QA senior. Nhiệm vụ: sinh test case cụ thể từ tài liệu yêu cầu của job hiện tại.\n\n"
        "QUY TẮC NGUỒN (BẮT BUỘC):\n"
        "- Chỉ dựa vào tài liệu/requirement/SRS/User Story/knowledge/source context được cung cấp.\n"
        "- Ví dụ trong prompt chỉ minh họa schema — KHÔNG phải domain để copy (không Todo/Login mẫu).\n"
        "- Không giả định auth/email/CRUD/URL nếu tài liệu không nêu.\n\n"
        "QUY TẮC NGÔN NGỮ (BẮT BUỘC — vi phạm là sai):\n"
        "- title, steps, expectedResult, precondition, testData, priority, severity, module: TIẾNG VIỆT.\n"
        f"- Trường type: {type_schema} "
        "(Unit/E2E/API là nhãn engine — giữ nguyên tiếng Anh).\n"
        "- KHÔNG dùng tiếng Anh cho tiêu đề, bước, kết quả.\n"
        "- Dù requirement đầu vào là tiếng Anh, vẫn phải viết test case bằng tiếng Việt.\n\n"
        f"{type_block}\n"
        f"{doc_usage}"
        "Trả về CHỈ JSON hợp lệ (không markdown), đúng schema:\n"
        f'{{"testCases":[{{"title":"...","type":"{type_schema}",'
        '"priority":"Thấp|Trung bình|Cao|Nghiêm trọng","severity":"Nhẹ|Nặng|Nghiêm trọng",'
        '"module":"...","precondition":"...","steps":"1. ...\\n2. ...",'
        '"expectedResult":"...","testData":"...","automationReady":false}]}\n\n'
        f"Ví dụ schema (placeholder — thay bằng nội dung từ tài liệu):\n{example}\n"
    )
    eng_for_cap = (ctx.preferred_engine or "").strip().lower()
    # E2E: no default numeric ceiling — only Unit/mixed use soft-cap language when max set.
    use_numeric_cap = (
        eng_for_cap != "e2e"
        and ctx.speed_mode == "fast"
        and bool(ctx.max_tc_per_module)
    )
    if ctx.mode == "append" and ctx.existing_cases and not ctx.topic_scope:
        base += (
            "\nCHẾ ĐỘ BỔ SUNG: Đã có test case bên dưới.\n"
            "Chỉ sinh test case MỚI cho phần còn thiếu — không trùng hoặc paraphrase nhẹ.\n"
            "Cover HẾT gap còn lại (mọi FR/AC/rule chưa có TC) — không trần «chỉ 1–3 case».\n"
            "Nếu đã đủ coverage thật sự thì trả mảng rỗng [] (không bịa).\n"
            "Test case mới vẫn phải 100% tiếng Việt.\n"
        )
    elif ctx.topic_scope:
        if use_numeric_cap:
            base += (
                f"\nSinh test case cho ĐÚNG một chức năng trong phạm vi chủ đề. "
                f"SPEED: ưu tiên journey/nhánh chính — tối đa ~{ctx.max_tc_per_module} TC. "
                f"Toàn bộ nội dung tiếng Việt."
            )
        else:
            base += (
                "\nSinh test case cho ĐÚNG một chức năng trong phạm vi chủ đề. "
                "Cover từng FR/AC/business rule/validation/permission/error/boundary trong phạm vi "
                "(≥1 TC mỗi tín hiệu độc lập). "
                "KHÔNG trần số lượng — sinh đủ kịch bản; không dừng sớm sau vài case. "
                "Cấm TC thừa/trùng. Toàn bộ nội dung tiếng Việt."
            )
    else:
        n = len(ctx.feature_titles)
        if n > 1:
            if use_numeric_cap:
                base += (
                    f"\nTài liệu có {n} chức năng (Feature). "
                    f"SPEED: mỗi module ≤~{ctx.max_tc_per_module} TC ưu tiên chính. "
                    f"Trường module khớp tên Feature. Toàn bộ nội dung tiếng Việt."
                )
            else:
                base += (
                    f"\nTài liệu có {n} chức năng (Feature). "
                    "Mỗi chức năng: cover HẾT FR/AC/rule/validation có tín hiệu "
                    "(≥1 TC mỗi kịch bản độc lập; happy + negative + biên + exception khi có). "
                    "KHÔNG trần số lượng theo module. Cấm TC thừa/trùng. "
                    "Trường module PHẢI khớp đúng tên từng Feature. "
                    "Không được chỉ sinh TC cho 1–2 module rồi bỏ qua phần còn lại. "
                    "Toàn bộ nội dung tiếng Việt."
                )
        else:
            if use_numeric_cap:
                base += (
                    f"\nSPEED: ưu tiên FR/AC chính — tối đa ~{ctx.max_tc_per_module} TC. "
                    f"Bám tài liệu; không bịa. Toàn bộ nội dung tiếng Việt."
                )
            else:
                base += (
                    "\nSinh test case phủ HẾT FR/AC/business rule/validation/API/use-case trong tài liệu "
                    "(≥1 TC mỗi tín hiệu độc lập). "
                    "KHÔNG trần số lượng — không dừng sớm vì «đã có vài case». "
                    "Cấm TC thừa/trùng. Bám sát tài liệu + phân tích — không bỏ sót luồng đã nêu. "
                    "Toàn bộ nội dung tiếng Việt."
                )
    if eng_for_cap == "e2e" or use_numeric_cap:
        from app.llm.tc_speed import speed_prompt_addon

        base += speed_prompt_addon(
            speed=ctx.speed_mode or "full",
            max_per_module=ctx.max_tc_per_module,
            preferred_engine=ctx.preferred_engine,
        )
    if ctx.custom_rules or ctx.project_rules or ctx.user_rules:
        from app.llm.ai_rules import format_layered_rules_block

        # System extra: Unit SoT block is prepended in engine rules — keep full under cap.
        # Unit/E2E both prepend analysis SoT — keep cap room for contract + overlay.
        eng_cap = 2200 if ctx.speed_mode == "fast" else (4200 if eng in ("unit", "e2e") else 4000)
        sys_extra = truncate(ctx.custom_rules or "", eng_cap) if ctx.custom_rules else ""
        block = format_layered_rules_block(
            system_extra=sys_extra,
            project_rules=ctx.project_rules or "",
            user_rules=ctx.user_rules or "",
            system_label="QUY TẮC HỆ THỐNG (System — BE, không sửa từ UI)",
        )
        if block:
            base += f"\n\n{block}\n"
    return base


def cursor_tc_hidden_chat_enabled() -> bool:
    """
    Env AITEST_TC_CURSOR_HIDDEN_CHAT — per-module create-chat + 2-turn (seed→gen).

    Default OFF: oneshot 1 call/module is ~2–3× faster wall-clock than hidden 2-turn.
    Set AITEST_TC_CURSOR_HIDDEN_CHAT=1 when token budget matters more than speed.
    """
    import os

    raw = (os.environ.get("AITEST_TC_CURSOR_HIDDEN_CHAT") or "0").strip().lower()
    return raw in ("1", "true", "yes", "on")


def tc_seed_prompt(ctx: GenerateContext | None = None) -> str:
    """
    Turn 0 for Cursor hidden chat — rules + schema only (no Knowledge/source).
    Keep under ~3–4k chars so resume turns can send delta only.
    """
    ctx = ctx or GenerateContext()
    eng = (ctx.preferred_engine or "").strip().lower()
    if eng == "unit":
        type_schema = "Unit"
        type_line = "ENGINE=UNIT: mọi TC type=Unit (hàm/service/API handler — không browser UI)."
        example = _VIETNAMESE_TC_EXAMPLE_UNIT
    elif eng == "e2e":
        type_schema = "E2E"
        type_line = "ENGINE=E2E: mọi TC type=E2E (journey UI từ Output Phân tích)."
        example = _VIETNAMESE_TC_EXAMPLE_E2E
    else:
        type_schema = "Unit|E2E|API|Chức năng|Phủ định|Biên"
        type_line = "Phân loại type theo tài liệu (Unit/E2E/API) — không gộp Unit+E2E trong 1 TC."
        example = _VIETNAMESE_TC_EXAMPLE

    use_numeric_cap = (
        eng != "e2e"
        and ctx.speed_mode == "fast"
        and bool(ctx.max_tc_per_module)
    )
    if use_numeric_cap:
        from app.llm.tc_speed import speed_prompt_addon

        seed = (
            "Bạn là QA senior. Đây là TURN SEED (conversation ngầm) — ghi nhớ quy tắc; "
            "CHƯA sinh test case. Turn sau sẽ gửi đúng 1 module + tài liệu liên quan.\n\n"
            f"{type_line}\n"
            "Ngôn ngữ: title/steps/expectedResult/precondition/testData/module = TIẾNG VIỆT.\n"
            "Chỉ dựa vào tài liệu turn sau cung cấp — không bịa domain.\n"
            f"SPEED: mỗi module ≤~{ctx.max_tc_per_module} TC ưu tiên chính "
            "(happy + validation + permission/boundary nếu có).\n\n"
            "Output turn sau: CHỈ JSON "
            f'{{"testCases":[{{"title","type":"{type_schema}",'
            '"priority":"Thấp|Trung bình|Cao|Nghiêm trọng","severity":"Nhẹ|Nặng|Nghiêm trọng",'
            '"module","precondition","steps","expectedResult","testData","automationReady":false}]}}\n'
            f"Ví dụ schema (placeholder):\n{example}\n"
            "Trả lời turn này đúng 1 dòng: READY"
        )
        seed += speed_prompt_addon(
            speed=ctx.speed_mode,
            max_per_module=ctx.max_tc_per_module,
            preferred_engine=ctx.preferred_engine,
        )
    elif eng == "e2e":
        from app.llm.tc_speed import speed_prompt_addon

        seed = (
            "Bạn là QA senior. Đây là TURN SEED (conversation ngầm) — ghi nhớ quy tắc; "
            "CHƯA sinh test case. Turn sau sẽ gửi đúng 1 module + tài liệu liên quan.\n\n"
            f"{type_line}\n"
            "Ngôn ngữ: title/steps/expectedResult/precondition/testData/module = TIẾNG VIỆT.\n"
            "Chỉ dựa vào tài liệu turn sau cung cấp — không bịa domain.\n"
            "Mỗi lần gen (turn sau): CHỈ 1 module; cover đủ tín hiệu Output "
            "(≥1 TC/tín hiệu độc lập). KHÔNG trần số TC cố định; cấm TC thừa/trùng.\n\n"
            "Output turn sau: CHỈ JSON "
            f'{{"testCases":[{{"title","type":"{type_schema}",'
            '"priority":"Thấp|Trung bình|Cao|Nghiêm trọng","severity":"Nhẹ|Nặng|Nghiêm trọng",'
            '"module","precondition","steps","expectedResult","testData","automationReady":false}]}}\n'
            f"Ví dụ schema (placeholder):\n{example}\n"
            "Trả lời turn này đúng 1 dòng: READY"
        )
        seed += speed_prompt_addon(
            speed=ctx.speed_mode or "full",
            max_per_module=ctx.max_tc_per_module,
            preferred_engine=ctx.preferred_engine,
        )
    else:
        seed = (
            "Bạn là QA senior. Đây là TURN SEED (conversation ngầm) — ghi nhớ quy tắc; "
            "CHƯA sinh test case. Turn sau sẽ gửi đúng 1 module + tài liệu liên quan.\n\n"
            f"{type_line}\n"
            "Ngôn ngữ: title/steps/expectedResult/precondition/testData/module = TIẾNG VIỆT.\n"
            "Chỉ dựa vào tài liệu turn sau cung cấp — không bịa domain.\n"
            "Mỗi lần gen (turn sau): CHỈ 1 module trong scope; sinh ĐỦ TC cho mọi tín hiệu "
            "FR/AC/rule/validation/error/boundary của module đó (≥1 TC/tín hiệu độc lập). "
            "KHÔNG trần số lượng — không dừng sớm; không tham chiếu module khác.\n\n"
            "Output turn sau: CHỈ JSON "
            f'{{"testCases":[{{"title","type":"{type_schema}",'
            '"priority":"Thấp|Trung bình|Cao|Nghiêm trọng","severity":"Nhẹ|Nặng|Nghiêm trọng",'
            '"module","precondition","steps","expectedResult","testData","automationReady":false}]}}\n'
            f"Ví dụ schema (placeholder):\n{example}\n"
            "Trả lời turn này đúng 1 dòng: READY"
        )
    if ctx.custom_rules or ctx.project_rules or ctx.user_rules:
        from app.llm.ai_rules import format_layered_rules_block

        block = format_layered_rules_block(
            system_extra=truncate(ctx.custom_rules or "", 2500) if ctx.custom_rules else "",
            project_rules=ctx.project_rules or "",
            user_rules=ctx.user_rules or "",
            system_label="QUY TẮC HỆ THỐNG (System — engine)",
        )
        if block:
            seed += f"\n\n{block}\n"
    return seed


def tc_module_gen_user_prompt(
    title: str, content: str, ctx: GenerateContext | None = None
) -> str:
    """
    Turn 1 for Cursor hidden chat — module slice + source only (rules already seeded).
    Anti-lazy: force ONLY this module; cover ALL document signals (no artificial count cap).
    """
    ctx = ctx or GenerateContext()
    module = ""
    if ctx.feature_titles:
        module = str(ctx.feature_titles[0] or "").strip()
    if not module and ctx.topic_scope:
        import re as _re

        m = _re.search(r"\*\*(.+?)\*\*", ctx.topic_scope or "")
        if m:
            module = m.group(1).strip()
        else:
            module = (ctx.topic_scope or "").splitlines()[0].strip()[:120]
    module = module or "(module)"

    parts = [
        f"## GEN TURN — Sinh TC cho ĐÚNG một module",
        f"Requirement: {title}",
        f"Module BẮT BUỘC: «{module}» (trường module trên mọi TC = đúng tên này).",
        "",
        "ANTI-LAZY (bắt buộc):",
        f"- CHỈ sinh TC cho «{module}» — bỏ qua / không tham chiếu module khác.",
    ]
    eng_mod = (ctx.preferred_engine or "").strip().lower()
    use_numeric_cap = (
        eng_mod != "e2e"
        and ctx.speed_mode == "fast"
        and bool(ctx.max_tc_per_module)
    )
    if use_numeric_cap:
        parts.extend(
            [
                f"- SPEED: tối đa ~{ctx.max_tc_per_module} TC — ưu tiên happy + validation "
                "quan trọng + permission/boundary nếu có tín hiệu.",
                "- Không bịa journey phụ; đủ ý nghĩa thì dừng.",
                "- Toàn bộ nội dung tiếng Việt. Trả CHỈ JSON {\"testCases\":[...]}.",
            ]
        )
    else:
        parts.extend(
            [
                "- Cover HẾT tín hiệu trong slice: mỗi FR/AC/business rule/validation/permission/"
                "error/boundary độc lập → ≥1 TC MỚI (happy + negative khi có rule).",
                "- KHÔNG trần số lượng giả tạo. Sinh đủ rồi mới dừng; không bịa ngoài tài liệu.",
                "- Cấm TC thừa: trùng trace, cùng flow+expected chỉ đổi wording.",
                "- Không nói «đã cover», không trả mảng rỗng khi còn tín hiệu, không tóm tắt thay vì JSON.",
                "- Toàn bộ nội dung tiếng Việt. Trả CHỈ JSON {\"testCases\":[...]}.",
            ]
        )
    if ctx.topic_scope:
        parts.append("## Phạm vi chủ đề\n" + truncate(ctx.topic_scope, 2000))
    body = (content or "").strip()
    if body:
        parts.append(
            "## Tài liệu / Knowledge (slice module)\n" + truncate(body, 12_000)
        )
    if ctx.source_context:
        parts.append("## Source context\n" + truncate(ctx.source_context, 8_000))
    if ctx.existing_cases:
        lines = [f"- {t} ({typ})" for t, typ in ctx.existing_cases[:15]]
        parts.append(
            "## TC đã có (không trùng title)\n"
            + "\n".join(lines)
            + (
                f"\n… và {len(ctx.existing_cases) - 15} case khác"
                if len(ctx.existing_cases) > 15
                else ""
            )
        )
    if use_numeric_cap:
        parts.append(
            f"Sinh ngay JSON testCases cho module «{module}» — ≤~{ctx.max_tc_per_module} TC ưu tiên chính."
        )
    else:
        parts.append(
            f"Sinh ngay JSON testCases cho module «{module}» — đủ mọi kịch bản độc lập trong slice "
            "(không trần số lượng; cấm TC thừa)."
        )
    return "\n\n".join(parts)


def user_prompt(title: str, content: str, ctx: GenerateContext | None = None) -> str:
    ctx = ctx or GenerateContext()
    from app.features.requirement_studio.snapshot_prompt import is_freeze_snapshot_prompt
    from app.services.requirement_content import (
        SECTION_NOTES,
        SECTION_SRS,
        SECTION_USER_STORY,
        find_feature_for_scope,
        normalize_function_label,
        enrich_features_with_files,
        parse_features,
        parse_sections,
    )

    snapshot_mode = is_freeze_snapshot_prompt(content)
    sections = parse_sections(content) if not snapshot_mode else {}
    features = enrich_features_with_files(
        parse_features(content), ctx.requirement_description
    )
    if not ctx.feature_titles and features:
        ctx.feature_titles = [
            normalize_function_label(f.get("title") or "") or f.get("title") or f"Chức năng {i}"
            for i, f in enumerate(features, 1)
        ]
    parts = [
        f"Tiêu đề requirement: {title}",
        f"Phiên bản tài liệu: v{ctx.content_version}",
        "YÊU CẦU ĐẦU RA: Tất cả test case phải viết bằng TIẾNG VIỆT (title, steps, expectedResult, ...).",
    ]

    if ctx.change_summary:
        parts.append(f"## Thay đổi so với bản trước\n{truncate(ctx.change_summary, 2000)}")

    # Prefer live DB inventory over freeze inventory when both exist
    content_body = content
    if (
        snapshot_mode
        and ctx.existing_cases
        and "## Existing test cases" in (content or "")
    ):
        from app.features.requirement_studio.snapshot_prompt import (
            strip_freeze_existing_tcs_section,
        )

        content_body = strip_freeze_existing_tcs_section(content)

    if snapshot_mode and not ctx.topic_scope:
        parts.append(
            "## Snapshot đã freeze (NGUỒN CHÍNH — đọc hết, không bỏ sót FR/AC/rule)\n"
            + truncate(content_body, 52_000)
        )
        if ctx.source_context:
            # Source/code only here — analysis already inside freeze when present
            parts.append(truncate(ctx.source_context, 40_000))
        if ctx.existing_cases:
            lines = [f"- {t} ({typ})" for t, typ in ctx.existing_cases[:40]]
            parts.append(
                "## Test case đã có (không trùng)\n"
                + "\n".join(lines)
                + (
                    f"\n… và {len(ctx.existing_cases) - 40} case khác"
                    if len(ctx.existing_cases) > 40
                    else ""
                )
            )
        parts.append(
            "## Nhắc lại\n"
            "Trả JSON tiếng Việt. Phải cover đủ mọi FR/AC/business rule/validation/API/use case "
            "trong snapshot (và source context nếu có) — ≥1 TC mỗi tín hiệu độc lập; "
            "KHÔNG trần số lượng, không dừng sớm."
        )
        return "\n\n".join(parts)

    if snapshot_mode and ctx.topic_scope:
        parts.append("## Phạm vi chủ đề (bắt buộc)\n" + truncate(ctx.topic_scope, 4000))
        parts.append(
            "## Snapshot đã freeze (chỉ sinh TC cho module trong phạm vi — đọc hết FR/AC liên quan)\n"
            + truncate(content_body, 22_000)
        )
        if ctx.source_context:
            parts.append(truncate(ctx.source_context, 16_000))
        if ctx.existing_cases:
            lines = [f"- {t} ({typ})" for t, typ in ctx.existing_cases[:40]]
            parts.append(
                "## Test case đã có (không trùng)\n"
                + "\n".join(lines)
                + (
                    f"\n… và {len(ctx.existing_cases) - 40} case khác"
                    if len(ctx.existing_cases) > 40
                    else ""
                )
            )
        parts.append(
            "## Nhắc lại\n"
            "Trả JSON tiếng Việt. Chỉ sinh TC cho module trong phạm vi chủ đề; "
            "cover đủ FR/AC/rule thuộc module đó (≥1 TC/tín hiệu) — "
            "KHÔNG trần số lượng, không dừng sớm."
        )
        return "\n\n".join(parts)

    if sections.get(SECTION_USER_STORY):
        parts.append(
            "## User Story\n"
            + truncate(sections[SECTION_USER_STORY], 6000)
        )
    if sections.get(SECTION_SRS):
        parts.append(
            "## SRS\n"
            + truncate(sections[SECTION_SRS], 6000)
        )
    if sections.get(SECTION_NOTES):
        note_limit = 16_000 if len(content or "") > 12_000 else 4000
        parts.append(
            "## Yêu cầu (Requirement)\n"
            + truncate(sections[SECTION_NOTES], note_limit)
        )

    if features and not ctx.topic_scope:
        per = 5500 if len(features) <= 3 else (4000 if len(features) <= 6 else 3000)
        names = ctx.feature_titles or [
            (f.get("title") or f"Chức năng {i}").strip() for i, f in enumerate(features, 1)
        ]
        feat_parts = [
            f"## Chức năng / Feature ({len(features)} file/module — PHẢI cover đủ tất cả)",
            "CHECKLIST (trước khi trả JSON, đảm bảo):",
            *[f"- [{i}] {names[i - 1]}: có ≥1 happy path + ≥2 negative/biên từ tài liệu Feature {i}"
              for i in range(1, len(features) + 1)],
        ]
        for i, f in enumerate(features, 1):
            fname = names[i - 1] if i - 1 < len(names) else (f.get("title") or f"Chức năng {i}").strip()
            body = truncate(f.get("content") or "", per)
            feat_parts.append(
                f"### Feature {i}: {fname}\n"
                f"(Mọi TC thuộc chức năng này: module = «{fname}»)\n{body}"
            )
        parts.append("\n\n".join(feat_parts))

    if (
        not features
        and not any(sections.get(k) for k in (SECTION_USER_STORY, SECTION_SRS, SECTION_NOTES))
    ):
        parts.append(f"## Nội dung\n{truncate(content, 12000)}")

    if ctx.topic_scope:
        parts.append("## Phạm vi chủ đề (bắt buộc)\n" + truncate(ctx.topic_scope, 4000))
        import re as _re

        scope_title = ""
        m = _re.search(r"\*\*(.+?)\*\*", ctx.topic_scope or "")
        if m:
            scope_title = (m.group(1) or "").strip()
        feat = find_feature_for_scope(features, scope_title, ctx.scope_topic_notes)
        if feat and (feat.get("content") or "").strip():
            fname = normalize_function_label(feat.get("title") or scope_title) or scope_title
            parts.append(
                "## Tài liệu chức năng trong phạm vi (đọc hết)\n"
                f"(Mọi TC: module = «{fname}»)\n"
                + truncate(feat.get("content") or "", 16000)
            )
        elif features:
            names = ", ".join(
                normalize_function_label(f.get("title") or "") or f"Chức năng {i}"
                for i, f in enumerate(features, 1)
            )
            parts.append(
                "## Lỗi ghép tài liệu — vẫn phải sinh TC\n"
                f"Chủ đề job: «{scope_title}». Không tìm thấy khối Feature khớp tuyệt đối.\n"
                f"Các chức năng trong requirement: {names}.\n"
                "Chỉ sinh TC cho chủ đề trên; nếu nội dung Feature tương ứng có trong các khối dưới, bám đúng tài liệu đó."
            )
            for i, f in enumerate(features, 1):
                ft = normalize_function_label(f.get("title") or "") or f"Chức năng {i}"
                if scope_title and normalize_function_label(scope_title).lower() in ft.lower():
                    parts.append(
                        "## Tài liệu chức năng (khớp gần đúng)\n"
                        + truncate(f.get("content") or "", 16000)
                    )
                    break
    if ctx.source_context:
        parts.append(ctx.source_context)

    if ctx.existing_cases:
        lines = [f"- {t} ({typ})" for t, typ in ctx.existing_cases[:40]]
        parts.append(
            "## Test case đã có (không trùng)\n"
            + "\n".join(lines)
            + (f"\n… và {len(ctx.existing_cases) - 40} case khác" if len(ctx.existing_cases) > 40 else "")
        )

    parts.append(
        "## Nhắc lại\n"
        "Trả JSON với title/steps/expectedResult/precondition/testData/module bằng tiếng Việt. "
        "Không dùng câu tiếng Anh như 'Verify that', 'Click Login', 'Expected result'. "
        + (
            f"Phải có test case cho cả {len(features)} chức năng: "
            + ", ".join(ctx.feature_titles[:12])
            + ("…" if len(ctx.feature_titles) > 12 else "")
            + "."
            if features and not ctx.topic_scope and ctx.feature_titles
            else (
                f"Phải có test case cho cả {len(features)} chức năng (module khác nhau)."
                if features and not ctx.topic_scope
                else ""
            )
        )
    )

    return "\n\n".join(parts)


def _extract_balanced_objects(text: str) -> list[str]:
    """Return complete `{...}` slices (string-aware) from truncated LLM output."""
    objs: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        if text[i] != "{":
            i += 1
            continue
        depth = 0
        in_str = False
        esc = False
        start = i
        j = i
        while j < n:
            ch = text[j]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
            else:
                if ch == '"':
                    in_str = True
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        objs.append(text[start : j + 1])
                        i = j + 1
                        break
            j += 1
        else:
            # Truncated mid-object: skip this '{' and keep looking for later complete ones
            # (e.g. wrapper {"testCases":[... never closed, but inner TCs are complete).
            i = start + 1
            continue
        continue
    return objs


def salvage_test_cases_from_truncated(raw: str) -> list[dict]:
    """
    When LLM hits max tokens mid-JSON, keep every complete test-case object
    that already has title + steps + expectedResult.
    """
    raw = (raw or "").strip()
    if not raw:
        return []
    if raw.startswith("```"):
        raw = raw.removeprefix("```json").removeprefix("```JSON").removeprefix("```").strip()
        idx = raw.rfind("```")
        if idx >= 0:
            raw = raw[:idx]
        raw = raw.strip()

    # Prefer scanning inside testCases array so we don't waste work on the wrapper.
    scan = raw
    for key in ('"testCases"', '"test_cases"', '"cases"', '"items"'):
        k = raw.find(key)
        if k >= 0:
            bracket = raw.find("[", k)
            if bracket >= 0:
                scan = raw[bracket + 1 :]
                break

    out: list[dict] = []
    for chunk in _extract_balanced_objects(scan):
        try:
            obj = json.loads(chunk)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue
        # wrapper { "testCases": [ ... ] } — only fully closed arrays parse; skip
        if "title" not in obj and ("testCases" in obj or "test_cases" in obj):
            continue
        title = coerce_tc_text(obj.get("title"))
        steps = coerce_tc_text(obj.get("steps"))
        expected = coerce_tc_text(
            obj.get("expectedResult") or obj.get("expected_result") or obj.get("expected")
        )
        if title and steps and expected:
            out.append(obj)
    return out


def parse_test_cases_json(raw: str) -> list[TestCaseDraft]:
    from app.services.vietnamese_labels import priority_vi, severity_vi, type_vi

    raw = (raw or "").strip()
    if not raw:
        raise ValueError("LLM returned empty response")

    if raw.startswith("```"):
        raw = raw.removeprefix("```json").removeprefix("```JSON").removeprefix("```").strip()
        idx = raw.rfind("```")
        if idx >= 0:
            raw = raw[:idx]
        raw = raw.strip()

    data = None
    parse_exc: Exception | None = None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        parse_exc = exc
        start_obj = raw.find("{")
        start_arr = raw.find("[")
        starts = [i for i in (start_obj, start_arr) if i >= 0]
        if starts:
            start = min(starts)
            candidate = raw[start:]
            decoder = json.JSONDecoder()
            try:
                data, _ = decoder.raw_decode(candidate)
                parse_exc = None
            except json.JSONDecodeError as exc2:
                parse_exc = exc2

    items = None
    if data is not None:
        items = data.get("testCases") if isinstance(data, dict) else data
        if isinstance(data, dict) and items is None:
            items = data.get("test_cases") or data.get("cases") or data.get("items")

    if not isinstance(items, list):
        salvaged = salvage_test_cases_from_truncated(raw)
        if salvaged:
            items = salvaged
        elif parse_exc is not None:
            raise ValueError(
                f"parse LLM JSON: {parse_exc} "
                "(thường do response bị cắt max_tokens — hãy sinh theo từng chức năng / phạm vi module)"
            ) from parse_exc
        else:
            raise ValueError("LLM returned no valid test cases")

    def _draft_from_obj(tc: dict) -> TestCaseDraft | None:
        title = coerce_tc_text(tc.get("title"))
        steps = coerce_tc_text(tc.get("steps"))
        expected = coerce_tc_text(
            tc.get("expectedResult") or tc.get("expected_result") or tc.get("expected")
        )
        if not title or not steps or not expected:
            return None
        pre = coerce_tc_text(tc.get("precondition")) or None
        module = coerce_tc_text(tc.get("module")) or None
        test_data = (
            coerce_tc_text(tc.get("testData") or tc.get("test_data")) or None
        )
        return TestCaseDraft(
            title=title,
            steps=steps,
            expected_result=expected,
            type=type_vi(tc.get("type")),
            priority=priority_vi(tc.get("priority")),
            severity=severity_vi(tc.get("severity")),
            module=module,
            precondition=pre,
            test_data=test_data,
            automation_ready=bool(tc.get("automationReady", tc.get("automation_ready", False))),
        )

    out: list[TestCaseDraft] = []
    for tc in items:
        if not isinstance(tc, dict):
            continue
        draft = _draft_from_obj(tc)
        if draft:
            out.append(draft)
    if not out:
        salvaged = salvage_test_cases_from_truncated(raw)
        for tc in salvaged:
            draft = _draft_from_obj(tc)
            if draft:
                out.append(draft)
    if not out:
        raise ValueError(
            "LLM returned no valid test cases "
            "(JSON có thể bị cắt — thử phạm vi «Theo module» hoặc «Toàn hệ thống» fan-out từng chức năng)"
        )
    return out


# --- Unit test prompt helpers ---

_CLASS_RE = re.compile(
    r"(?m)^\s*(?:public\s+|internal\s+|export\s+)?(?:static\s+|sealed\s+|abstract\s+|partial\s+|default\s+)*"
    r"(?:class|interface|struct|enum|type|def|fn|func)\s+(\w+)"
)


def infer_language(req: UnitRequest) -> str:
    lang = (req.language or "").strip()
    if lang:
        return lang
    name = (req.source_file_name or "").lower()
    if name.endswith(".cs"):
        return "C#"
    if name.endswith((".ts", ".tsx")):
        return "TypeScript"
    if name.endswith((".js", ".jsx")):
        return "JavaScript"
    if name.endswith(".py"):
        return "Python"
    if name.endswith(".go"):
        return "Go"
    if name.endswith(".rs"):
        return "Rust"
    if name.endswith(".java"):
        return "Java"
    if name.endswith(".kt"):
        return "Kotlin"
    return "auto"


def normalize_framework(fw: str, language: str = "") -> str:
    v = (fw or "").strip().lower()
    lang = (language or "").lower()
    node_fws = ("jest", "vitest", "mocha")
    dotnet_fws = ("xunit", "nunit", "mstest")
    if any(x in lang for x in ("c#", "csharp", ".net")) and v in node_fws:
        v = "xunit"
    if (
        any(x in lang for x in ("typescript", "javascript", "node"))
        and v in dotnet_fws
    ):
        v = "jest"
    if not v or v in ("auto", "default"):
        if "c#" in lang or "csharp" in lang or ".net" in lang:
            return "xUnit"
        if "python" in lang:
            return "pytest"
        if "typescript" in lang or "javascript" in lang:
            return "Jest"
        if "go" in lang:
            return "go test"
        if "java" in lang or "kotlin" in lang:
            return "JUnit"
        if "rust" in lang:
            return "cargo test"
        return "unit test framework phù hợp ngôn ngữ nguồn"
    aliases = {
        "xunit": "xUnit",
        "nunit": "NUnit",
        "mstest": "MSTest",
        "jest": "Jest",
        "vitest": "Vitest",
        "mocha": "Mocha",
        "pytest": "pytest",
        "unittest": "unittest",
        "junit": "JUnit",
        "testng": "TestNG",
        "gotest": "go test",
        "cargo": "cargo test",
    }
    return aliases.get(v, fw.strip())


def or_dash(s: str) -> str:
    return s if (s or "").strip() else "-"


def guess_class_name(file_name: str, source: str) -> str:
    m = _CLASS_RE.search(source or "")
    if m:
        return m.group(1)
    import os

    base = os.path.splitext(os.path.basename(file_name or ""))[0].strip()
    if not base or base == ".":
        return "Target"
    return base


def sanitize_file_name(name: str) -> str:
    name = (name or "").strip()
    if not name:
        return "Generated"
    out = "".join(c for c in name if c.isalnum() or c == "_")
    return out or "Generated"


def unit_file_extension(language: str, source_file_name: str) -> str:
    name = (source_file_name or "").lower()
    for ext in (".cs", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt"):
        if name.endswith(ext):
            return ext
    lang = (language or "").lower()
    if "c#" in lang or "csharp" in lang:
        return ".cs"
    if "typescript" in lang:
        return ".ts"
    if "javascript" in lang:
        return ".js"
    if "python" in lang:
        return ".py"
    if "go" in lang:
        return ".go"
    if "rust" in lang:
        return ".rs"
    if "java" in lang:
        return ".java"
    if "kotlin" in lang:
        return ".kt"
    return ".txt"


def suggest_unit_path(
    language: str,
    class_name: str,
    source_file_name: str = "",
    framework: str = "",
    module: str = "",
    package_prefix: str | None = None,
) -> tuple[str, str]:
    """Return (relative_path, file_name) under [{pkg}/]AItest/UnitTest/{Module}/…"""
    from app.services.test_output_layout import (
        file_name_from_source,
        under_generated_test_folder,
    )

    lang = (language or "").strip()
    if not lang:
        name = (source_file_name or "").lower()
        if name.endswith(".cs"):
            lang = "C#"
        elif name.endswith((".ts", ".tsx")):
            lang = "TypeScript"
        elif name.endswith((".js", ".jsx")):
            lang = "JavaScript"
        elif name.endswith(".py"):
            lang = "Python"
        elif name.endswith(".go"):
            lang = "Go"
        elif name.endswith(".rs"):
            lang = "Rust"
        elif name.endswith(".java"):
            lang = "Java"
        elif name.endswith(".kt"):
            lang = "Kotlin"
        else:
            lang = "auto"

    base = sanitize_file_name(class_name or "Target")
    fw = (framework or "").lower()
    lang_l = lang.lower()
    src = (source_file_name or "").replace("\\", "/").lstrip("./")

    if "rust" in lang_l and not src:
        file_name = f"{base.lower()}_test.rs"
    elif (
        "typescript" in lang_l
        or "javascript" in lang_l
        or any(x in fw for x in ("jest", "vitest", "mocha"))
        or "python" in lang_l
        or "pytest" in fw
        or "go" in lang_l
        or "java" in lang_l
        or "kotlin" in lang_l
        or "c#" in lang_l
        or "csharp" in lang_l
        or any(x in fw for x in ("xunit", "nunit", "mstest", "junit", "unittest"))
    ):
        file_name = file_name_from_source(
            src,
            language=lang,
            class_name=base,
            kind="unit",
        )
    else:
        ext = unit_file_extension(lang, source_file_name)
        file_name = f"{base}Tests{ext}"

    path = under_generated_test_folder(
        "unit",
        file_name,
        source_file_name=src or None,
        module=module or None,
        package_prefix=package_prefix,
    )
    return path, file_name


def strip_code_fences(raw: str) -> str:
    """
    Lấy nội dung trong fence ```…```.
    CLI (Cursor) thường prepend đoạn suy nghĩ / narration trước fence — vẫn phải lấy được code.
    """
    text = (raw or "").strip()
    if not text:
        return text

    fence_re = re.compile(
        r"```(?:csharp|cs|typescript|tsx|javascript|js|python|py|go|rust|java|kotlin|[\w+-]*)?\s*\n?(.*?)```",
        flags=re.DOTALL | re.IGNORECASE,
    )
    fences = list(fence_re.finditer(text))
    if fences:
        best = max(fences, key=lambda m: len((m.group(1) or "").strip()))
        body = (best.group(1) or "").strip()
        if body:
            return _drop_leading_narration(body)

    # Fence mở nhưng thiếu ``` đóng (stream cắt cụt) → lấy phần sau marker.
    open_m = re.search(
        r"```(?:csharp|cs|typescript|tsx|javascript|js|python|py|go|rust|java|kotlin|[\w+-]*)?\s*\n?",
        text,
        flags=re.IGNORECASE,
    )
    if open_m:
        body = text[open_m.end() :]
        end = body.rfind("```")
        if end >= 0:
            body = body[:end]
        body = body.strip()
        if body:
            return _drop_leading_narration(body)

    if text.startswith("```"):
        for prefix in (
            "```csharp",
            "```cs",
            "```C#",
            "```typescript",
            "```tsx",
            "```javascript",
            "```js",
            "```python",
            "```py",
            "```go",
            "```rust",
            "```java",
            "```kotlin",
            "```",
        ):
            if text.startswith(prefix):
                text = text.removeprefix(prefix)
                break
        idx = text.rfind("```")
        if idx >= 0:
            text = text[:idx]
        return _drop_leading_narration(text.strip())

    return _drop_leading_narration(text)


_CODE_LINE_START = re.compile(
    r"^(?:\/\/\/?\s*<reference|import\s|export\s|const\s|let\s|var\s|function\s|"
    r"class\s|interface\s|type\s|enum\s|describe\s*\(|it\s*\(|test\s*\(|"
    r"package\s|using\s|from\s+\S+\s+import|def\s|async\s+def\s|@\w+|"
    r"#!\/|\"use strict\"|'use strict')",
    re.MULTILINE,
)


def _drop_leading_narration(text: str) -> str:
    """Bỏ đoạn prose/VI trước dòng code thật (khi CLI không bọc fence)."""
    text = (text or "").strip()
    if not text:
        return text
    m = _CODE_LINE_START.search(text)
    if not m or m.start() == 0:
        return text
    head = text[: m.start()]
    if len(head) < 24:
        return text
    # Narration thường là câu tiếng Việt / có dấu câu prose, không phải comment code.
    if re.search(r"[A-Za-zÀ-ỹ]{2,}\s+[A-Za-zÀ-ỹ]{2,}", head) or "```" in head:
        return text[m.start() :].strip()
    return text


def unit_result_from_raw(raw: str, req: UnitRequest) -> UnitResult:
    """Parse LLM/CLI raw text → UnitResult (path under AItest/UnitTest/…)."""
    language = infer_language(req)
    code = strip_code_fences(raw)
    code = ensure_node_test_globals_preamble(
        code,
        language,
        req.testing_framework or req.framework,
    )
    if not code.strip():
        raise ValueError("LLM returned empty unit test code")
    class_name = req.class_name or guess_class_name(req.source_file_name, req.source_code)
    suggested, file_name = suggest_unit_path(
        language,
        class_name,
        req.source_file_name,
        req.framework,
        module=req.module or "",
        package_prefix=req.package_prefix,
    )
    if req.source_file_name:
        from app.services.test_output_layout import rewrite_sut_imports

        code = rewrite_sut_imports(
            code, test_rel=suggested, source_rel=req.source_file_name
        )
    return UnitResult(code=code, suggested_path=suggested, file_name=file_name)


def is_likely_app_entrypoint(source_file_name: str = "", source_code: str = "") -> bool:
    """
    True when the SUT looks like a process bootstrap/entrypoint (unsafe to import in unit tests).
    Document/stack-agnostic basename + common framework bootstrap signals.
    """
    src = (source_file_name or "").replace("\\", "/").lstrip("./")
    base = src.rsplit("/", 1)[-1] if src else ""
    if base:
        low = base.lower()
        if low in {
            "main.ts",
            "main.js",
            "main.tsx",
            "main.jsx",
            "main.mjs",
            "main.cjs",
            "main.py",
            "bootstrap.ts",
            "bootstrap.js",
            "bootstrap.py",
            "wsgi.py",
            "asgi.py",
            "__main__.py",
            "program.cs",
        }:
            return True
        if low.startswith("main.") and low.endswith((".ts", ".js", ".tsx", ".jsx", ".py")):
            return True
    code = source_code or ""
    if not code.strip():
        return False
    # Framework-agnostic side-effect bootstrap signals
    if re.search(r"\bNestFactory\.create\b", code) and re.search(
        r"\b(bootstrap|createApp)\s*\(", code
    ):
        return True
    if re.search(r"\buvicorn\.run\b|\bgunicorn\b", code) and re.search(
        r"\bif\s+__name__\s*==\s*['\"]__main__['\"]", code
    ):
        return True
    if re.search(r"\bWebApplication\.Create(Builder)?\b", code) and re.search(
        r"\b(Run|Build)\s*\(", code
    ):
        return True
    if re.search(r"\bSpringApplication\.run\b", code):
        return True
    return False


def _unit_csharp_import_rule(language: str = "") -> str:
    """Prevent invented namespaces (CS0234) and Moq expression pitfalls — project-agnostic."""
    lang = (language or "").lower()
    if not any(x in lang for x in ("c#", "csharp", "f#", ".net", "dotnet")):
        return ""
    return (
        "- CRITICAL for C#/.NET: ONLY add `using` lines that appear in the provided SUT "
        "or Related source files (plus System.*, the chosen test/mock/assert libs, "
        "and Microsoft.* when those APIs appear in snippets). "
        "Never invent sibling namespaces (e.g. do not invent `*.Entities` or "
        "`*.Infrastructure.*.Entities` just because Repositories was imported).\n"
        "- NEVER invent child namespaces under third-party packages "
        "(e.g. do NOT write `SomeVendor.Core.Repository` unless that exact using is in snippets).\n"
        "- Mock ONLY constructor dependencies of the class under test; copy types and "
        "method signatures EXACTLY from SUT + Related interface files.\n"
        "- Moq CRITICAL (CS0854): expression trees cannot use optional/default arguments. "
        "In every Setup/Verify lambda pass ALL parameters explicitly "
        "(use `It.IsAny<T>()` for unused args). Read the interface method in Related source.\n"
        "- Moq return types must match the interface exactly: if Related shows `Task<int>`, "
        "use `ReturnsAsync(0)` (or similar); if `Task`, use `Returns(Task.CompletedTask)` — "
        "never guess.\n"
        "- NEVER Setup/Verify extension methods. Setup only methods declared on the "
        "mocked interface/type from Related source.\n"
        "- Use types exactly as declared in Related source (repository fluent types, "
        "page/result wrappers, DTOs). Do not cast to `object`/`IPage<object>` when the "
        "test later needs concrete properties.\n"
        "- Prefer the same Moq patterns as any provided test-sample from this repo.\n"
    )


def _unit_bootstrap_safety_rule(language: str = "") -> str:
    """Thin Nest tip — general entrypoint ban lives in UUTGS §9."""
    lang = (language or "").lower()
    include_node = (not lang) or any(
        x in lang
        for x in (
            "typescript",
            "javascript",
            "tsx",
            "jsx",
            "ts",
            "js",
            "theo mã",
            "node",
        )
    )
    if not include_node:
        return ""
    return (
        "Ecosystem note (Nest/Express/Fastify): never `import`/`require` main after a partial "
        "`NestFactory` mock; unit-test pipes/controllers/services/DTOs and mirror pipe options "
        "in Arrange instead of executing bootstrap().\n"
    )


def unit_system_prompt(
    framework: str,
    language: str = "",
    *,
    testing_framework: str = "",
    mock_framework: str = "",
    assertion_library: str = "",
    project_rules: str = "",
    user_rules: str = "",
) -> str:
    from app.llm.uutgs_rules import uutgs_system_block

    lang = language or "theo mã nguồn được cung cấp"
    fw = normalize_framework(testing_framework or framework, language)
    stack_bits = [f"Language: {lang}", f"Test framework: {fw}"]
    if mock_framework.strip():
        stack_bits.append(f"Mock library: {mock_framework.strip()}")
    if assertion_library.strip():
        stack_bits.append(f"Assertion library: {assertion_library.strip()}")

    base = (
        f"{uutgs_system_block()}\n\n"
        "## Emit constraints (this job)\n"
        + "\n".join(f"- {b}" for b in stack_bits)
        + "\n"
        "- Output ONLY the complete test source file (no markdown fences, no explanation).\n"
        "- Host path: [{pkg}/]AItest/UnitTest/{Module}/… (or AItest/APITest/…) — never beside production source.\n"
        "- TS/JS internal imports MUST use package roots (`src/…` or `@/…`) — never deep `../../../src` "
        "when the user prompt gives an exact SUT specifier.\n"
        f"{_node_test_types_rule(fw, lang)}"
        f"{_unit_bootstrap_safety_rule(lang)}"
        f"{_unit_csharp_import_rule(lang)}"
    )
    from app.llm.ai_rules import append_layered_rules

    return append_layered_rules(
        base, project_rules=project_rules, user_rules=user_rules
    )


def _node_test_types_rule(framework: str, language: str) -> str:
    """Avoid TS2593 (Cannot find name 'beforeEach') for AItest/ files outside package tsconfig."""
    fw = (framework or "").lower()
    lang = (language or "").lower()
    if not any(x in lang for x in ("typescript", "javascript", "tsx", "jsx")):
        return ""
    if "vitest" in fw:
        return (
            "- Vitest: import { describe, it, expect, beforeEach, vi } from 'vitest' "
            "(do not rely on ambient globals).\n"
        )
    if "mocha" in fw:
        return (
            "- Mocha: /// <reference types=\"mocha\" /> or import from 'mocha'.\n"
        )
    if "jest" in fw or "javascript" in lang or "typescript" in lang:
        return (
            "- Jest: /// <reference types=\"jest\" /> OR "
            "import { describe, it, expect, beforeEach, jest } from '@jest/globals'.\n"
        )
    return ""


def ensure_node_test_globals_preamble(code: str, language: str = "", framework: str = "") -> str:
    """
    Post-process generated unit tests so the IDE can resolve Jest/Mocha globals
    when the file lives under repo-root AItest/ (outside backend tsconfig).
    """
    raw = (code or "").replace("\r\n", "\n")
    if not raw.strip():
        return code
    lang = (language or "").lower()
    fw = (framework or "").lower()
    if not any(x in lang for x in ("typescript", "javascript", "tsx", "jsx", "ts", "js")):
        if not re.search(r"\b(describe|beforeEach|it|expect)\s*\(", raw):
            return code
        if not re.search(r"\b(import|export|const|let|function)\b", raw):
            return code

    is_ts_js = any(
        x in lang for x in ("typescript", "javascript", "tsx", "jsx", "ts", "js")
    ) or bool(re.search(r"\b(import|export)\b", raw[:500]))

    if not is_ts_js:
        return code

    if "vitest" in fw:
        if re.search(r"""from\s+['"]vitest['"]""", raw):
            return code
        return code

    if "mocha" in fw:
        if "reference types=\"mocha\"" in raw or "reference types='mocha'" in raw:
            return code
        if re.search(r"""from\s+['"]mocha['"]""", raw):
            return code
        if re.search(r"\b(describe|beforeEach|it)\s*\(", raw):
            return '/// <reference types="mocha" />\n' + raw.lstrip("\n")
        return code

    if "reference types=\"jest\"" in raw or "reference types='jest'" in raw:
        return code
    if re.search(r"""from\s+['"]@jest/globals['"]""", raw):
        return code
    if re.search(r"\b(describe|beforeEach|afterEach|it|test|expect)\s*\(", raw) or re.search(
        r"\bjest\.(mock|fn|spyOn)\b", raw
    ):
        return '/// <reference types="jest" />\n' + raw.lstrip("\n")
    return code


def unit_user_prompt(req: UnitRequest) -> str:
    """Data packet only — behavior rules live in UUTGS (system prompt)."""
    language = infer_language(req)
    class_hint = req.class_name or guess_class_name(req.source_file_name, req.source_code)
    method_hint = req.method_name or "(infer from source + test case)"
    test_fw = normalize_framework(
        req.testing_framework or req.framework, language
    )
    from app.services.test_output_layout import (
        sut_module_specifier,
        file_name_from_source,
        under_generated_test_folder,
    )

    suggested = under_generated_test_folder(
        "unit",
        file_name_from_source(
            req.source_file_name,
            language=language,
            class_name=class_hint,
            kind="unit",
        ),
        source_file_name=req.source_file_name,
        module=req.module or None,
        package_prefix=req.package_prefix,
    )
    sut_import = ""
    if req.source_file_name and suggested:
        sut_import = sut_module_specifier(suggested, req.source_file_name)

    base = (
        f"Generate a unit test file in {language} for the Approved test case below.\n"
        "Follow UUTGS in the system prompt. Source under test = behavior SoT; "
        "Approved TC = scenario intent.\n\n"
        "## Testing stack\n"
        f"Framework: {test_fw}\n"
        f"Mock: {or_dash(req.mock_framework)}\n"
        f"Assertions: {or_dash(req.assertion_library)}\n"
        f"Output module folder hint: {or_dash(req.module)}\n"
        f"Output file path (host will write here): {suggested}\n"
    )
    if sut_import:
        base += (
            f"SUT import (exact): {sut_import}\n"
            f"Example: import {{ {class_hint} }} from '{sut_import}';\n"
        )
    if is_likely_app_entrypoint(req.source_file_name, req.source_code):
        base += (
            "\n## Entrypoint / bootstrap SUT\n"
            "This file looks like an app entrypoint. Per UUTGS §9: do NOT import/execute it; "
            "test the extractable unit (pipe/service/handler/validator/DTO) using Related source "
            "when provided; mirror config from the snippet in Arrange.\n"
        )
    base += (
        "\n## Test Case (scenario intent)\n"
        f"Title: {req.test_case_title}\n"
        f"Type: {or_dash(req.test_case_type)}\n"
        f"Priority: {or_dash(req.priority)}\n"
        f"Precondition: {or_dash(req.precondition)}\n"
        f"Steps:\n{or_dash(req.steps)}\n"
        f"Expected result:\n{or_dash(req.expected_result)}\n"
        f"Test data: {or_dash(req.test_data)}\n\n"
    )
    if req.requirement_title.strip() or req.requirement_description.strip():
        base += (
            "## Requirement Context (secondary — source wins on conflict)\n"
            f"Title: {or_dash(req.requirement_title)}\n"
            f"Description: {or_dash(req.requirement_description)}\n\n"
        )
    base += (
        "## Source under test (SoT)\n"
        f"Language: {language}\n"
        f"File: {or_dash(req.source_file_name)}\n"
        f"Class/module hint: {class_hint}\n"
        f"Method hint: {method_hint}\n"
    )
    if req.source_under_test_summary.strip():
        base += f"\n### Extracted surface\n{req.source_under_test_summary.strip()}\n"
    is_csharp = any(x in language.lower() for x in ("c#", "csharp", ".net", "dotnet"))
    sut_cap = 18000 if is_csharp else 10000
    base += f"\n{truncate(req.source_code, sut_cap)}\n"

    if req.unit_strategy_summary.strip():
        base = (
            base.rstrip()
            + "\n\n## Unit strategy\n"
            + req.unit_strategy_summary.strip()
            + "\n"
        )
    if req.context_gaps:
        base = (
            base.rstrip()
            + "\n\n## Gaps (do not invent APIs)\n- "
            + "\n- ".join(req.context_gaps)
            + "\n"
        )
    if req.related_sources:
        parts = ["\n## Related source (dependencies)\n"]
        rel_n = 10 if is_csharp else 6
        rel_cap = 4500 if is_csharp else 2500
        for path, content in req.related_sources[:rel_n]:
            parts.append(f"### {path}\n{truncate(content, rel_cap)}\n")
        base = base.rstrip() + "\n" + "\n".join(parts)
    if req.test_samples:
        parts = ["\n## Style sample (match conventions only)\n"]
        for path, content in req.test_samples[:2]:
            parts.append(f"### {path}\n{truncate(content, 3500)}\n")
        base = base.rstrip() + "\n" + "\n".join(parts)
    if req.repair_context.strip():
        base = (
            base.rstrip()
            + "\n\n## Repair context\n"
            + truncate(req.repair_context, 6000)
            + "\n"
        )
    return base


def suggest_api_path(
    language: str,
    class_name: str,
    source_file_name: str = "",
    framework: str = "",
    module: str = "",
    package_prefix: str | None = None,
) -> tuple[str, str]:
    """Return (relative_path, file_name) under [{pkg}/]AItest/APITest/{Module}/…"""
    from app.services.test_output_layout import (
        file_name_from_source,
        under_generated_test_folder,
    )

    lang_l = (language or "").lower()
    base = sanitize_file_name(class_name or "Api")
    fw = (framework or "").lower()
    src = (source_file_name or "").replace("\\", "/").lstrip("./")

    if src:
        file_name = file_name_from_source(
            src, language=language or "", class_name=base, kind="api"
        )
    elif "python" in lang_l or "pytest" in fw:
        file_name = f"test_api_{base.lower()}.py"
    elif "typescript" in lang_l or "javascript" in lang_l or "jest" in fw or "vitest" in fw:
        ext = ".ts" if "typescript" in lang_l else ".js"
        file_name = f"{base.lower()}.api.test{ext}"
    elif "c#" in lang_l or "csharp" in lang_l:
        file_name = f"{base}ApiTests.cs"
    elif "go" in lang_l:
        file_name = f"{base.lower()}_api_test.go"
    else:
        file_name = f"test_api_{base.lower()}.py"

    path = under_generated_test_folder(
        "api",
        file_name,
        source_file_name=src or None,
        module=module or None,
        package_prefix=package_prefix,
    )
    return path, file_name


def api_system_prompt(framework: str, language: str = "") -> str:
    lang = language or "theo mã nguồn / OpenAPI được cung cấp"
    fw = normalize_framework(framework, language)
    return (
        "You are a senior QA engineer writing automated API tests.\n"
        f"Target language: {lang}\n"
        f"Test framework: {fw} (prefer httpx+pytest, supertest+jest, or WebApplicationFactory/xUnit)\n"
        "Rules:\n"
        f"- Output ONLY source code in {lang} (no markdown fences, no explanation).\n"
        "- Map HTTP methods, paths, and status codes from the Approved test case.\n"
        "- Use OpenAPI/spec snippet when provided; otherwise infer from source handlers.\n"
        "- Include auth/setup fixtures only when the test case requires it.\n"
        "- Assert response status and key fields from expected result.\n"
    )


def api_user_prompt(req: UnitRequest) -> str:
    base = unit_user_prompt(req).replace(
        "Generate a unit test file", "Generate an API test file", 1
    )
    if req.open_api_spec.strip():
        base = (
            base.rstrip()
            + "\n\n## OpenAPI / Swagger (local discovery)\n"
            + truncate(req.open_api_spec, 12000)
            + "\n"
        )
    return base


# --- E2E (Playwright TS MVP) ---


@dataclass
class E2EFile:
    path: str
    content: str
    kind: str = "spec"  # page | spec | config | fixture


@dataclass
class E2ERequest:
    test_case_title: str
    test_case_type: str
    priority: str
    steps: str
    expected_result: str
    precondition: str = ""
    test_data: str = ""
    target_url: str = ""
    dom_snapshot: str = ""
    source_file_name: str = ""
    source_code: str = ""
    module: str = ""
    requirement_title: str = ""
    package_prefix: str | None = None
    framework: str = "playwright"
    language: str = "TypeScript"
    storage_state_rel: str = ""
    seed_command: str = ""
    teardown_command: str = ""
    repair_context: str = ""
    related_sources: list[tuple[str, str]] = field(default_factory=list)
    # Existing POM/spec files when healing (path, content)
    existing_files: list[tuple[str, str]] = field(default_factory=list)
    # 3-tier AI rules (Project / User) — System lives in e2e_system_prompt + guards
    project_rules: str = ""
    user_rules: str = ""
    # Optional Analysis/TC execution context snippet (actor/role/authRequired/…)
    execution_context: str = ""
    # Feature entry path (Desktop-derived or user) — baked into Spec Feature entry step
    feature_path: str = ""


@dataclass
class E2EResult:
    files: list[E2EFile]
    suggested_paths: list[str]
    primary_spec_path: str


def e2e_system_prompt(
    *,
    heal: bool = False,
    has_storage_state: bool = False,
    project_rules: str = "",
    user_rules: str = "",
    auth_mode: str = "",
) -> str:
    from app.llm.e2e_codegen_rules import e2ecg_system_block
    from app.llm.e2e_journey_rules import E2E_FEATURE_JOURNEY_RULES

    codegen_spec = e2ecg_system_block()
    journey_rules = E2E_FEATURE_JOURNEY_RULES

    mode = (auth_mode or "").strip().lower()
    if mode == "public":
        auth_short = (
            "- AUTH overlay: PUBLIC — no storageState/globalSetup/auth.helper/ensureAuthenticated.\n"
        )
    elif mode == "none":
        auth_short = (
            "- AUTH overlay: Login/Logout TC — UI-driven; no storageState/ensureAuthenticated inject.\n"
        )
    elif has_storage_state or mode == "storage":
        auth_short = (
            "- AUTH overlay: storageState — feature Specs must NOT repeat login UI / ensureAuthenticated.\n"
        )
    else:
        auth_short = (
            "- AUTH overlay: ui_helper — `test.step('0. …')` + ensureAuthenticated "
            "(E2E_* / E2E_<ROLE>_*); E2ECG Rules 2+6 for discovery/session.\n"
        )
    # Path/sync/reuse → E2ECG 13+15. Keep emit/shim only.
    host_rules = (
        '- Shim: `/// <reference path="../types/playwright-shim.d.ts" />` on generated TS.\n'
    )
    if heal:
        base = (
            "You are a senior Playwright E2E engineer fixing broken selectors.\n"
            f"{codegen_spec}\n\n"
            f"{auth_short}"
            f"{journey_rules}\n"
            f"{host_rules}"
            "- Update Page Object first; Spec only if needed. Keep method contract.\n"
            "- Return ALL updated files:\n"
            "  ### FILE: relative/path.ts\n"
            "  ```ts\n  ...full file...\n  ```\n"
            "- Output only FILE sections.\n"
        )
    else:
        base = (
            "You are a senior Playwright TypeScript E2E engineer (Page Object Model).\n"
            f"{codegen_spec}\n\n"
            f"{auth_short}"
            f"{journey_rules}\n"
            "- Emit separate *.page.ts + *.spec.ts (optional minimal playwright.config.ts).\n"
            f"{host_rules}"
            "- Output only:\n"
            "  ### FILE: pages/….page.ts\n```ts\n...\n```\n"
            "  ### FILE: specs/….spec.ts\n```ts\n...\n```\n"
        )
    from app.llm.ai_rules import append_layered_rules

    return append_layered_rules(
        base, project_rules=project_rules, user_rules=user_rules
    )



def _compact_dom_for_e2e_prompt(dom_snapshot: str, *, limit: int = 6000) -> str:
    """Keep interactive elements + selector_candidates for grounded locators."""
    text = (dom_snapshot or "").strip()
    if not text:
        return ""
    try:
        data = json.loads(text)
    except Exception:
        return truncate(text, limit)
    if not isinstance(data, dict):
        return truncate(text, limit)
    elements = data.get("elements") if isinstance(data.get("elements"), list) else []
    slim_els = []
    for el in elements[:50]:
        if not isinstance(el, dict):
            continue
        slim: dict = {}
        for k in (
            "tag",
            "role",
            "name",
            "test_id",
            "aria_label",
            "placeholder",
            "type",
            "href",
        ):
            if el.get(k):
                slim[k] = el.get(k)
        cands = el.get("selector_candidates")
        if isinstance(cands, list) and cands:
            # Prefer Playwright helpers over raw CSS when both exist
            pw = [str(c) for c in cands if str(c).startswith("getBy")]
            slim["selector_candidates"] = (pw or [str(c) for c in cands])[:3]
        if slim:
            slim_els.append(slim)
    slim_doc = {
        "targetUrl": data.get("targetUrl"),
        "source": data.get("source"),
        "routes": (data.get("routes") or [])[:12],
        "elements": slim_els,
        "locatorHint": (
            "Use selector_candidates / test_id / data-cy / #id / role+name from this list. "
            "Do not invent controls absent here unless FE source below proves them."
        ),
    }
    return truncate(json.dumps(slim_doc, ensure_ascii=False), limit)


def _e2e_steps_checklist(steps: str, expected: str, test_data: str) -> str:
    """Make TC steps explicit so the model maps 1:1 to test.step + locators."""
    raw = (steps or "").strip()
    lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
    if not lines and raw:
        lines = [raw]
    numbered: list[str] = []
    for i, ln in enumerate(lines, start=1):
        if re.match(r"^\d+[\).\:\-]\s*", ln):
            numbered.append(ln)
        else:
            numbered.append(f"{i}. {ln}")
    body = "\n".join(numbered) if numbered else "(none — derive minimal happy path from Expected only)"
    return (
        "## Step → code mapping (follow exactly)\n"
        "Each numbered step → `test.step` (E2ECG 7–19: locators from DOM/FE only).\n"
        f"### Steps\n{body}\n"
        f"### Expected (final asserts)\n{(expected or '(none)').strip()}\n"
        f"### Test data (fill values)\n{(test_data or '(none)').strip()}\n"
    )


def _page_api_summary(content: str, *, max_chars: int = 1800) -> str:
    """Prefer method signatures over full page body to keep batch prompts small."""
    text = content or ""
    if len(text) <= max_chars:
        return text
    methods = re.findall(
        r"(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\s*\{",
        text,
    )
    skip = {
        "constructor",
        "if",
        "for",
        "while",
        "switch",
        "catch",
        "return",
        "await",
        "async",
        "function",
        "new",
    }
    api = [m for m in methods if m not in skip]
    class_m = re.search(r"export\s+class\s+(\w+)", text)
    cls = class_m.group(1) if class_m else "Page"
    uniq = list(dict.fromkeys(api))[:40]
    head = "\n".join(text.splitlines()[:40])
    return (
        f"// API summary for {cls} (full file truncated)\n"
        f"{truncate(head, 900)}\n"
        f"// methods: {', '.join(uniq) if uniq else '(none detected)'}\n"
        "// REUSE these method names in Spec; extend class if a needed method is missing.\n"
    )


def e2e_user_prompt(req: E2ERequest) -> str:
    parts = [
        f"## Approved E2E Test Case\n"
        f"Title: {req.test_case_title}\n"
        f"Type: {req.test_case_type}\n"
        f"Priority: {req.priority}\n"
        f"Module: {req.module or '(none)'}\n"
        f"Precondition: {req.precondition or '(none)'}\n"
        f"Framework: {req.framework or 'playwright'} / {req.language or 'TypeScript'}\n"
    ]
    parts.append(
        _e2e_steps_checklist(req.steps, req.expected_result, req.test_data)
    )
    from app.llm.e2e_codegen_rules import derive_execution_context_block
    from app.llm.e2e_journey_rules import e2e_journey_user_checklist

    fp = (req.feature_path or "").strip().replace("\\", "/")
    if fp and not fp.startswith("/") and not re.match(r"^[a-zA-Z]:", fp):
        fp = f"/{fp}"
    if fp:
        parts.append(
            f"## Feature path (resolved — use in Feature entry / gotoFeature)\n`{fp}`\n"
        )
    else:
        from app.services.e2e_auth_mode import is_public_no_auth_signal

        _public_early = is_public_no_auth_signal(
            title=req.test_case_title,
            dom_snapshot=req.dom_snapshot,
            hints="\n".join(
                [
                    req.precondition or "",
                    req.steps or "",
                    req.expected_result or "",
                    req.test_data or "",
                ]
            ),
        )
        _login_tc = bool(
            re.search(
                r"(?i)\b(login|đăng\s*nhập|sign\s*in|logout|đăng\s*xuất)\b",
                f"{req.test_case_title}\n{req.test_case_type}",
            )
        )
        if not _public_early and not _login_tc:
            parts.append(
                "## Feature path\n"
                "(MISSING — E2E_GROUNDING) Add `path: /…` or `featurePath: /…` on TC "
                "testData or ensure Inspect/FE yields a route. Do NOT invent `/admin/...`.\n"
            )

    parts.append(
        derive_execution_context_block(
            title=req.test_case_title,
            precondition=req.precondition,
            test_data=req.test_data,
            steps=req.steps,
            execution_context=getattr(req, "execution_context", "") or "",
        )
    )
    parts.append(
        e2e_journey_user_checklist(
            test_case_title=req.test_case_title,
            test_case_type=req.test_case_type,
            precondition=req.precondition,
            steps=req.steps,
            expected_result=req.expected_result,
        )
    )
    if req.target_url.strip():
        parts.append(f"## Target URL\n{req.target_url.strip()}\n")
    from app.services.e2e_auth_mode import is_public_no_auth_signal

    public = is_public_no_auth_signal(
        title=req.test_case_title,
        dom_snapshot=req.dom_snapshot,
        hints="\n".join(
            [
                req.precondition or "",
                req.steps or "",
                req.expected_result or "",
                req.project_rules or "",
            ]
        ),
    )
    if public:
        parts.append(
            "## Auth resolved\nPUBLIC — no login artifacts (E2ECG 2; AUTH overlay).\n"
        )
    elif req.storage_state_rel.strip():
        parts.append(
            f"## Auth resolved\nstorageState: `{req.storage_state_rel.strip()}` "
            "(no UI login on feature Spec — E2ECG 6).\n"
        )
    else:
        parts.append(
            "## Auth resolved\nui_helper — step-0 ensureAuthenticated + E2E_* env "
            "(details: AUTH overlay + E2ECG 2+6).\n"
        )
    if req.seed_command.strip() or req.teardown_command.strip():
        parts.append(
            "## Env hooks (document in comments only; host runs them)\n"
            f"seed: {req.seed_command or '(none)'}\n"
            f"teardown: {req.teardown_command or '(none)'}\n"
        )
    if req.dom_snapshot.strip():
        parts.append(
            "## DOM / interactive elements snapshot (GROUND TRUTH for locators)\n"
            + _compact_dom_for_e2e_prompt(req.dom_snapshot, limit=6000)
            + "\n"
            "Prefer DOM `selector_candidates`. Login-wall snapshot on a feature TC → "
            "use FE attrs for post-login UI; do NOT invent testids.\n"
        )
    else:
        parts.append(
            "## DOM snapshot\n(none — derive locators from FE source / TC labels only; "
            "prefer getByRole+name from Steps; do not invent testids).\n"
        )
    # Login-wall DOM means FE is the real ground truth for post-login controls —
    # do NOT cut FE to 4k (old behavior contradicted the instruction above).
    from app.services.e2e_auth_mode import is_login_wall_dom

    login_wall = is_login_wall_dom(req.dom_snapshot)
    dom_has_candidates = False
    if (req.dom_snapshot or "").strip():
        try:
            _dom = json.loads(req.dom_snapshot)
            els = _dom.get("elements") if isinstance(_dom, dict) else None
            if isinstance(els, list):
                n_cands = 0
                for el in els:
                    if not isinstance(el, dict):
                        continue
                    cands = el.get("selector_candidates")
                    if isinstance(cands, list) and cands:
                        n_cands += 1
                dom_has_candidates = n_cands >= 5
        except Exception:
            dom_has_candidates = False

    if login_wall and not dom_has_candidates:
        src_cap = 12000
        related_cap = 3500
    elif dom_has_candidates:
        # Inspect grounded — keep FE smaller to cut prefill latency.
        src_cap = 4000
        related_cap = 2000
    elif req.dom_snapshot.strip():
        src_cap = 6000
        related_cap = 2500
    else:
        src_cap = 8000
        related_cap = 2000
    if req.source_code.strip():
        parts.append(
            f"## FE source hint (`{req.source_file_name or 'source'}`)\n"
            "Extract ONLY real hooks from this template/component: data-cy, data-testid, "
            "id, name, formControlName, aria-label, placeholder, button/link visible text, "
            "routerLink/href routes. Map each Spec action to those attrs — "
            "do not rename fields to free-form Vietnamese labels unless that exact text "
            "appears in the template.\n"
            + truncate(req.source_code, src_cap)
            + "\n"
        )
    for path, content in req.related_sources[:3]:
        parts.append(f"## Related `{path}`\n{truncate(content, related_cap)}\n")
    if req.existing_files:
        heal = bool(req.repair_context.strip())
        parts.append(
            "## Current E2E files (REUSE page object API — extend, do not rename methods)\n"
        )
        # Fresh gen: page API only (no other TCs' specs). Heal: full bodies.
        n = 0
        for path, content in req.existing_files[:8]:
            low = path.replace("\\", "/").lower()
            is_spec = "/specs/" in f"/{low}/" or low.endswith(".spec.ts")
            if not heal and is_spec:
                continue
            if heal or is_spec:
                body = truncate(content, 5000 if heal else 2500)
            else:
                body = _page_api_summary(content, max_chars=1500)
            parts.append(f"### FILE: {path}\n```ts\n{body}\n```\n")
            n += 1
            if n >= 6:
                break
    if req.repair_context.strip():
        parts.append(f"## Repair context\n{truncate(req.repair_context.strip(), 5000)}\n")
    parts.append(
        "Generate Playwright Page Object + Spec (and config if needed).\n"
        "Prefer Spec-only / minimal page extend when Current E2E files already define the POM.\n"
        "Locators grounded in DOM / FE / TC only — contract = E2ECG Rules 9–16.\n"
    )
    return "\n".join(parts)


def _classify_e2e_file_kind(path: str) -> str:
    p = path.replace("\\", "/").lower()
    if p.endswith("playwright.config.ts") or p.endswith("playwright.config.js"):
        return "config"
    if "/fixtures/" in f"/{p}/" or p.endswith("storagestate.json"):
        return "fixture"
    if p.endswith(".page.ts") or p.endswith(".page.js") or "/pages/" in f"/{p}/":
        return "page"
    return "spec"


def parse_e2e_files_from_raw(raw: str) -> list[E2EFile]:
    """Parse ### FILE: path + fenced code blocks (or JSON {files:[…]})."""
    text = (raw or "").strip()
    if not text:
        return []

    # JSON payload
    try:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            data = json.loads(text[start : end + 1])
            if isinstance(data, dict) and isinstance(data.get("files"), list):
                out: list[E2EFile] = []
                for item in data["files"]:
                    if not isinstance(item, dict):
                        continue
                    path = str(item.get("path") or "").strip()
                    content = str(item.get("content") or "")
                    if not path or not content.strip():
                        continue
                    kind = str(item.get("kind") or _classify_e2e_file_kind(path))
                    out.append(E2EFile(path=path.replace("\\", "/"), content=content, kind=kind))
                if out:
                    return out
    except Exception:
        pass

    files: list[E2EFile] = []
    # ### FILE: path\n```lang\ncode\n```
    pattern = re.compile(
        r"(?:^|\n)\s*#{1,6}\s*FILE:\s*([^\n`]+)\s*\n\s*```(?:\w+)?\n(.*?)```",
        re.DOTALL | re.IGNORECASE,
    )
    for m in pattern.finditer(text):
        path = m.group(1).strip().strip("`").replace("\\", "/")
        content = m.group(2).strip()
        if path and content:
            files.append(
                E2EFile(path=path, content=content, kind=_classify_e2e_file_kind(path))
            )
    if files:
        return files

    # Fallback: single fence → treat as spec
    code = strip_code_fences(text).strip()
    if code:
        return [E2EFile(path="specs/journey.spec.ts", content=code, kind="spec")]
    return []


def e2e_result_from_raw(raw: str, req: E2ERequest) -> E2EResult:
    from app.services.test_output_layout import resolve_e2e_file_paths

    parsed = parse_e2e_files_from_raw(raw)
    if not parsed:
        raise ValueError("LLM returned empty E2E files")
    resolved = resolve_e2e_file_paths(
        parsed,
        module=req.module or "",
        package_prefix=req.package_prefix,
        journey_slug=_e2e_journey_slug(req.test_case_title),
        requirement_title=req.requirement_title,
        test_case_title=req.test_case_title,
    )
    from app.services.e2e_codegen_guard import apply_e2e_codegen_guards

    # Prefer Desktop/API featurePath; fall back to path:/ markers in TC text.
    feature_path_hint = (req.feature_path or "").strip().replace("\\", "/")
    if feature_path_hint and not feature_path_hint.startswith("/") and not feature_path_hint.startswith(
        "http"
    ):
        feature_path_hint = f"/{feature_path_hint}"
    if not feature_path_hint:
        for blob in (req.precondition, req.test_data, req.steps):
            m = re.search(
                r"(?im)^\s*(?:path|route|url|featurePath|feature_path)\s*[:=]\s*([^\n;,|]+)",
                blob or "",
            )
            if m:
                raw = m.group(1).strip().strip("\"'")
                if raw:
                    feature_path_hint = (
                        raw if raw.startswith("/") or raw.startswith("http") else f"/{raw}"
                    )
                    break

    resolved = apply_e2e_codegen_guards(
        resolved,
        dom_snapshot=req.dom_snapshot,
        use_storage=bool((req.storage_state_rel or "").strip()),
        test_case_title=req.test_case_title,
        auth_hints="\n".join(
            [
                req.precondition or "",
                req.steps or "",
                req.expected_result or "",
                req.project_rules or "",
            ]
        ),
        feature_path=feature_path_hint,
        enforce_journey=True,
    )
    tc_suffix = hashlib.md5((req.test_case_title or "").encode("utf-8")).hexdigest()[:8]
    if tc_suffix:
        # Only salt when two specs would collide in the same specs/ folder.
        # Folder already encodes {Req}/{TC} — do not double-hash every Spec name.
        patched: list[E2EFile] = []
        used_names: dict[str, int] = {}
        for f in resolved:
            p = (f.path or "").replace("\\", "/")
            if f.kind == "spec":
                parent = p.rsplit("/", 1)[0] if "/" in p else ""
                leaf = p.rsplit("/", 1)[-1].lower()
                key = f"{parent}/{leaf}"
                if key in used_names:
                    m = re.search(r"(\.(?:spec|test)\.[^.]+)$", p, flags=re.IGNORECASE)
                    if m and f".{tc_suffix}." not in p.lower():
                        p = f"{p[:m.start(1)]}.{tc_suffix}{m.group(1)}"
                used_names[key] = used_names.get(key, 0) + 1
            patched.append(E2EFile(path=p, content=f.content, kind=f.kind))
        resolved = patched
    paths = [f.path for f in resolved]
    primary = next((f.path for f in resolved if f.kind == "spec"), paths[0])
    return E2EResult(files=resolved, suggested_paths=paths, primary_spec_path=primary)


def _e2e_journey_slug(title: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", (title or "journey").strip()).strip("-").lower()
    return (slug or "journey")[:48]


def default_playwright_config(
    *,
    base_url: str = "",
    storage_state_rel: str = "",
    headed: bool = False,
    slow_mo_ms: int | None = None,
    include_global_setup: bool | None = None,
) -> str:
    base = (base_url or "http://localhost:3000").rstrip("/")
    def _normalize_storage_rel(rel: str) -> str:
        s = (rel or "").replace("\\", "/").strip()
        if not s:
            return ""
        # Playwright resolves storageState relative to playwright.config.ts directory.
        # Prefer caller-supplied relative paths (incl. ../../_shared/fixtures/...).
        if s.startswith("./") or s.startswith("../"):
            return s
        low = s.lower()
        if low.endswith("storagestate.json") or low.startswith("fixtures/"):
            return "./fixtures/storageState.json"
        return ""

    storage_rel = _normalize_storage_rel(storage_state_rel)
    storage_line = f'    storageState: "{storage_rel}",\n' if storage_rel else ""
    # Default: globalSetup only when storageState is configured (storage auth mode).
    use_setup = include_global_setup if include_global_setup is not None else bool(storage_rel)
    if use_setup:
        # Prefer sibling of storageState when under _shared; else classic ./fixtures/
        if "/_shared/" in storage_rel.replace("\\", "/"):
            setup_dir = storage_rel.rsplit("/", 1)[0]
            global_setup_line = f"  globalSetup: '{setup_dir}/global.setup.ts',\n"
        else:
            global_setup_line = "  globalSetup: './fixtures/global.setup.ts',\n"
    else:
        global_setup_line = ""

    # Explicit headless — CLI --headed đôi khi bị nuốt trên Windows/npx; config chắc hơn
    headless_line = "    headless: false,\n" if headed else "    headless: true,\n"
    # Headed: slowMo đủ lớn để mắt người theo kịp từng click/fill (80ms ≈ bật/tắt).
    if headed:
        mo = 500 if slow_mo_ms is None else max(0, int(slow_mo_ms))
        slow_line = f"    launchOptions: {{ slowMo: {mo} }},\n"
        # Giữ video khi xem cửa sổ — review lại sau khi chạy xong
        video_line = "    video: 'on',\n"
        screenshot_line = "    screenshot: 'on',\n"
    else:
        slow_line = ""
        video_line = "    video: 'retain-on-failure',\n"
        screenshot_line = "    screenshot: 'only-on-failure',\n"
    return (
        "import { defineConfig, devices } from '@playwright/test';\n\n"
        "export default defineConfig({\n"
        f"{global_setup_line}"
        "  testDir: './specs',\n"
        "  fullyParallel: false,\n"
        "  workers: 1,\n"
        "  timeout: 90_000,\n"
        "  expect: { timeout: 15_000 },\n"
        "  forbidOnly: !!process.env.CI,\n"
        "  retries: process.env.CI ? 1 : 0,\n"
        "  // Skip git probe — tránh cold-start chậm trên Windows/CI\n"
        "  captureGitInfo: { commit: false, diff: false },\n"
        "  reporter: [\n"
        "    ['list'],\n"
        "    ['json', { outputFile: 'test-results/playwright-report.json' }],\n"
        "    ['html', { open: 'never' }],\n"
        "  ],\n"
        "  use: {\n"
        f"    baseURL: process.env.E2E_BASE_URL || '{base}',\n"
        "    // Prefer data-cy (JHipster) then apps can override via E2E_TEST_ID_ATTRIBUTE\n"
        "    testIdAttribute: process.env.E2E_TEST_ID_ATTRIBUTE || 'data-cy',\n"
        f"{headless_line}"
        f"{slow_line}"
        "    actionTimeout: 15_000,\n"
        "    navigationTimeout: 20_000,\n"
        "    trace: 'retain-on-failure',\n"
        f"{video_line}"
        f"{screenshot_line}"
        f"{storage_line}"
        "  },\n"
        "  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],\n"
        "});\n"
    )