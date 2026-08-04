"""Quy tắc sinh test case dùng chung (BE) — áp dụng mọi job generate TC.

Chỉnh file này để đổi hành vi AI toàn hệ thống. Không nhập từ UI.
Rule phải DOCUMENT-AGNOSTIC: không giả định domain/app cụ thể (Todo, Login, …).
Bám sát tài liệu/requirement/SRS/source context của job hiện tại.

ĐỘ PHỦ: theo tín hiệu trong tài liệu — KHÔNG trần số lượng giả tạo.
"""

from __future__ import annotations


# Rule mặc định: cover đủ mọi Feature/file, không bỏ sót module.
DEFAULT_TC_GENERATION_RULES = """\
QUY TẮC SINH TEST CASE (BẮT BUỘC — HỆ THỐNG):
0. NGUỒN SỰ THẬT: Chỉ dùng nội dung trong tài liệu đầu vào của job (requirement, SRS, User Story,
   knowledge/analysis, source context, focus modules, target URL/auth hint nếu có).
   Không mang domain/app mẫu từ ví dụ prompt; không giả định login/email/CRUD nếu tài liệu không nêu.
1. Context đa file: Mỗi khối Feature / mỗi file SRS / mỗi chức năng tách rõ trong tài liệu = một module riêng.
   Nếu tài liệu không dùng chữ «Feature», vẫn tách theo heading/màn hình/API/service được mô tả.
2. Phân tích toàn diện: Quét HẾT Acceptance Criteria (AC), User Story, Business Rules, UI/flow, Validation
   và mọi quy tắc nghiệp vụ có trong tài liệu. Không bỏ sót luồng đã nêu.
3. TRƯỚC KHI SINH TEST CASE, phải tự phân tích và tổng hợp chức năng:
   - Xác định tên chức năng/module, mục tiêu, actor/role (nếu có), dữ liệu vào/ra, điều kiện trước/sau,
     business rules, validation, trạng thái/nhánh xử lý chính — theo đúng những gì tài liệu cung cấp.
   - Nhiều màn hình/API/service: nhóm theo chức năng con trước khi viết TC.
   - Chỉ sinh TC sau khi đã tách rõ phạm vi; thiếu thông tin thì tận dụng SRS/Knowledge/TC hiện có;
     chỉ dùng [Giả định] khi thực sự cần và ghi rõ.
4. ĐỘ PHỦ THEO TÍN HIỆU (BẮT BUỘC — KHÔNG TRẦN SỐ LƯỢNG):
   - KHÔNG giới hạn số lượng giả tạo. Số TC = số kịch bản độc lập cần cover.
   - Mỗi tín hiệu độc lập trong tài liệu → ≥1 TC riêng (không gộp nhiều FR/AC/rule vào một TC dài):
     FR/User Story · AC · Business rule · Validation/input · Permission/auth (nếu có actor/role) ·
     State transition · Error/exception · Boundary/edge · Data integrity (C/U/D) ·
     Integration (API/DB/event nếu nêu) · UI journey (E2E, nếu có UI).
   - Floor tối thiểu khi có tín hiệu chức năng: ≥1 Happy Path; thêm negative/validation/boundary
     chỉ khi tài liệu có rule tương ứng — không bịa coverage «cho đủ checklist».
   - Module lớn / nhiều AC: sinh ĐỦ mọi case; ưu tiên tách theo module/fan-out nếu hệ thống đã chia —
     không dừng sớm vì «đã đủ vài case».
5. Trường `module` khớp tên chức năng/màn hình/heading trong tài liệu (không gộp nhiều chức năng).
6. Chuẩn hóa thuộc tính Test Case (BẮT BUỘC tiếng Việt):
   - `title`: "[Chức năng] - [Hành động] - [Kết quả kỳ vọng]" (dùng tên chức năng từ tài liệu).
   - `precondition`: môi trường, role/auth (nếu có), dữ liệu nền cần thiết theo tài liệu.
   - `testData`: giá trị đầu vào cụ thể lấy từ/suy ra từ tài liệu (không dùng email/password mẫu nếu không liên quan).
   - `steps`: đánh số 1..N, thao tác rõ ràng.
   - `expectedResult`: phản hồi/UI/API/state đúng với tài liệu (chỉ assert URL/toast/persistence nếu nghiệp vụ có).
   - `priority`: Thấp | Trung bình | Cao | Nghiêm trọng.
   - `severity`: Nhẹ | Nặng | Nghiêm trọng.
7. PHÂN LOẠI ENGINE (trường `type`) — chọn đúng theo phạm vi kiểm thử:
   - `Unit`: hàm/class/service/validator/API handler (không mở trình duyệt).
   - `E2E`: user journey qua UI (nếu tài liệu mô tả UI/web/desktop app có tương tác).
   - `API`: HTTP endpoint khi tài liệu mô tả API.
8. Không gộp Unit và E2E trong cùng một TC.
9. Không bịa đặt yêu cầu ngoài tài liệu. Bổ sung UX/UI thiếu → tag [Giả định].
10. KHUNG COVERAGE (ANTI-MISS — chỉ áp dụng mục có tín hiệu trong tài liệu):
   - Functional happy path
   - Validation/input rule
   - Business rule / state transition
   - Permission/auth (chỉ khi có actor/role/auth)
   - Error/exception
   - Data integrity (khi có create/update/delete hoặc persistence)
   - Integration (API/DB/event nếu tài liệu/source nêu)
   - UI state (E2E, nếu có UI)
   - Negative & boundary
11. TRƯỚC KHI TRẢ KẾT QUẢ (SELF-CHECK):
   - Liệt kê mental checklist: mọi FR/AC/rule/validation/API/use-case trong phạm vi đã có ≥1 TC?
   - Thiếu → bổ sung trước khi trả JSON. Đủ → không thêm case bịa.
   - Không bỏ sót module/chức năng xuất hiện trong tài liệu hoặc output phân tích.
   - Thiếu dữ liệu để viết TC → ghi rõ trong precondition/testData hoặc [Giả định].
   - Không trả mảng rỗng / «đã cover» / tóm tắt thay vì JSON đầy đủ.
"""


