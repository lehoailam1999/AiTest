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


_VIETNAMESE_TC_EXAMPLE = (
    '{"testCases":[{"title":"Đăng nhập thành công với email và mật khẩu hợp lệ",'
    '"type":"Chức năng","priority":"Cao","severity":"Nặng",'
    '"module":"Đăng nhập","precondition":"Tài khoản đã được kích hoạt",'
    '"steps":"1. Mở trang đăng nhập\\n2. Nhập email hợp lệ\\n3. Nhập mật khẩu đúng\\n4. Nhấn Đăng nhập",'
    '"expectedResult":"Hệ thống chuyển vào trang chủ và hiển thị tên người dùng",'
    '"testData":"email: user@example.com, mật khẩu: hợp lệ","automationReady":false}]}'
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
        "type dùng: Chức năng|Phủ định|Biên|API\n"
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
        "type: Chức năng|Phủ định|Biên|API · priority: Thấp|Trung bình|Cao|Nghiêm trọng."
    )


def system_prompt(ctx: GenerateContext | None = None) -> str:
    ctx = ctx or GenerateContext()
    base = (
        "Bạn là kỹ sư QA senior. Nhiệm vụ: sinh test case cụ thể từ tài liệu yêu cầu.\n\n"
        "QUY TẮC NGÔN NGỮ (BẮT BUỘC — vi phạm là sai):\n"
        "- Mọi nội dung PHẢI viết bằng TIẾNG VIỆT (kể cả type, priority, severity).\n"
        "- Áp dụng cho: title, type, priority, severity, module, precondition, steps, expectedResult, testData.\n"
        "- KHÔNG dùng tiếng Anh cho tiêu đề, bước, kết quả, loại, độ ưu tiên.\n"
        "- Dù requirement đầu vào là tiếng Anh, vẫn phải viết test case bằng tiếng Việt.\n\n"
        "Cách dùng tài liệu:\n"
        "- User Story: kịch bản người dùng, tiêu chí chấp nhận.\n"
        "- SRS / Feature: mỗi khối «Feature» là một chức năng riêng — phải cover đủ.\n"
        "- Requirement: phạm vi chính cần kiểm thử.\n"
        "- Trường module của mỗi test case = đúng tên chức năng (Feature) tương ứng.\n"
        "- Nếu có mã nguồn tham khảo: căn test case theo module/API/validation thực tế trong code.\n"
        "- Không bịa yêu cầu không có trong input.\n\n"
        "Trả về CHỈ JSON hợp lệ (không markdown), đúng schema:\n"
        '{"testCases":[{"title":"...","type":"Chức năng|Phủ định|Biên|API",'
        '"priority":"Thấp|Trung bình|Cao|Nghiêm trọng","severity":"Nhẹ|Nặng|Nghiêm trọng",'
        '"module":"...","precondition":"...","steps":"1. ...\\n2. ...",'
        '"expectedResult":"...","testData":"...","automationReady":false}]}\n\n'
        f"Ví dụ đúng (tiếng Việt):\n{_VIETNAMESE_TC_EXAMPLE}\n"
    )
    if ctx.mode == "append" and ctx.existing_cases and not ctx.topic_scope:
        base += (
            "\nCHẾ ĐỘ BỔ SUNG: Đã có test case bên dưới.\n"
            "Chỉ sinh test case MỚI cho phần còn thiếu — không trùng hoặc paraphrase nhẹ.\n"
            "Nếu đã đủ coverage, chỉ sinh 1–3 case bổ sung cho gap.\n"
            "Test case mới vẫn phải 100% tiếng Việt.\n"
        )
    elif ctx.topic_scope:
        n_feat = len(ctx.feature_titles) or 1
        base += (
            "\nSinh 5–12 test case chất lượng cho ĐÚNG một chức năng trong phạm vi chủ đề "
            "(happy path + negative + biên + luồng lỗi quan trọng trong tài liệu). "
            "Đọc HẾT tài liệu chức năng được cung cấp — không bỏ qua mục/ quy tắc nào. "
            "Toàn bộ nội dung tiếng Việt."
        )
    else:
        n = len(ctx.feature_titles)
        if n > 1:
            base += (
                f"\nTài liệu có {n} chức năng (Feature). "
                "Mỗi chức năng cần ít nhất 4–8 test case (happy path + negative + biên). "
                "Trường module PHẢI khớp đúng tên từng Feature. "
                "Không được chỉ sinh TC cho 1–2 module rồi bỏ qua phần còn lại. "
                "Toàn bộ nội dung tiếng Việt."
            )
        else:
            base += (
                "\nSinh 5–12 test case chất lượng (happy path + negative + biên). "
                "Bám sát toàn bộ tài liệu — không bỏ sót luồng nghiệp vụ. "
                "Toàn bộ nội dung tiếng Việt."
            )
    if ctx.custom_rules:
        base += f"\n\nQUY TẮC BỔ SUNG (ưu tiên cao — cấu hình BE):\n{truncate(ctx.custom_rules, 4000)}\n"
    return base


def user_prompt(title: str, content: str, ctx: GenerateContext | None = None) -> str:
    ctx = ctx or GenerateContext()
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

    sections = parse_sections(content)
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

    if ctx.custom_rules:
        parts.append(
            "## Quy tắc sinh test case (hệ thống — bắt buộc tuân thủ)\n"
            + truncate(ctx.custom_rules, 5000)
        )

    if ctx.change_summary:
        parts.append(f"## Thay đổi so với bản trước\n{truncate(ctx.change_summary, 2000)}")

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
        parts.append(
            "## Yêu cầu (Requirement)\n"
            + truncate(sections[SECTION_NOTES], 4000)
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
    raw = raw.strip()
    if not raw.startswith("```"):
        return raw
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
        if raw.startswith(prefix):
            raw = raw.removeprefix(prefix)
            break
    idx = raw.rfind("```")
    if idx >= 0:
        raw = raw[:idx]
    return raw.strip()


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
