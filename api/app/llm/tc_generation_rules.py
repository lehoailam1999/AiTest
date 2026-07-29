"""Quy tắc sinh test case dùng chung (BE) — áp dụng mọi job generate TC.

Chỉnh file này để đổi hành vi AI toàn hệ thống. Không nhập từ UI.
Rule phải DOCUMENT-AGNOSTIC: không giả định domain/app cụ thể (Todo, Login, …).
Bám sát tài liệu/requirement/SRS/source context của job hiện tại.
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
4. Độ phủ cho mỗi module (nếu job không giới hạn 1 chủ đề):
   - Tối thiểu khi tài liệu có tín hiệu tương ứng: 1 Happy Path + validation/negative (nếu có rule)
     + boundary/permission/edge (chỉ khi tài liệu nêu).
   - Không bịa thêm loại coverage chỉ vì checklist — chỉ cover tín hiệu có trong tài liệu.
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
11. TRƯỚC KHI TRẢ KẾT QUẢ:
   - Mỗi tiêu chí mục 10 có tín hiệu trong tài liệu → ≥1 TC tương ứng.
   - Không bỏ sót module/chức năng xuất hiện trong tài liệu hoặc output phân tích.
   - Thiếu dữ liệu để viết TC → ghi rõ trong precondition/testData hoặc [Giả định].
"""


# Shared skeleton when Studio locks Unit|E2E (engine overlay carries detail).
COMPACT_SHARED_TC_RULES = """\
QUY TẮC CHUNG (BẮT BUỘC):
1. Bám sát tài liệu job hiện tại — không giả định domain/app mẫu.
2. Mỗi Feature/module riêng; module field khớp tên trong tài liệu.
3. Title: "[Chức năng] - [Hành động] - [Kết quả kỳ vọng]" — tiếng Việt.
4. Precondition / testData / steps / expectedResult cụ thể, kiểm thử được, lấy từ tài liệu.
5. Coverage theo tín hiệu SRS: Happy Path + Validation/Negative + Boundary/Permission (chỉ nếu có).
6. Không bịa; thiếu chi tiết ghi [Giả định].
7. Không gộp Unit và E2E trong cùng một TC.
8. priority: Thấp|Trung bình|Cao|Nghiêm trọng · severity: Nhẹ|Nặng|Nghiêm trọng.
"""


def get_tc_generation_rules(*, preferred_engine: str | None = None) -> str:
    """Entry point — khi lock engine dùng skeleton gọn + overlay riêng (tiết kiệm token)."""
    eng = (preferred_engine or "").strip().lower()
    if eng in ("unit", "e2e"):
        return COMPACT_SHARED_TC_RULES.strip()
    return DEFAULT_TC_GENERATION_RULES.strip()