# Shared skeleton when Studio locks Unit|E2E
# (engine overlay + unit_tc_analysis / e2e_tc_analysis carry SoT detail).
# Keep thin — do NOT restate bucket map / trace / completeness here.
COMPACT_SHARED_TC_RULES = """\
QUY TẮC CHUNG (BẮT BUỘC):
1. Bám Knowledge/Freeze của job — không domain mẫu; bucket rỗng → không invent.
2. module = tên Feature trong phạm vi; title tiếng Việt [Chức năng] - [Hành động] - [Kết quả].
3. precondition / testData / steps / expectedResult cụ thể, kiểm được; thiếu → [Giả định].
4. Mỗi tín hiệu độc lập trong phạm vi → ≥1 TC; không gộp nhiều tín hiệu; không trần giả tạo.
5. Không gộp Unit+E2E trong 1 TC. priority: Thấp|Trung bình|Cao|Nghiêm trọng · severity: Nhẹ|Nặng|Nghiêm trọng.
6. Self-check: còn tín hiệu chưa có TC → bổ sung; đủ → dừng (không pad).
"""

# E2E-only shared — SoT (e2e_tc_analysis_rules) owns coverage/trace/completeness/lock.
# Do NOT restate Scenario/Workflow/BR/gate here (avoids triple with SoT + overlay).
E2E_COMPACT_SHARED_TC_RULES = """\
QUY TẮC CHUNG E2E (format):
1. module = tên FEATURES; title tiếng Việt [Chức năng] - [Hành động] - [Kết quả].
2. precondition / testData / steps / expectedResult cụ thể; thiếu → [Giả định] / [Thiếu Output].
3. priority: Thấp|Trung bình|Cao|Nghiêm trọng · severity: Nhẹ|Nặng|Nghiêm trọng.
"""

