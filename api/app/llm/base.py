from __future__ import annotations

import json
import re
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
    custom_rules: str | None = None
    feature_titles: list[str] = field(default_factory=list)
    # Studio engine lock: unit | e2e | None (mixed)
    preferred_engine: str | None = None


# Ví dụ schema-only — placeholder, KHÔNG phải domain mẫu để copy vào dự án thật.
_VIETNAMESE_TC_EXAMPLE_UNIT = (
    '{"testCases":['
    '{"title":"[Tên chức năng trong tài liệu] - [Hàm/method] - [Kết quả kỳ vọng]",'
    '"type":"Unit","priority":"Cao","severity":"Nặng",'
    '"module":"[Tên module/Feature trong tài liệu]",'
    '"precondition":"Mock dependency theo tài liệu/source (nếu có)",'
    '"steps":"1. Chuẩn bị input + mock\\n2. Gọi đơn vị cần test\\n3. Assert kết quả",'
    '"expectedResult":"Return/exception/state đúng mô tả tài liệu",'
    '"testData":"input=... (lấy từ tài liệu)","automationReady":true}'
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
            "PHIÊN ENGINE = UNIT (BẮT BUỘC):\n"
            "- Mọi test case phải có type=Unit.\n"
            "- Kiểm tra hàm/class/service/validator/API handler — KHÔNG mở trình duyệt, không click/fill UI.\n"
            "- KHÔNG sinh type=E2E trong phiên này.\n"
            "- Tên module/hàm/API lấy từ tài liệu hoặc source context — không dùng tên mẫu trong ví dụ.\n"
        )
        example = _VIETNAMESE_TC_EXAMPLE_UNIT
        type_schema = "Unit"
    elif eng == "e2e":
        type_block = (
            "PHIÊN ENGINE = E2E (BẮT BUỘC):\n"
            "- Mọi test case phải có type=E2E.\n"
            "- Mô tả user journey trên UI theo tài liệu (mở màn hình, fill, click, assert UI/state).\n"
            "- Steps: [Hành động] -> [Element] -> [Dữ liệu]. Assert URL/toast/persistence chỉ khi tài liệu có tín hiệu.\n"
            "- KHÔNG sinh type=Unit/API thuần hàm trong phiên này.\n"
            "- Không copy tên màn hình/route/domain từ ví dụ — lấy từ tài liệu job.\n"
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
        "Cách dùng tài liệu:\n"
        "- User Story / SRS / Feature / heading / màn hình / API trong input = phạm vi chức năng cần cover.\n"
        "- Mỗi chức năng tách rõ trong tài liệu = một module; trường module khớp tên trong tài liệu.\n"
        "- Requirement: phạm vi chính cần kiểm thử.\n"
        "- Nếu có mã nguồn tham khảo: căn TC theo module/API/validation trong code.\n"
        "- Nếu có khối «KẾT QUẢ PHÂN TÍCH ĐÃ LƯU DB»: cover đủ tiêu chí (khi có — thường đã gộp trong freeze).\n"
        "- Nếu có khối «NGỮ CẢNH SOURCE CODE»: bổ sung nhánh logic/validation/exception.\n"
        "- Không bịa yêu cầu không có trong input.\n\n"
        "CHECKLIST ANTI-MISS (chỉ mục có tín hiệu trong tài liệu):\n"
        "- Happy path, validation/negative, business rules, permission/auth (nếu có), exception, boundary/data integrity.\n"
        "- Không bỏ sót module/chức năng đã xuất hiện trong tài liệu/analysis/source context.\n"
        "- Mỗi TC: thao tác + dữ liệu + expected result kiểm được, bám tài liệu.\n\n"
        "Trả về CHỈ JSON hợp lệ (không markdown), đúng schema:\n"
        f'{{"testCases":[{{"title":"...","type":"{type_schema}",'
        '"priority":"Thấp|Trung bình|Cao|Nghiêm trọng","severity":"Nhẹ|Nặng|Nghiêm trọng",'
        '"module":"...","precondition":"...","steps":"1. ...\\n2. ...",'
        '"expectedResult":"...","testData":"...","automationReady":false}]}\n\n'
        f"Ví dụ schema (placeholder — thay bằng nội dung từ tài liệu):\n{example}\n"
    )
    if ctx.mode == "append" and ctx.existing_cases and not ctx.topic_scope:
        base += (
            "\nCHẾ ĐỘ BỔ SUNG: Đã có test case bên dưới.\n"
            "Chỉ sinh test case MỚI cho phần còn thiếu — không trùng hoặc paraphrase nhẹ.\n"
            "Nếu đã đủ coverage, chỉ sinh 1–3 case bổ sung cho gap.\n"
            "Test case mới vẫn phải 100% tiếng Việt.\n"
        )
    elif ctx.topic_scope:
        base += (
            "\nSinh đủ test case cho ĐÚNG một chức năng trong phạm vi chủ đề "
            "(tối thiểu 6–15 case tùy số FR/AC/rule trong module — không giới hạn cứng ở 10). "
            "Mỗi FR/AC/business rule/validation trong phạm vi phải có ≥1 test case tương ứng. "
            "Đọc HẾT tài liệu + phân tích DB + source context — không bỏ qua mục nào. "
            "Toàn bộ nội dung tiếng Việt."
        )
    else:
        n = len(ctx.feature_titles)
        if n > 1:
            base += (
                f"\nTài liệu có {n} chức năng (Feature). "
                "Mỗi chức năng cần ít nhất 6–15 test case (happy path + negative + biên + exception). "
                "Trường module PHẢI khớp đúng tên từng Feature. "
                "Không được chỉ sinh TC cho 1–2 module rồi bỏ qua phần còn lại. "
                "Toàn bộ nội dung tiếng Việt."
            )
        else:
            base += (
                "\nSinh đủ test case phủ FR/AC/business rule/validation trong tài liệu "
                "(tối thiểu 8–20 case với SRS lớn — không dừng sớm ở ~10 case). "
                "Bám sát toàn bộ tài liệu + phân tích DB — không bỏ sót luồng nghiệp vụ. "
                "Toàn bộ nội dung tiếng Việt."
            )
    if ctx.custom_rules:
        # Engine overlay ưu tiên; truncate gọn hơn khi đã lock engine (tiết kiệm token)
        cap = 3500 if eng in ("unit", "e2e") else 4000
        base += f"\n\nQUY TẮC BỔ SUNG (ưu tiên cao — cấu hình BE):\n{truncate(ctx.custom_rules, cap)}\n"
    return base


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
            "trong snapshot (và source context nếu có) — không dừng sớm ở ~10 case."
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
            "cover đủ FR/AC/rule thuộc module đó — không dừng sớm ở ~10 case."
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