def engine_generation_rules(
    preferred_engine: str,
    *,
    target_url: str = "",
    auth_hint: str = "",
    focus_modules: str = "",
) -> str:
    """
    Extra rules when Studio generates Unit-only or E2E-only from the same SRS.
    preferred_engine: unit | e2e
    Document-agnostic: target_url / auth_hint / focus_modules chỉ gắn khi caller truyền.
    """
    eng = (preferred_engine or "").strip().lower()
    if eng not in ("unit", "e2e"):
        return ""

    if eng == "unit":
        parts = [
            "=== PHIÊN SINH UNIT (BẮT BUỘC) ===",
            "1. TRƯỚC TIÊN phân tích/tổng hợp theo góc nhìn Unit từ tài liệu + source context (nếu có):",
            "   - Xác định đơn vị kiểm thử: hàm/class/service/validator/API handler được mô tả hoặc suy ra từ tài liệu.",
            "   - Liệt kê input, output, dependency, mock, biên, exception, side-effect, business rule tầng logic.",
            "   - Tách logic thuần vs UI — KHÔNG đưa thao tác UI sang Unit.",
            "2. OUTPUT chỉ type=`Unit`; mọi TC phải type=`Unit`.",
            "3. Steps chuẩn: (1) Chuẩn bị input + mock -> (2) Gọi đơn vị cần test -> (3) Assert return/exception/side-effect.",
            "4. Expected Result: giá trị trả về, exception, state change, tương tác dependency — theo tài liệu/code.",
            "5. Coverage Unit theo tín hiệu tài liệu: happy path, validation, boundary, exception/fail path.",
            "6. KHÔNG sinh type=E2E trong phiên này.",
            "7. Không giả định tên class/file/domain mẫu; dùng tên module/API/hàm từ tài liệu hoặc source context.",
        ]
        if focus_modules.strip():
            parts.append(
                f"8. Ưu tiên module/chức năng: {focus_modules.strip()} (bám sát tài liệu)."
            )
        parts.append(
            "9. GỢI Ý GHÉP SOURCE (nếu source context có): trong testData/precondition có thể ghi "
            "`code: <TênClassHoặcStem>` hoặc `path: <đường dẫn tương đối trong repo>` để Unit Engine map mã nguồn."
        )
        return "\n".join(parts)

    parts = [
        "=== PHIÊN SINH E2E TEST CASE (BẮT BUỘC — QUY TRÌNH CHUẨN QA) ===",
        "1. TRƯỚC TIÊN phân tích/tổng hợp theo góc nhìn E2E từ tài liệu:",
        "   - Actor/role, màn hình/luồng bắt đầu, thao tác, điều hướng, dữ liệu nền, validation UI, business rule trên UI — nếu tài liệu có.",
        "   - Tách journey độc lập: happy path, validation, permission, boundary, recovery/cancel — chỉ mục có tín hiệu.",
        "   - Điểm quan sát UI chỉ khi tài liệu/UI mô tả: button/input/dropdown/modal/table/toast/url/loading/…",
        "2. OUTPUT chỉ type=`E2E`; mọi TC phải type=`E2E`.",
        "3. Mô tả user journey trên UI phù hợp nền tảng trong tài liệu (web/desktop/mobile) — không ép pattern app mẫu.",
        "4. NGUYÊN TẮC STEPS:",
        "   - Mỗi step: [Hành động] -> [Đối tượng/Element] -> [Dữ liệu nhập/Lựa chọn] (nếu có).",
        "   - Nêu element rõ (label/định danh nếu tài liệu có); tránh bước mơ hồ.",
        "5. EXPECTED RESULTS:",
        "   - Assert những gì tài liệu cho phép kiểm: phản hồi UI, trạng thái element/dữ liệu hiển thị.",
        "   - URL/điều hướng chỉ khi tài liệu hoặc target URL cho thấy có điều hướng.",
        "   - Persistence/reload chỉ khi nghiệp vụ có lưu dữ liệu.",
        "6. DANH MỤC KỊCH BẢN (gắn tag khi áp dụng):",
        "   - [E2E-HappyPath], [E2E-Validation], [E2E-BusinessRules], [E2E-Auth/Permission], [E2E-UI State & Boundary].",
        "7. PRECONDITION & TESTDATA:",
        "   - Precondition: điểm bắt đầu (URL/màn hình nếu biết), auth/role chỉ khi tài liệu hoặc auth hint yêu cầu,",
        "     dữ liệu nền cần thiết theo tài liệu — không bịa «đã đăng nhập» nếu không cần.",
        "   - TestData: giá trị fill/chọn cụ thể, lấy từ/suy ra từ tài liệu (không dùng credential mẫu mặc định).",
        "8. Mỗi TC = một kịch bản độc lập; không gộp nhiều luồng độc lập vào một TC dài.",
        "9. Coverage tối thiểu theo tín hiệu SRS: 1 happy path + validation/business/permission/boundary nếu có.",
        "10. KHÔNG sinh type=Unit/API thuần hàm trong phiên E2E.",
        "11. Không copy domain/route/label từ ví dụ prompt — mọi tên màn hình/field/URL lấy từ tài liệu job.",
    ]
    if target_url.strip():
        parts.append(
            f"12. TARGET URL: Đưa baseURL vào precondition/testData: {target_url.strip()}"
        )
    else:
        parts.append(
            "12. TARGET URL: Chưa có baseURL từ job — nếu tài liệu nêu URL/path thì dùng;"
            " nếu không, ghi điểm bắt đầu theo tên màn hình/chức năng và đánh dấu [Giả định] khi cần."
        )
    if auth_hint.strip():
        parts.append(
            f"13. AUTH HINT: Bổ sung precondition đăng nhập/phân quyền: {auth_hint.strip()}"
        )
    else:
        parts.append(
            "13. AUTH (không bắt buộc điền Auth hint trên form):\n"
            "   - KHÔNG yêu cầu user nhập credential trên form Freeze để sinh TC.\n"
            "   - TC chức năng SAU đăng nhập: precondition ghi "
            "«Phiên đã xác thực qua storageState / auth setup fixture» — "
            "KHÔNG bịa username/password; KHÔNG nhét bước login dài vào mọi TC.\n"
            "   - Chỉ TC [E2E-Auth/Permission] / luồng Login-Logout mới mô tả bước đăng nhập UI chi tiết "
            "(credential lấy từ tài liệu hoặc đánh dấu [Giả định] + biến môi trường).\n"
            "   - Khi chạy code: Desktop E2E dùng storageState (fixtures/storageState.json) để bỏ qua login UI."
        )
    if focus_modules.strip():
        parts.append(
            f"14. FOCUS MODULES: Ưu tiên kịch bản cho module/chức năng: {focus_modules.strip()}"
        )
    return "\n".join(parts)