# Fan-out / speed=fast — shorter shared block (engine overlay + SPEED MODE addon carry detail).
SPEED_SHARED_TC_RULES = """\
QUY TẮC CHUNG (SPEED):
1. Bám Knowledge/Freeze — không copy domain mẫu; không invent bucket rỗng.
2. module = Feature trong phạm vi; title VN [Chức năng]-[Hành động]-[Kết quả].
3. Steps/expected/precondition/testData cụ thể; thiếu → [Giả định].
4. Không gộp Unit+E2E. priority/severity thang Việt.
5. Tôn trọng SPEED MODE (trần mềm) trong system prompt — ưu tiên nhánh chính.
"""

E2E_SPEED_SHARED_TC_RULES = """\
QUY TẮC CHUNG E2E (SPEED format — gọn prompt, đủ cover):
1. module = FEATURES; title VN [Chức năng]-[Hành động]-[Kết quả].
2. Steps/expected/precondition/testData cụ thể; thiếu → [Giả định].
3. Cover đủ tín hiệu Output; cấm TC thừa/trùng — không trần số TC cố định.
"""


def get_tc_generation_rules(
    *,
    preferred_engine: str | None = None,
    speed: str | None = None,
) -> str:
    """Entry point — khi lock engine dùng skeleton gọn + overlay riêng (tiết kiệm token)."""
    eng = (preferred_engine or "").strip().lower()
    fast = (speed or "").strip().lower() == "fast"
    if eng == "e2e":
        return (
            E2E_SPEED_SHARED_TC_RULES if fast else E2E_COMPACT_SHARED_TC_RULES
        ).strip()
    if eng == "unit":
        if fast:
            return SPEED_SHARED_TC_RULES.strip()
        return COMPACT_SHARED_TC_RULES.strip()
    return DEFAULT_TC_GENERATION_RULES.strip()


