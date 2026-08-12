"""Quy tắc sinh test case dùng chung (BE) — áp dụng mọi job generate TC.

Chỉnh file này để đổi hành vi AI toàn hệ thống. Không nhập từ UI.
Rule phải DOCUMENT-AGNOSTIC: không giả định domain/app cụ thể (Todo, Login, …).
Bám sát tài liệu/requirement/SRS/source context của job hiện tại.

ĐỘ PHỦ: theo tín hiệu trong tài liệu — KHÔNG trần số lượng giả tạo.
"""

from __future__ import annotations

import logging
import os

from app.rules import get_rule_text
from app.rules import render_rules_for_profile_with_meta

logger = logging.getLogger(__name__)


# Rule mặc định: cover đủ mọi Feature/file, không bỏ sót module.
_LEGACY_DEFAULT_TC_GENERATION_RULES = """\
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
_LEGACY_COMPACT_SHARED_TC_RULES = """\
QUY TẮC CHUNG UNIT (BẮT BUỘC — BACKEND ONLY, PORTABLE, SRS-ONLY):
1. Bám Knowledge/Freeze — PRIMARY từ Phân tích (không đổi bucket); 6 gate IR; scope IN|OUT|MIXED|UNKNOWN.
2. module = Feature; title VN `[Feature] - [Hành động BE] - [Kết quả]` — cấm Class.Method Latin.
3. Steps = prepare/execute nghiệp vụ BE (không class/repo/HTTP invent). path/code = pha Approve.
4. 1 behaviorId / 1 TC; dedup cùng BE; coverage/gaps/unknown; cấm dừng sớm bỏ VALIDATION/FILE.
5. Không gộp Unit+E2E. OUT/presentation-only → không sinh. priority/severity thang Việt.
6. Self-check: còn IN chưa cover → TC hoặc gap; đủ → dừng.
"""

# E2E-only shared — thin pointer. SoT = e2e_tc_analysis_rules (coverage/trace/dedup/criteria).
_LEGACY_E2E_COMPACT_SHARED_TC_RULES = """\
QUY TẮC CHUNG E2E (format — SoT xem e2e_tc_analysis_rules):
1. module = tên FEATURES; title VN [Chức năng] - [Hành động] - [Kết quả].
2. priority: Thấp|Trung bình|Cao|Nghiêm trọng · severity: Nhẹ|Nặng|Nghiêm trọng.
"""

# Fan-out / speed=fast — shorter shared block (engine overlay + SPEED MODE addon carry detail).
_LEGACY_SPEED_SHARED_TC_RULES = """\
QUY TẮC CHUNG UNIT (SPEED — BACKEND ONLY, PORTABLE, SRS-ONLY):
1. Knowledge PRIMARY giữ nguyên; 6 gate IR (SRS-only); IN|OUT|MIXED|UNKNOWN; cấm invent / UNKNOWN→OUT / dừng sớm.
2. module = Feature; title VN `[Feature]-[Hành động BE]-[Kết quả]` (cấm Class.Method Latin).
3. Steps/expected = prepare→execute nghiệp vụ BE; thiếu → [Giả định]. Không bắt buộc source.
4. Không gộp Unit+E2E; không presentation-only. Cover PRIMARY + coverage gaps trước pad FEATURES.
5. Tôn trọng SPEED MODE — nhánh backend chính; priority/severity thang Việt.
"""

_LEGACY_E2E_SPEED_SHARED_TC_RULES = """\
QUY TẮC CHUNG E2E (SPEED — SoT xem e2e_tc_analysis_rules):
1. module = FEATURES; title VN [Chức năng]-[Hành động]-[Kết quả].
2. priority/severity thang Việt. Thiếu info → [Giả định].
"""

DEFAULT_TC_GENERATION_RULES = get_rule_text(
    "TC-GEN-DEFAULT", fallback=_LEGACY_DEFAULT_TC_GENERATION_RULES
)
COMPACT_SHARED_TC_RULES = get_rule_text(
    "TC-GEN-COMPACT-UNIT", fallback=_LEGACY_COMPACT_SHARED_TC_RULES
)
E2E_COMPACT_SHARED_TC_RULES = get_rule_text(
    "TC-GEN-COMPACT-E2E", fallback=_LEGACY_E2E_COMPACT_SHARED_TC_RULES
)
SPEED_SHARED_TC_RULES = get_rule_text(
    "TC-GEN-SPEED-UNIT", fallback=_LEGACY_SPEED_SHARED_TC_RULES
)
E2E_SPEED_SHARED_TC_RULES = get_rule_text(
    "TC-GEN-SPEED-E2E", fallback=_LEGACY_E2E_SPEED_SHARED_TC_RULES
)


def _tc_gen_selective_enabled() -> bool:
    mode = (os.environ.get("AITEST_RULE_RETRIEVE_MODE") or "full").strip().lower()
    gate = (os.environ.get("AITEST_RULE_RETRIEVE_TCGEN") or "").strip().lower()
    return mode == "selective" and gate not in ("0", "false", "no", "off")


def get_tc_generation_rules(
    *,
    preferred_engine: str | None = None,
    speed: str | None = None,
) -> str:
    """Entry point — khi lock engine dùng skeleton gọn + overlay riêng (tiết kiệm token)."""
    eng = (preferred_engine or "").strip().lower()
    fast = (speed or "").strip().lower() == "fast"
    if _tc_gen_selective_enabled():
        profile = "PROFILE-TC-MIXED-DEFAULT"
        if eng == "e2e":
            profile = (
                "PROFILE-TC-E2E-SHARED-SPEED" if fast else "PROFILE-TC-E2E-SHARED"
            )
        elif eng == "unit":
            profile = (
                "PROFILE-TC-UNIT-SHARED-SPEED" if fast else "PROFILE-TC-UNIT-SHARED"
            )
        selected, rule_ids, chars = render_rules_for_profile_with_meta(profile)
        if selected:
            logger.info(
                "RuleProfile apply profile=%s mode=%s ids=%s chars=%s",
                profile,
                "selective",
                ",".join(rule_ids),
                chars,
            )
            return selected.strip()
    if eng == "e2e":
        logger.info(
            "RuleProfile apply profile=%s mode=%s ids=%s chars=%s",
            "PROFILE-TC-E2E-SHARED",
            "full",
            "TC-GEN-COMPACT-E2E/TC-GEN-SPEED-E2E",
            len((E2E_SPEED_SHARED_TC_RULES if fast else E2E_COMPACT_SHARED_TC_RULES).strip()),
        )
        return (
            E2E_SPEED_SHARED_TC_RULES if fast else E2E_COMPACT_SHARED_TC_RULES
        ).strip()
    if eng == "unit":
        logger.info(
            "RuleProfile apply profile=%s mode=%s ids=%s chars=%s",
            "PROFILE-TC-UNIT-SHARED",
            "full",
            "TC-GEN-COMPACT-UNIT/TC-GEN-SPEED-UNIT",
            len((SPEED_SHARED_TC_RULES if fast else COMPACT_SHARED_TC_RULES).strip()),
        )
        if fast:
            return SPEED_SHARED_TC_RULES.strip()
        return COMPACT_SHARED_TC_RULES.strip()
    logger.info(
        "RuleProfile apply profile=%s mode=%s ids=%s chars=%s",
        "PROFILE-TC-MIXED-DEFAULT",
        "full",
        "TC-GEN-DEFAULT",
        len(DEFAULT_TC_GENERATION_RULES.strip()),
    )
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
                "1. type=`Unit` only — **Backend TC IR từ Knowledge** (SRS-only; không bắt buộc source).",
                "2. PRIMARY từ Phân tích — không đổi bucket. OUT→bỏ · MIXED→nhánh BE · UNKNOWN→unknownBehaviors · coverage/gaps bắt buộc.",
                "3. Steps: prepare/execute nghiệp vụ BE — cấm class/method/HTTP invent. path/code = Approve sau.",
                "4. 1 behaviorId / 1 TC; Coverage: VALIDATION_DATA + FILE security IN phải có TC hoặc gap — cấm dừng sớm happy-path.",
                "5. Title VN hành vi BE quan sát được — không mô tả UI presentation.",
            ]
            if cap:
                parts.append(
                    f"6. Trần mềm ≤{cap} TC/module: cover hết BR+VALIDATION+ERROR+AC(BE) trước; "
                    "FEATURES happy tối thiểu 0–1 — không cắt PRIMARY có tín hiệu."
                )
            else:
                parts.append(
                    "6. Cover đủ PRIMARY (BR/VALIDATION/ERROR/AC-BE) trước pad FEATURES."
                )
            if focus_modules.strip():
                parts.append(f"7. Focus module: {focus_modules.strip()}.")
            return append_unit_tc_from_analysis_rules("\n".join(parts), speed=True)

        parts = [
            "=== PHIÊN SINH UNIT ===",
            "1. type=`Unit` only — Backend TC IR (SRS-only). 6 gate rồi scope atomic IN|OUT|MIXED|UNKNOWN.",
            "2. PRIMARY buckets từ Phân tích (giữ nguyên) — chi tiết khối UNIT ← PHÂN TÍCH.",
            "3. Steps prepare/execute nghiệp vụ; expected observable BE — không class/repo/HTTP invent; không test entrypoint/bootstrap (main.ts/Program).",
            "4. Coverage/Gap + Conflict: inventory IN↔TC; unknownBehaviors khi thiếu Knowledge; layerHint=null trừ Knowledge nói rõ.",
            "5. Output JSON: testCases + coverage + gaps + unknownBehaviors + conflicts; mỗi TC có behaviorId + primaryBucket.",
            "6. path:/code: thuộc Approve/Retrieval — không yêu cầu ở pha sinh TC.",
            "7. OUT/UNKNOWN → không sinh Unit TC; MIXED → chỉ nhánh BE; cấm UNKNOWN→OUT; cấm dừng sớm bỏ validation/file.",
        ]
        if focus_modules.strip():
            parts.append(f"8. Focus module (khớp FEATURES): {focus_modules.strip()}.")
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
                f"4. BASE URL (env only): ghi `baseURL: {target_url.strip()}` trong testData — "
                "**không** dùng làm `path:`/`featurePath:`/`url:` route."
            )
        else:
            parts.append(
                "4. BASE URL: chưa có — chỉ ghi AbsolutePath `path:`/`featurePath:` từ Output; "
                "thiếu → null/[Thiếu Context]. Cấm invent route từ tên module."
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
            f"4. BASE URL (env only): ghi `baseURL: {target_url.strip()}` trong testData — "
            "**không** dùng làm `path:`/`featurePath:`/`url:` route."
        )
    else:
        parts.append(
            "4. BASE URL: chưa có — chỉ AbsolutePath `path:`/`featurePath:` từ Output; "
            "thiếu → null/[Thiếu Context]. Cấm invent route từ tên module."
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
        "`testData` có `path: /…` hoặc `featurePath: /…` AbsolutePath ASCII từ FLOWS|API_UI|FEATURES "
        "(không invent; không slug module VN). Tuỳ chọn `landmark:` nhãn màn. Login/Logout/PUBLIC: miễn. "
        "Cấm malware/toast invent nếu Output không nói; wizard → steps concrete."
    )
    if focus_modules.strip():
        parts.append(f"7. FOCUS MODULES (khớp FEATURES): {focus_modules.strip()}")
    return append_e2e_tc_from_analysis_rules("\n".join(parts), speed=False)