def unit_system_prompt(framework: str, language: str = "", *, testing_framework: str = "", mock_framework: str = "", assertion_library: str = "") -> str:
    lang = language or "theo mã nguồn được cung cấp"
    fw = normalize_framework(testing_framework or framework, language)
    mock_line = (
        f"- Prefer mocking with: {mock_framework}\n" if mock_framework.strip() else ""
    )
    assert_line = (
        f"- Prefer assertions with: {assertion_library}\n"
        if assertion_library.strip()
        else ""
    )
    return (
        "You are a senior software engineer writing automated unit tests.\n"
        f"Target language: {lang}\n"
        f"Test framework: {fw}\n"
        "Rules:\n"
        f"- Output ONLY source code in {lang} (no markdown fences, no explanation).\n"
        "- Match the language and idioms of the provided source snippet.\n"
        "- Use Arrange-Act-Assert (or equivalent).\n"
        "- Cover the Approved test case intent using the provided source snippet.\n"
        "- Prefer focused unit tests; mock external dependencies when listed in Unit strategy.\n"
        f"{mock_line}"
        f"{assert_line}"
        "- Include necessary imports and a public/exportable test module or class.\n"
        "- The host will place this file under [{pkg}/]AItest/UnitTest/{Module}/… "
        "(or AItest/APITest/…) — never beside production source. "
        "Write a complete file body suitable for that location.\n"
        "- CRITICAL for TS/JS: ALL project-internal imports (SUT, DTOs, entities, interfaces, helpers) "
        "MUST use package root specifiers like `src/…` or `@/…` instead of local relative paths (`./…`) "
        "because this test file is placed under `AItest/UnitTest/…`. Use the EXACT SUT path given in prompt.\n"
        f"{_node_test_types_rule(fw, lang)}"
        "- Do not invent APIs that are not in the source snippet; if incomplete, "
        "test the visible surface and add TODO comments.\n"
        "- If a test-sample is provided, match its naming/style without copying unrelated cases."
    )