def engine_generation_rules(
    preferred_engine: str,
    *,
    target_url: str = "",
    auth_hint: str = "",
    focus_modules: str = "",
    speed: str | None = None,
    max_per_module: int | None = None,
) -> str:
    """
    Extra rules when Studio generates Unit-only or E2E-only from the same SRS.
    preferred_engine: unit | e2e
    Document-agnostic: target_url / auth_hint / focus_modules chỉ gắn khi caller truyền.

    Unit: SoT/map/trace trong unit_tc_analysis_rules (prepend) —
    overlay chỉ AAA / bootstrap / focus.
    E2E: SoT/completeness/trace trong e2e_tc_analysis_rules (prepend) —
    overlay chỉ tags / auth / target_url / focus (không restates Step/Expected/Coverage).
    """
    eng = (preferred_engine or "").strip().lower()
    if eng not in ("unit", "e2e"):
        return ""

    fast = (speed or "").strip().lower() == "fast"
    cap = max_per_module if isinstance(max_per_module, int) and max_per_module > 0 else None

    if eng == "unit":
        from app.llm.unit_tc_analysis_rules import append_unit_tc_from_analysis_rules

        if fast:
            parts = [
                "=== PHIÊN SINH UNIT (SPEED) ===",
                "1. type=`Unit` only — hàm/service/validator/handler; không UI.",
                "2. Steps: Arrange mock → Act → Assert return/exception/side-effect.",
                "3. Cấm SUT entrypoint bootstrap (main.ts, Program.cs, …).",
            ]
            if cap:
                parts.append(
                    f"4. Trần mềm ≤{cap} TC/module: FEATURES happy + VALIDATION/BR chính."
                )
            else:
                parts.append("4. Ưu tiên nhánh chính có trong Phân tích.")
            if focus_modules.strip():
                parts.append(f"5. Focus module: {focus_modules.strip()}.")
            return append_unit_tc_from_analysis_rules("\n".join(parts), speed=True)

        parts = [
            "=== PHIÊN SINH UNIT ===",
            "1. type=`Unit` only — không E2E/UI click-fill.",
            "2. Steps: (1) input+mock → (2) gọi SUT → (3) assert return/exception/side-effect.",
            "3. Expected khớp rule/text Phân tích (+ code nếu có).",
            "4. SUT = pipe/controller/service/validator/DTO/handler — "
            "cấm bootstrap (main.ts/js, Program.cs, wsgi/asgi, Spring Boot Application.main).",
            "5. testData: `trace:` (bắt buộc) + tùy chọn `code:`/`path:` map source "
            "(tránh path entrypoint trừ Project Extra cho phép).",
        ]
        if focus_modules.strip():
            parts.append(f"6. Focus module (khớp FEATURES): {focus_modules.strip()}.")
        return append_unit_tc_from_analysis_rules("\n".join(parts), speed=False)

    from app.llm.e2e_tc_analysis_rules import append_e2e_tc_from_analysis_rules

    # Overlay = runtime hints only. Steps / Expected / Scenario / Coverage → SoT.
    if fast:
        parts = [
            "=== PHIÊN SINH E2E (SPEED) ===",
            "1. type=`E2E` only.",
            "2. Tag khi khớp: [E2E-HappyPath], [E2E-Validation], [E2E-Auth/Permission], "
            "[E2E-Boundary], [E2E-Error].",
        ]
        if cap:
            parts.append(
                f"3. Trần tùy chọn ≤{cap}: chỉ bỏ journey phụ/trùng — "
                "không cắt FLOWS/happy/AUTH/VALIDATION/ERROR; không pad."
            )
        else:
            parts.append(
                "3. Cover đủ tín hiệu SoT; cấm thừa (trùng trace / cùng expected+flow)."
            )
        if target_url.strip():
            parts.append(
                f"4. TARGET URL: baseURL trong precondition/testData: {target_url.strip()}"
            )
        else:
            parts.append(
                "4. TARGET URL: path/màn từ Output hoặc tên màn + [Giả định]."
            )
        if auth_hint.strip():
            parts.append(f"5. AUTH HINT: {auth_hint.strip()}")
        else:
            parts.append(
                "5. AUTH: TC sau login → precondition «phiên storageState/auth setup»; "
                "chỉ TC Auth/Login mới mô tả bước đăng nhập UI."
            )
        parts.append(
            "6. FEATURE PATH (E2E_GROUNDING): post-login → testData `path: /…` hoặc "
            "`featurePath: /…` từ Output routes — cấm invent; Login/PUBLIC miễn."
        )
        if focus_modules.strip():
            parts.append(f"7. FOCUS: {focus_modules.strip()}")
        return append_e2e_tc_from_analysis_rules("\n".join(parts), speed=True)

    parts = [
        "=== PHIÊN SINH E2E ===",
        "1. type=`E2E` only.",
        "2. Tag khi khớp: [E2E-HappyPath], [E2E-Validation], [E2E-BusinessRules], "
        "[E2E-Auth/Permission], [E2E-UI State & Boundary].",
        "3. Precondition: điểm bắt đầu + auth/role chỉ khi Output/auth hint yêu cầu; "
        "không credential mẫu.",
    ]
    if target_url.strip():
        parts.append(
            f"4. TARGET URL: baseURL trong precondition/testData: {target_url.strip()}"
        )
    else:
        parts.append(
            "4. TARGET URL: chưa có baseURL job — dùng path/màn từ Output; thiếu → [Giả định]."
        )
    if auth_hint.strip():
        parts.append(
            f"5. AUTH HINT: precondition đăng nhập/phân quyền: {auth_hint.strip()}"
        )
    else:
        parts.append(
            "5. AUTH: TC sau login → «Phiên đã xác thực qua storageState / auth setup» — "
            "không bịa credential; chỉ TC [E2E-Auth/Permission]/Login mô tả bước login UI."
        )
    parts.append(
        "6. FEATURE PATH (E2E_GROUNDING): mọi TC post-login / không PUBLIC → "
        "`testData` có `path: /…` hoặc `featurePath: /…` từ FLOWS|API_UI|FEATURES "
        "(không invent). Tuỳ chọn `landmark:` nhãn màn. Login/Logout/PUBLIC: miễn."
    )
    if focus_modules.strip():
        parts.append(f"7. FOCUS MODULES (khớp FEATURES): {focus_modules.strip()}")
    return append_e2e_tc_from_analysis_rules("\n".join(parts), speed=False)