def _node_test_types_rule(framework: str, language: str) -> str:
    """Avoid TS2593 (Cannot find name 'beforeEach') for AItest/ files outside package tsconfig."""
    fw = (framework or "").lower()
    lang = (language or "").lower()
    if not any(x in lang for x in ("typescript", "javascript", "tsx", "jsx")):
        return ""
    if "vitest" in fw:
        return (
            "- Vitest + TS/JS: import { describe, it, expect, beforeEach, vi } from 'vitest' "
            "(do not rely on ambient globals).\n"
        )
    if "mocha" in fw:
        return (
            "- Mocha + TS/JS: start the file with /// <reference types=\"mocha\" /> "
            "or import from 'mocha'.\n"
        )
    if "jest" in fw or "javascript" in lang or "typescript" in lang:
        return (
            "- Jest + TS/JS: start the file with /// <reference types=\"jest\" /> "
            "OR import { describe, it, expect, beforeEach, jest } from '@jest/globals'. "
            "Do not use bare describe/it/beforeEach without one of these.\n"
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
        # Infer from code when language missing
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
        # Prefer LLM import; if missing and globals used, leave as-is (Vitest often ships types via vite)
        return code

    if "mocha" in fw:
        if "reference types=\"mocha\"" in raw or "reference types='mocha'" in raw:
            return code
        if re.search(r"""from\s+['"]mocha['"]""", raw):
            return code
        if re.search(r"\b(describe|beforeEach|it)\s*\(", raw):
            return '/// <reference types="mocha" />\n' + raw.lstrip("\n")
        return code

    # Jest (default for TS/JS unit)
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
        f"Generate a unit test file in {language} for this Approved test case.\n\n"
        "## Testing stack\n"
        f"Framework: {test_fw}\n"
        f"Mock: {or_dash(req.mock_framework)}\n"
        f"Assertions: {or_dash(req.assertion_library)}\n"
        f"Output module folder hint: {or_dash(req.module)}\n"
        f"Output file path (host will write here): {suggested}\n"
    )
    if sut_import:
        base += (
            f"Import path for SUT (USE THIS EXACT path — package baseUrl src/… preferred): "
            f"{sut_import}\n"
            f"Example: import {{ {class_hint} }} from '{sut_import}';\n"
            "- Do NOT use deep relative paths like '../../../src/…' when a src/… path is given.\n"
        )
    base += (
        "\n## Test Case\n"
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
            "## Requirement Context\n"
            f"Title: {or_dash(req.requirement_title)}\n"
            f"Description: {or_dash(req.requirement_description)}\n\n"
        )
    base += (
        "## Source under test\n"
        f"Language: {language}\n"
        f"File: {or_dash(req.source_file_name)}\n"
        f"Class/module hint: {class_hint}\n"
        f"Method hint: {method_hint}\n"
    )
    if req.source_under_test_summary.strip():
        base += f"\n### Extracted surface\n{req.source_under_test_summary.strip()}\n"
    base += f"\n{truncate(req.source_code, 14000)}\n"

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
        for path, content in req.related_sources[:12]:
            parts.append(f"### {path}\n{truncate(content, 4000)}\n")
        base = base.rstrip() + "\n" + "\n".join(parts)
    if req.test_samples:
        parts = ["\n## Style sample (existing tests — match style only)\n"]
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


@dataclass
class E2EResult:
    files: list[E2EFile]
    suggested_paths: list[str]
    primary_spec_path: str


def e2e_system_prompt(*, heal: bool = False) -> str:
    locator_rules = (
        "- LOCATOR PRIORITY (mandatory — never invent labels):\n"
        "  1) getByTestId from DOM/source `data-testid` / selector_candidates\n"
        "  2) getByRole(role, { name }) when role+accessible name exist in DOM snapshot\n"
        "  3) getByLabel / getByPlaceholder from aria-label / placeholder in DOM or FE source\n"
        "  4) getByText only for unique visible copy grounded in TC/DOM — never for duplicated verbs\n"
        "  5) CSS / XPath last resort; never class-hash or layout-only selectors\n"
        "- When ## DOM snapshot lists `selector_candidates` for an element, prefer the first "
        "Playwright-style candidate (getByTestId / getByRole / getByLabel) verbatim.\n"
        "- Scope duplicates: form / getByRole('main') / getByTestId(list) — never bare "
        "page.getByRole('button', { name }) if DOM shows the same name twice (tab vs submit).\n"
        "- Map FE source: if ## FE source hint has data-testid / aria-label / name / placeholder, "
        "use those for Page Object locators — same discipline as Unit tests using SUT source.\n"
        "- Do NOT invent UI fields (e.g. description, tags) unless they appear in Steps, Expected, "
        "DOM snapshot, or FE source. If TC mentions a field missing from DOM/source: assert what "
        "exists and note skip in comment, or use the closest grounded control — do not guess.\n"
    )
    step_rules = (
        "- TC STEPS → CODE (mandatory):\n"
        "  Parse numbered Steps 1..N and Expected. Spec MUST use test.step('1. …') … matching each "
        "action step; Expected maps to final expect* / expectSuccess (not skipped).\n"
        "  Each action step: [action] → locator grounded above → data from Test data / step text.\n"
        "  Do not merge unrelated steps; do not add login steps inside feature POM when "
        "ensureAuthenticated / storageState already handles auth.\n"
        "  Precondition «đã đăng nhập» ⇒ ensureAuthenticated or storageState — not fillEmail in feature page.\n"
        "- VALIDATION / NEGATIVE TESTS:\n"
        "  When TC tests form validation (empty field, invalid input, boundary), the submit button "
        "may be disabled by client-side validation. In that case:\n"
        "  • PREFERRED: assert the button is disabled: `await expect(submitBtn).toBeDisabled()` — "
        "this IS the expected result for missing/invalid input.\n"
        "  • Do NOT use `click({ force: true })` on disabled buttons — browsers ignore forced clicks "
        "on disabled elements, so no error message will appear.\n"
        "  • If the TC expects an error message after submit, the form must actually be submittable "
        "(button enabled). If button is disabled, the validation result IS the disabled state itself.\n"
        "  • Pattern for validation specs: fill partial data → assert submit button is disabled "
        "OR assert inline validation text (HTML5 constraint, aria-invalid, etc.).\n"
        "- ERROR MESSAGE ASSERTIONS:\n"
        "  • NEVER hardcode exact error message text. App messages vary across projects/languages.\n"
        "  • Use regex partial match: `page.getByText(/thất bại|fail/i)` or `page.getByText(/lỗi|error/i)`.\n"
        "  • For `expectErrorMessage()` in page objects, use: "
        "`await this.page.getByText(/keyword/i).first().waitFor({ state: 'visible', timeout: 5000 })`\n"
        "  • Pick 1-2 short keywords from the expected message (e.g. 'thất bại', 'error', 'lỗi').\n"
        "- IMPORT RULE:\n"
        "  • Each TC has its own folder with its own pages/ and specs/ subfolders.\n"
        "  • Spec MUST ONLY import from its own ../pages/ folder — NEVER from ../../OtherTC/pages/.\n"
        "  • Every method called in Spec must exist in the imported Page Object class.\n"
    )
    if heal:
        return (
            "You are a senior Playwright E2E engineer fixing broken selectors.\n"
            "Rules:\n"
            f"{locator_rules}"
            "- Update Page Object files first; only change the Spec if necessary.\n"
            "- Method contract is mandatory: every method called in Spec on page object must exist in that page object class.\n"
            "- If current Spec calls a missing method (e.g. fillEmail), either add that method in page object or rename Spec call to an existing method. Never leave mismatch.\n"
            "- Prefer stable locators from source/DOM hint (data-testid, name, aria-label, form scope) over plain duplicated text.\n"
            "- Keep Spec step order; only change locators/method bodies unless a step is impossible with current DOM.\n"
            "- Return ALL updated files using this format for each file:\n"
            "  ### FILE: relative/path/to/file.ts\n"
            "  ```ts\n  ...full file content...\n  ```\n"
            "- Do not rewrite business journey steps unless the selector force requires it.\n"
            "- Output only FILE sections (no prose outside fences).\n"
        )
    return (
        "You are a senior Playwright TypeScript E2E engineer using Page Object Model.\n"
        "Rules:\n"
        "- Produce SEPARATE Page Object (*.page.ts) and Spec (*.spec.ts) files.\n"
        f"{locator_rules}"
        f"{step_rules}"
        "- Method contract is mandatory: every method used in Spec must be implemented in the corresponding Page Object class.\n"
        "- Use one naming convention and keep it consistent (e.g. fillUsername/fillPassword/clickSubmit). Do not invent method names in Spec without implementation.\n"
        "- Host places files under [{pkg}/]AItest/E2ETest/{Module}/pages|specs/.\n"
        "- Spec MUST import page objects via relative path from specs folder.\n"
        "- Do NOT import from node_modules absolute paths or project-internal build folders.\n"
        "- Keep playwright.config.ts minimal and import only from '@playwright/test'.\n"
        "- Type portability (mandatory): when importing '@playwright/test', include local shim reference "
        "header for generated files (`/// <reference path=\"../types/playwright-shim.d.ts\" />` for "
        "spec/page, `./types/...` for config).\n"
        "- Include a minimal playwright.config.ts if useful (video on, trace on-first-retry).\n"
        "- Use baseURL from config; do not hardcode full URLs when target URL is given.\n"
        "- Navigation: prefer page.goto(path, { waitUntil: 'domcontentloaded' }) — "
        "NEVER waitUntil: 'networkidle' (SPA/websocket treo rất lâu).\n"
        "- Prefer expect(locator).toBeVisible() over waitForTimeout / networkidle.\n"
        "- Page Object baseline: goto() ONLY navigates (page.goto + optional waitForLoadState). "
        "NEVER assert feature widgets (listitem, todo, table rows, dashboard) inside goto() — "
        "those belong in expectFormVisible / selectX / expectSuccess after auth.\n"
        "- If `## Current E2E files` lists an existing page object, REUSE its public methods verbatim — do not invent alternate names (gotoLogin vs goto).\n"
        "- Before output: self-check — (a) every Spec method exists on POM; "
        "(b) every locator string appears in DOM selector_candidates or FE source attributes; "
        "(c) every numbered TC step has a matching test.step.\n"
        "- NEVER hardcode app-specific routes, labels, or URL regex defaults. Only assert paths/URLs that are explicitly grounded in the provided test case, source hints, or DOM snapshot.\n"
        "- Keep navigation assertions project-aware: if exact destination path is unknown, verify with stable post-action UI outcomes and state transitions instead of guessed URLs.\n"
        "- Prefer resilient URL checks derived from input context; avoid brittle assumptions about route naming conventions.\n"
        "- AUTH / SESSION (bypass login for feature journeys):\n"
        "  1) If ## Auth storageState is present AND the file is a real Playwright state "
        "(cookies/origins non-empty) → set use.storageState to `./fixtures/storageState.json` "
        "(path RELATIVE to playwright.config.ts — never AItest/... from repo root).\n"
        "  2) If no valid storageState yet but journey is post-login / DOM shows login wall at `/`: "
        "emit `fixtures/auth.helper.ts` with `ensureAuthenticated(page)` using "
        "role-aware env resolution: E2E_ROLE + E2E_<ROLE>_USERNAME/PASSWORD, fallback E2E_USERNAME/E2E_PASSWORD, "
        "and generic getByRole(email|password|login). "
        "Helper MUST: switch to Login tab if present; fill → wait enabled → click form submit; "
        "if login returns 401 and Sign-up UI exists, auto-register then retry login once; "
        "wait for login form/heading hidden; on failure throw clear credential error (do not assert todos). "
        "Feature Specs MUST `await ensureAuthenticated(page)` BEFORE feature PageObject.goto/select. "
        "Do NOT emit empty `{}` storageState.json; do NOT put storageState in config until file is real.\n"
        "  3) Pure Login/Logout / Auth-permission TCs stay UI-driven (no ensureAuthenticated skip).\n"
        "  4) Prefer one shared Auth helper/page; reuse it — do not duplicate fillEmail/fillPassword in every feature page.\n"
        "  5) Never write a .spec.ts that only contains `declare module '@playwright/test'` — specs must call test().\n"
        "  6) If after goto the app shows login UI, failing on missing listitem is wrong — treat as missing auth, not wrong todo locator.\n"
        "- Feature Spec step order (mandatory, use test.step):\n"
        "  1) ensureAuthenticated(page) — leave login wall only\n"
        "  2) pageObject.goto() — navigate only, no feature expects\n"
        "  3) arrange (selectExisting / open form) — mirrors early TC steps\n"
        "  4) act (fill + clickSubmit) — mirrors action steps + Test data\n"
        "  5) assert expectSuccess — mirrors Expected (count/id/title only if TC/DOM supports)\n"
        "- Return files using this format for EACH file:\n"
        "  ### FILE: pages/login.page.ts\n"
        "  ```ts\n  ...\n  ```\n"
        "  ### FILE: specs/login.spec.ts\n"
        "  ```ts\n  ...\n  ```\n"
        "- Paths may be relative to the module folder (pages/…, specs/…) or full AItest/… paths.\n"
        "- Output only FILE sections (no prose outside fences).\n"
    )


def _compact_dom_for_e2e_prompt(dom_snapshot: str, *, limit: int = 8000) -> str:
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
    for el in elements[:80]:
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
            slim["selector_candidates"] = (pw or [str(c) for c in cands])[:4]
        if slim:
            slim_els.append(slim)
    slim_doc = {
        "targetUrl": data.get("targetUrl"),
        "source": data.get("source"),
        "routes": (data.get("routes") or [])[:20],
        "elements": slim_els,
        "locatorHint": (
            "Use selector_candidates / test_id / role+name from this list. "
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
        "For each numbered step below, emit `await test.step('<step text>', async () => { ... })` "
        "with locators from DOM selector_candidates / FE source — not invented labels.\n"
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
    if req.target_url.strip():
        parts.append(f"## Target URL\n{req.target_url.strip()}\n")
    if req.storage_state_rel.strip():
        parts.append(
            f"## Auth storageState\nUse storageState path: `{req.storage_state_rel.strip()}`\n"
            "Feature specs must NOT repeat UI login — session is already loaded via storageState.\n"
        )
    else:
        parts.append(
            "## Auth strategy (no storageState path provided yet)\n"
            "Host AITest auto-discovers credentials from the SUT project "
            "(.ai-test/auth artifact first; fallback .env/.env.e2e E2E_USERNAME+E2E_PASSWORD, role keys E2E_ADMIN_USERNAME, "
            "fixtures/auth/roles.json, or existing storageState) — Specs must NOT require "
            "typing login into AITest UI.\n"
            "If this journey is NOT Login/Logout: emit fixtures/auth.helper.ts with "
            "ensureAuthenticated(page) using process.env E2E_* (injected by host from discovery), "
            "supporting both single-role and multi-role (E2E_ROLE + E2E_<ROLE>_*). "
            "If storageState already valid: feature Specs skip login UI entirely.\n"
            "Auth helper steps: Login tab → fill → enabled submit → click → login wall hidden. "
            "Feature Specs MUST call ensureAuthenticated BEFORE feature PageObject actions "
            "only when storageState is absent.\n"
            "If this IS a Login/Logout TC: drive the login UI in the Spec; no ensureAuthenticated.\n"
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
            + _compact_dom_for_e2e_prompt(req.dom_snapshot, limit=10000)
            + "\n"
            "If this snapshot only shows Login/Auth controls, still generate the feature journey "
            "using FE source below + TC steps — but auth first via ensureAuthenticated/storageState.\n"
        )
    else:
        parts.append(
            "## DOM snapshot\n(none — derive locators from FE source / TC labels only; "
            "prefer getByRole+name from Steps; do not invent testids).\n"
        )
    if req.source_code.strip():
        parts.append(
            f"## FE source hint (`{req.source_file_name or 'source'}`)\n"
            "Extract data-testid, aria-label, name, placeholder, button text, routes from this code "
            "the same way Unit generation reads SUT APIs — use them in Page Object locators.\n"
            + truncate(req.source_code, 8000)
            + "\n"
        )
    for path, content in req.related_sources[:4]:
        parts.append(f"## Related `{path}`\n{truncate(content, 2500)}\n")
    if req.existing_files:
        heal = bool(req.repair_context.strip())
        parts.append(
            "## Current E2E files (REUSE page object API — extend, do not rename methods)\n"
        )
        # Heal needs full bodies; fresh generate in batch only needs page API surface.
        for path, content in req.existing_files[:8]:
            low = path.replace("\\", "/").lower()
            if heal or "/specs/" in f"/{low}/" or low.endswith(".spec.ts"):
                body = truncate(content, 5000 if heal else 2500)
            else:
                body = _page_api_summary(content, max_chars=2000)
            parts.append(f"### FILE: {path}\n```ts\n{body}\n```\n")
    if req.repair_context.strip():
        parts.append(f"## Repair context\n{truncate(req.repair_context.strip(), 5000)}\n")
    parts.append(
        "Generate Playwright Page Object + Spec (and config if needed) for this journey.\n"
        "If Current E2E files already define the page object, prefer adding a Spec only "
        "(or minimal page extend) — do not rewrite the whole page unless required.\n"
        "Important: every locator must be grounded in DOM selector_candidates, FE source attributes, "
        "or explicit TC step labels — no invented fields/URLs.\n"
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

    resolved = apply_e2e_codegen_guards(resolved, dom_snapshot=req.dom_snapshot)
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
) -> str:
    base = (base_url or "http://localhost:3000").rstrip("/")
    def _normalize_storage_rel(rel: str) -> str:
        s = (rel or "").replace("\\", "/").strip()
        if not s:
            return ""
        # Playwright resolves storageState relative to playwright.config.ts directory.
        # Absolute-from-repo forms like AItest/E2ETest/... cause duplicated path at runtime.
        low = s.lower()
        if low.endswith("storagestate.json"):
            return "./fixtures/storageState.json"
        if low.startswith("./fixtures/") or low.startswith("fixtures/"):
            return "./fixtures/storageState.json"
        return ""

    storage_rel = _normalize_storage_rel(storage_state_rel)
    storage_line = f'    storageState: "{storage_rel}",\n' if storage_rel else ""
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
