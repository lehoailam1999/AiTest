"""Heuristic (+ optional LLM) Knowledge Builder from document chunks (R3).

Criteria aligned with SRS readiness for Generate TC:
summary, features, actors, useCases, businessRules, validationRules,
apiSummary, exceptions, acceptanceCriteria, constraints, gaps.
Legacy keys (glossary, databaseSummary, openQuestions, missingInformation)
are dual-written for compatibility and folded via normalize.
"""

from __future__ import annotations

import json
import re
from typing import Any

from app.llm.base import strip_code_fences

MAX_CHUNK_CHARS_FOR_BUILD = 24_000
# Oneshot enrich excerpt budget (CLI latency). Override: AITEST_KNOWLEDGE_ENRICH_MAX_CHARS.
MAX_CHUNK_CHARS_ONESHOT_ENRICH = 7_000
MAX_ITEMS = 40
MAX_GAPS = 20
MAX_EVIDENCE_PER_ITEM = 3

_API_RE = re.compile(
    r"\b(GET|POST|PUT|PATCH|DELETE)\s+(/[A-Za-z0-9_\-./{}:]+)",
    re.IGNORECASE,
)
# Label form only — do NOT treat «Người dùng ---->» ASCII diagrams as actors.
_ACTOR_LINE_RE = re.compile(
    r"(?i)^\s*(?:[-*•]\s*)?(?:actor|vai\s*trò|role|persona|tác\s*nhân)\s*[:：]\s*(.+)$"
)
# Coded requirement rows in markdown tables (formal SRS).
_FR_TABLE_ROW = re.compile(
    r"(?i)^\s*\|\s*FR[\s\-_]*(\d+)\s*\|\s*([^|]+?)\s*\|"
)
_UC_TABLE_ROW = re.compile(
    r"(?i)^\s*\|\s*UC[\s\-_]*(\d+)\s*\|\s*([^|]+?)\s*\|"
)
_BR_TABLE_ROW = re.compile(
    r"(?i)^\s*\|\s*BR[\s\-_]*(\d+)\s*\|\s*([^|]+?)\s*\|"
)
_AC_INLINE = re.compile(
    r"(?i)\bAC[\s\-_]*(\d+)\s*:\s*(.+?)(?=(?:\s*<br\s*/?\s*>|\s*AC[\s\-_]*\d+\s*:|\s*\||$))"
)
_NFR_TABLE_ROW = re.compile(
    r"(?i)^\s*\|\s*NFR[\s\-_]*(\d+)\s*\|\s*([^|]+)\|\s*([^|]+?)\s*\|"
)
_API_TABLE_ROW = re.compile(
    r"(?i)^\s*\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`?(/[A-Za-z0-9_\-./{}:]+)`?\s*\|"
)
_USER_STORY_ACTOR_RE = re.compile(
    r"(?i)\blà\s+một\s+([^,.;\n]+)|\bas\s+an?\s+([^,.;\n]+)"
)
_RULE_HINT = re.compile(
    r"(?i)\b(phải|bắt buộc|không được|cấm|shall|must|should not|required)\b"
)
# Tight gaps — avoid treating every "?" as an open question.
# Do NOT use case-insensitive TODO (matches product name «Todo App»).
_GAP_HINT = re.compile(
    r"(?:\bTBD\b|\bTODO\b|(?i:cần làm rõ|chưa xác định|open question|to be defined|chưa rõ))"
)
_USECASE_HEAD = re.compile(
    r"(?i)^(use\s*case|uc[\s\-_]?\d+|luồng|flow|scenario|kịch bản)\b"
)
# SRS numbered use cases: "01 Xem danh sách todo", "UC-01: Login"
# Do NOT match outline numbers like "1. Giới thiệu" / "1.1. Mục đích".
_NUMBERED_UC_TITLE = re.compile(
    r"(?i)^(?:"
    r"(?:use\s*case|uc)[\s\-_]*\d+\s*[:\-–.]?\s*|"
    r"0\d{1,2}[\s.\-–:]+\s*"  # zero-padded 01/02… only
    r")(.+)$"
)
# Functional requirement headings: "FR-01: Xem danh sách todo"
_FR_HEAD = re.compile(
    r"(?i)^FR[\s\-_]*(\d+)\s*[:\-–.]?\s*(.+)$"
)
_FEATURE_HEAD = re.compile(
    r"(?i)^(feature|chức năng|module|epic|capability)[\s\-_:.]+\s*(.+)$"
)
_FEATURE_HEAD_SIMPLE = re.compile(
    r"(?i)^(feature|chức năng|module|mô\s*tả\s*chức\s*năng|chi\s*tiết\s*chức\s*năng)\b"
)
_NUMBERED_SECTION_HEAD = re.compile(r"^\d+(?:\.\d+)+\s+(.+)$")
_CAPABILITY_SECTION_HEAD = re.compile(
    r"(?i)^(?:mô\s*tả\s*(?:chức\s*năng|nghiệp\s*vụ)|"
    r"chi\s*tiết\s*chức\s*năng|functional\s*description)\b"
)
_VALIDATION_HINT = re.compile(
    r"(?i)\b(validation|validate|kiểm tra|định dạng|format|max length|min length|"
    r"độ dài|bắt buộc|required field|regex|schema|invalid|unique|không được trống|"
    r"email|số điện thoại|range|từ\s+\d+\s+đến)\b"
)
_EXCEPTION_HINT = re.compile(
    r"(?i)\b(exception|error|lỗi|xử lý lỗi|timeout|retry|fallback|HTTP\s*[45]\d\d|"
    r"403|401|404|500|forbidden|unauthorized|fail|thất bại)\b"
)
_ACCEPTANCE_HINT = re.compile(
    r"(?i)\b("
    r"given[\s\-]|when[\s\-]|then[\s\-]|done\s+when|"
    r"tiêu chí chấp nhận\s*[:：]|AC\s*\d+|"
    r"kỳ vọng\s*[:：]|expected\s*[:：]"
    r")\b"
)
# Section headings in SRS — never become feature/AC items by themselves.
_CRITERION_SECTION_LABEL = re.compile(
    r"(?i)^(?:"
    r"acceptance\s*criteria?|tiêu chí chấp nhận|"
    r"business\s*rules?|quy tắc nghiệp vụ|"
    r"validation(?:\s*&\s*dữ liệu)?|"
    r"api(?:\s*/\s*giao diện|\s*summary|\s*định nghĩa)?|"
    r"exceptions?|xử lý lỗi|error\s*handling|"
    r"luồng\s+ngoại\s+lệ(?:\s*\([^)]*\))?|exception\s+flows?(?:\s*\([^)]*\))?|"
    r"alternate\s+flows?|alternative\s+flows?|"
    r"constraints?|ràng buộc(?:\s*nfr)?|nfr|"
    r"gaps?|thiếu sót|open\s*questions?|"
    r"use\s*cases?|luồng nghiệp vụ|kịch bản|"
    r"features?|chức năng|modules?|"
    r"actors?(?:\s*&\s*quyền)?|vai trò|tác\s*nhân|"
    r"summary|tóm tắt(?:\s*&\s*phạm vi)?|phạm vi"
    r")\.?\s*$"
)
# Common SRS template/document-outline headings — not functional items.
# Includes EN IEEE-style + VI mục lục + structural labels (Endpoints, Todo Model…).
_DOC_META_SECTION_LABEL = re.compile(
    r"(?i)^(?:"
    r"introduction|overall\s+description|functional\s+requirements|"
    r"external\s+interface\s+requirements|non[\s\-]*functional\s+requirements?|"
    r"use\s*cases?\s*(?:\(.*\))?|guidance\s+for\s+test\s+case\s+generation|"
    r"sample\s+test\s+outline(?:\s*\(.*\))?|appendix(?:\s*[-—–:]\s*.*)?|"
    r"project\s+structure|software\s+requirements?\s+specification|"
    r"srs|đặc\s*tả\s*yêu\s*cầu(?:\s*phần\s*mềm)?|"
    # Structural / model sections (not a user-facing capability)
    r"endpoints?|api\s*endpoints?|routes?|"
    r"(?:todo\s+)?model|data\s*model|domain\s*model|entities?|entity|"
    r"schema|dto|database\s*schema|thực\s*thể(?:\s+todo)?|"
    # Formal SRS TOC (VI + EN glosses stripped separately)
    r"mục\s*tiêu|mục\s*đích(?:\s*tài\s*liệu)?|giới\s*thiệu|"
    r"tổng\s*quan(?:\s*hệ\s*thống)?|"
    r"mô\s*tả\s*tổng\s*quan(?:\s*hệ\s*thống)?|mô\s*tả\s*hệ\s*thống|"
    r"mô\s*hình\s*nghiệp\s*vụ|bối\s*cảnh\s*sản\s*phẩm|"
    r"các\s*bên\s*liên\s*quan|stakeholders?|đặc\s*điểm\s*người\s*dùng|"
    r"phạm\s*vi(?:\s*(?:dự\s*án|sản\s*phẩm))?|ngoài\s*phạm\s*vi|out\s*of\s*scope|"
    r"tác\s*nhân|đối\s*tượng\s*sử\s*dụng|actor|"
    r"yêu\s*cầu\s*chức\s*năng|yêu\s*cầu\s*phi[\s\-]*chức\s*năng|"
    r"yêu\s*cầu\s*phi\s*chức\s*năng|yêu\s*cầu\s*hệ\s*thống|"
    r"yêu\s*cầu\s*giao\s*diện(?:\s*bên\s*ngoài)?|"
    r"api\s*định\s*nghĩa|định\s*nghĩa\s*api|đặc\s*tả\s*api|đặc\s*tả\s*use\s*case|"
    r"danh\s*sách\s*use\s*case|sơ\s*đồ\s*use\s*case|"
    r"quy\s*tắc\s*nghiệp\s*vụ(?:\s*và\s*validation)?|"
    r"hướng\s*dẫn(?:\s*(?:chạy\s*thử|cài\s*đặt|sử\s*dụng|môi\s*trường))?|"
    r"test\s*case\s*gợi\s*ý|gợi\s*ý\s*test\s*case|test\s*cases?(?:\s*gợi\s*ý)?|"
    r"kịch\s*bản\s*kiểm\s*thử(?:\s*nghiệm\s*thu)?|uat|test\s*scenarios?|"
    r"ma\s*trận\s*truy\s*vết(?:\s*yêu\s*cầu)?|requirement\s*traceability|"
    r"tiêu\s*chí\s*nghiệm\s*thu(?:\s*tổng\s*thể)?|phụ\s*lục|"
    r"frontend|backend|database|kiến\s*trúc|cấu\s*trúc\s*dự\s*án|"
    r"tài\s*liệu\s*tham\s*(?:chiếu|khảo)|định\s*nghĩa\s*và\s*từ\s*viết\s*tắt|"
    r"lịch\s*sử\s*thay\s*đổi|giả\s*định(?:\s*và\s*phụ\s*thuộc)?|ràng\s*buộc(?:\s*hệ\s*thống)?|"
    r"thực\s*thể(?:\s+\w+)?|giao\s*diện\s*(?:người\s*dùng|api|ui|bên\s*ngoài)|"
    r"hướng\s*dẫn\s*môi\s*trường(?:\s*chạy\s*thử)?|"
    r"tiêu\s*chí\s*nghiệm\s*thu(?:\s*tổng\s*thể)?|phụ\s*lục(?:\s*[-—–:].*)?|"
    r"ghi\s*chú\s*phiên\s*bản|backlog(?:\s*gợi\s*ý)?|"
    r"trạng\s*thái\s*công\s*việc(?:\s*trên\s*ui)?"
    r")\.?\s*$"
)
# Capability-like verbs — empty-desc feature may keep only if name has one.
_FEATURE_ACTION_HINT = re.compile(
    r"(?i)\b("
    r"xem|tạo|thêm|cập\s*nhật|sửa|xóa|xoá|validate|kiểm\s*tra|"
    r"đăng\s*nhập|đăng\s*xuất|đăng\s*ký|quản\s*lý|hiển\s*thị|tìm\s*kiếm|lọc|"
    r"từ\s*chối|trả|cho\s*phép|reject|allow|display|show|"
    r"lưu|gửi|submit|save|cancel|hủy|export|import|tải|download|upload|"
    r"view|create|update|delete|edit|search|login|logout|register|signup"
    r")\b"
)
# UI control / field label — NOT a FEATURE capability (→ validationRules or drop).
_UI_CONTROL_PREFIX = re.compile(
    r"(?i)^(?:"
    r"(?:nút|btn|button|link|hyperlink|icon|ô\s*nhập|ô|trường|field|input|"
    r"textbox|textarea|select|dropdown|checkbox|radio|switch|toggle|label|"
    r"placeholder|combobox|datepicker|upload|file\s*input|control|widget)"
    r"[\s:.\-–]*)"
)
_FIELD_LABEL_ONLY = re.compile(
    r"(?i)^(?:"
    r"e-?mail|username|user\s*name|password|mật\s*khẩu|"
    r"họ\s*tên|tên(?:\s+đăng\s*nhập)?|title|tiêu\s*đề|mô\s*tả|description|"
    r"phone|sđt|sdt|mobile|address|địa\s*chỉ|"
    r"ngày(?:\s*sinh)?|date|time|datetime|status|trạng\s*thái|"
    r"mã|code|ảnh|image|avatar|notes|ghi\s*chú|remark|comment|"
    r"submit|reset|ok|cancel|close|đóng|mở"
    r")(?:\s*\([^)]*\))?$"
)
# Item must contain at least one testable concrete token from SRS.
_CONCRETE_DETAIL = re.compile(
    r"(?i)(?:"
    r"/[\w\-./{}:]+|"
    r"\b(?:GET|POST|PUT|PATCH|DELETE)\s+/|"
    r"\bFR[-\s]?\d+\b|"
    r"\b\d+\s*(?:ms|s|giây|phút|minute|min|day|ngày|giờ|h|mb|kb|%)\b|"
    r"\b(?:Bearer|JWT|userId|email|password|refreshToken|accessToken)\b|"
    r"\b(?:401|403|404|409|422|500)\b|"
    r"`[^`]{2,}`|"
    r"\b(?:CORS|TTL|localhost|OPTIONS)\b"
    r")"
)
_MARKDOWN_OR_SRS_DUMP = re.compile(
    r"(?i)(?:^|\s)#{1,6}\s|software\s+requirements?\s+specification|\bsrs\b.*\bsrs\b"
)
_GLOSSARY_RE = re.compile(
    r"(?i)^\s*(?:[-*•]\s*)?([A-Za-zÀ-ỹ0-9][\wÀ-ỹ0-9 \-/]{1,40})\s+(?:là|means|:)\s+(.+)$"
)
_ENTITY_RE = re.compile(
    r"(?i)\b(?:bảng|table|entity|entities|model)\s+[`'\"]?([A-Za-z_][\w]*)[`'\"]?"
)
_FLOW_STEP_HINT = re.compile(
    r"(?i)^\s*(?:\d+[.)]|[-*•])\s*(mở|truy cập|vào|nhập|chọn|click|nhấn|bấm|tạo|sửa|xóa|lưu|gửi|xác nhận|đăng nhập|đăng xuất|tìm kiếm)\b"
)
_AUTH_HINT = re.compile(
    r"(?i)\b(login|đăng nhập|đăng xuất|role|vai trò|quyền|permission|phân quyền|403|401|unauthorized|forbidden)\b"
)

PRIMARY_LIST_KEYS = (
    "features",
    "actors",
    "useCases",
    "executionContexts",
    "businessRules",
    "validationRules",
    "apiSummary",
    "exceptions",
    "acceptanceCriteria",
    "constraints",
    "gaps",
)

LEGACY_LIST_KEYS = (
    "glossary",
    "databaseSummary",
    "openQuestions",
    "missingInformation",
)

ANALYSIS_CRITERIA_GUIDE: tuple[dict[str, str], ...] = (
    {
        "type": "SUMMARY_SCOPE",
        "json_key": "summary",
        "label": "Tóm tắt & phạm vi",
        "instruction": (
            "2–5 câu Scope Statement (BABOK): mục tiêu sản phẩm + In-scope + Out-of-scope "
            "+ actor chính — CHỈ câu/đoạn có trong SRS. "
            "CẤM: vision/marketing, «Hệ thống cho phép…» template, suy diễn phạm vi ngoài SRS."
        ),
    },
    {
        "type": "FEATURES",
        "json_key": "features",
        "label": "Chức năng",
        "instruction": (
            "Trích xuất CHỈ các Feature (Business Capability) ở cấp module/màn hình theo IEEE 29148. "
            "Feature là một khả năng nghiệp vụ hoàn chỉnh mà người dùng có thể thực hiện độc lập và thường bao gồm nhiều Functional Requirement (FR).\n\n"

            "NGUYÊN TẮC:\n"
            "- KHÔNG tạo 1 Feature cho mỗi FR.\n"
            "- Nếu nhiều FR cùng mô tả một capability thì PHẢI gộp thành 1 Feature.\n"
            "- Feature phải trả lời được câu hỏi: 'Người dùng có thể thực hiện nghiệp vụ gì?'\n"
            "- name: Động từ + Đối tượng nghiệp vụ, tối đa 8 từ. Ví dụ: 'Tạo vật chứng', 'Quản lý hồ sơ vụ án', 'Quản lý người liên quan'.\n"
            "- description: Tóm tắt capability trong 1 câu ngắn (≤50 từ), liệt kê dải FR liên quan (ví dụ: 'FR-01~FR-16'). Không mô tả từng bước chi tiết.\n\n"

            "NGUỒN HỢP LỆ:\n"
            "- Heading Feature/Chức năng/Module.\n"
            "- Nhóm Functional Requirement cùng phục vụ một capability nghiệp vụ.\n\n"

            "KHÔNG tạo Feature từ:\n"
            "- Một field hoặc nhóm field nhập liệu.\n"
            "- Upload/Download file hoặc ảnh.\n"
            "- Search/Filter/Sort.\n"
            "- Popup, Dialog, Wizard Step, Tab.\n"
            "- Button, Link, Icon.\n"
            "- Checkbox, Radio, Dropdown, Textbox.\n"
            "- Validation, Required, Format, Length.\n"
            "- Error Message, Exception.\n"
            "- API Endpoint.\n"
            "- Business Rule.\n"
            "- Use Case Step.\n"
            "- CRUD của master data chỉ phục vụ Feature khác.\n\n"

            "CHUYỂN SANG BUCKET KHÁC:\n"
            "- Validation → validationRules.\n"
            "- Business Rule → businessRules.\n"
            "- Error/Exception → exceptions.\n"
            "- Use Case/Bước xử lý → useCases.\n"
            "- API → apiSummary.\n\n"

            "QUY TẮC GỘP:\n"
            "- Tạo mới + nhập thông tin + upload + chọn dữ liệu + tìm kiếm + xác nhận + hoàn tất cùng phục vụ một nghiệp vụ => chỉ tạo MỘT Feature.\n"
            "- Chỉ tách Feature khi tài liệu mô tả một capability độc lập mà người dùng có thể sử dụng riêng.\n\n"

            "ƯU TIÊN:\n"
            "- Ít nhưng đúng hơn nhiều và lan man.\n"
            "- Không suy diễn ngoài tài liệu.\n"
            "- Nếu không xác định được capability độc lập thì trả về []."
        ),
    },
    {
        "type": "ACTORS_PERMISSIONS",
        "json_key": "actors",
        "label": "Actors & quyền",
        "instruction": (
            "Mỗi item = 1 role/actor đúng tên SRS (BABOK stakeholder/actor). "
            "permissions = danh sách thao tác cụ thể SRS gán (động từ: tạo/xem/duyệt/…) — không prose dài. "
            "CẤM bịa Admin/User/Guest; SRS im lặng về quyền → permissions rỗng; không suy diễn RBAC."
        ),
    },
    {
        "type": "BUSINESS_FLOWS",
        "json_key": "useCases",
        "label": "Luồng nghiệp vụ",
        "instruction": (
            "Mỗi UC = đúng 1 item **Main Success Scenario (Luồng chính)** — happy path nghiệp vụ.\n"
            "CẤM tạo item riêng cho: Exception / Alternate / Luồng phụ / nhánh lỗi / "
            "luồng validation / kiểm tra field / phủ định "
            "(→ exceptions hoặc validationRules — KHÔNG vào useCases).\n"
            "Bắt buộc đủ 3 field — steps từ Luồng chính (tách <br>/1.2.3.), "
            "mermaid = flowchart TD happy path từ steps (≥2 node hành động).\n"
            "1) name: tên UC đúng SRS (≤8 từ). "
            "CẤM dump bảng; CẤM Phạm vi/Mục tiêu/file›section; "
            "CẤM tên chứa Exception/Alt/Luồng phụ/Validation.\n"
            "2) mermaid: CHỈ flowchart TD (không ```): "
            "([Bắt đầu]) → [hành động]… → ([Kết thúc]); node ≤6 từ.\n"
            "3) steps: «1. …\\n2. …» (2–8 dòng) khớp Luồng chính — không paste cả bảng UC.\n"
            "Không có Luồng chính trong excerpts → useCases: []. "
            "Ít nhưng đúng — chỉ MSS chính, không pad luồng phụ."
        ),
    },
    {
        "type": "EXECUTION_CONTEXT",
        "json_key": "executionContexts",
        "label": "Execution Context",
        "instruction": (
            "Mỗi item = 1 ngữ cảnh thực thi cho scenario/flow/AC có trong SRS (nuôi E2E codegen). "
            "Bắt buộc khi SRS nêu actor/role/auth: "
            "name = ref scenario/FEATURE/UC; actor = tên role SRS; "
            "authRequired = true|false chỉ khi SRS nói rõ; "
            "roles = danh sách role tham gia (multi-role nếu ≥2); "
            "permissions = thao tác được/không được nếu SRS có; "
            "sessionHint = authenticated|public|login_tc khi SRS có tín hiệu. "
            "CẤM bịa Admin/User/Guest; SRS im lặng về auth/role → []; "
            "không quyết định cơ chế login (storageState/API) — chỉ WHO/nghiệp vụ."
        ),
    },
    {
        "type": "BUSINESS_RULES",
        "json_key": "businessRules",
        "label": "Business rules",
        "instruction": (
            "Mỗi item = 1 policy atomic (BABOK BR): id = BR-n nếu SRS có (không thì BR-1..); "
            "text ≈ nguyên văn must/shall/phải/chỉ được/cấm — có chủ thể + điều kiện/hành vi. "
            "CẤM paraphrase «đảm bảo đúng đắn/toàn vẹn»; "
            "ràng buộc field/format/range → validationRules; thông báo lỗi → exceptions."
        ),
    },
    {
        "type": "VALIDATION_DATA",
        "json_key": "validationRules",
        "label": "Validation & dữ liệu",
        "instruction": (
            "Mỗi item = 1 cặp atomic field+rule từ SRS (data dictionary / bảng trường):\n"
            "- field: tên trường đúng SRS (EN hoặc VI, ≤6 từ) — CẤM trống; "
            "giữ đủ tên («Họ tên», «Mật khẩu», email, title) — cấm cắt còn 1 âm tiết.\n"
            "- rule: ràng buộc đo được, ngắn (≤12 từ): required|bắt buộc|type|max/min|"
            "độ dài|format|unique|pattern|enum|Có/Không (map Có→required). "
            "Có số/ngưỡng nếu SRS có. "
            "CẤM lặp tên field trong rule; cấm «dữ liệu hợp lệ / nhập đúng»; "
            "cấm policy (→ businessRules); cấm message lỗi thuần (→ exceptions).\n"
            "- module (khuyến nghị): tên màn/chức năng/FEATURE chứa field "
            "(VD «Đăng nhập», «Thêm todo») — để gom nhóm UI; "
            "SRS không gắn màn → module=\"Chung\".\n"
            "Xuất field có ràng buộc đo được trong SRS (không pad / không tạo useCase từ validation). "
            "Thiếu tên field → không tạo item. "
            "CẤM nhân bản thành «luồng kiểm tra / validation flow» trong useCases."
        ),
    },
    {
        "type": "API_UI",
        "json_key": "apiSummary",
        "label": "API / giao diện",
        "instruction": (
            "Mỗi item = 1 interface tường minh trong SRS: method+path (API) HOẶC tên màn/route/entry UI; "
            "note ≤1 câu mục đích nếu SRS có. "
            "CẤM đoán /api/... từ tên feature; cấm gộp nhiều endpoint vào 1 item; "
            "không có method+path/UI entry tường minh → []."
        ),
    },
    {
        "type": "ERROR_HANDLING",
        "json_key": "exceptions",
        "label": "Xử lý lỗi",
        "instruction": (
            "Mỗi item = 1 exception CÓ trong SRS: điều kiện kích hoạt + phản hồi quan sát được "
            "(status|message|hành vi UI/API). "
            "CẤM thêm 401/403/404/500 «cho đủ»; cấm «xử lý lỗi phù hợp». "
            "SRS có heading Exception Flow/Luồng ngoại lệ nhưng KHÔNG mô tả điều kiện/phản hồi "
            "→ exceptions=[] và (tuỳ chọn) 1 gap ngắn: «SRS chưa mô tả điều kiện/phản hồi lỗi». "
            "CẤM tạo item exceptions chỉ bằng cách nhắc lại câu tiêu chí này."
        ),
    },
    {
        "type": "ACCEPTANCE",
        "json_key": "acceptanceCriteria",
        "label": "Acceptance",
        "instruction": (
            "CHỈ khi SRS có Given-When-Then / Done-when / AC-n / tiêu chí chấp nhận có điều kiện+kết quả. "
            "Mỗi item = 1 outcome kiểm chứng được; text ≈ nguyên văn. "
            "Không có AC → []. CẤM heading «Acceptance Criteria» trống; "
            "cấm «user sử dụng thành công / hệ thống hoạt động đúng»."
        ),
    },
    {
        "type": "NFR_CONSTRAINTS",
        "json_key": "constraints",
        "label": "Ràng buộc NFR",
        "instruction": (
            "Mỗi item = 1 NFR SMART trong SRS: có ngưỡng/điều kiện đo được "
            "(SLA|latency|TTL|throughput|audit|retention|browser/OS…). "
            "CẤM «bảo mật tốt / hiệu năng cao / dễ dùng»; SRS không nêu số liệu/điều kiện → []."
        ),
    },
    {
        "type": "GAPS",
        "json_key": "gaps",
        "label": "Thiếu sót",
        "instruction": (
            "Mỗi item = 1 thiếu sót chặn Sinh TC: TBD/TODO/«chưa rõ <X>» trong SRS, "
            "hoặc «thiếu <tiêu chí/json_key> vì tài liệu không nêu». "
            "CẤM brainstorm câu hỏi mở, wishlist, hoặc hỏi khám phá domain."
        ),
    },
)

# Rule CHUNG — áp dụng MỌI tiêu chí Phân tích (trước instruction riêng từng key).
ANALYSIS_FIDELITY_RULES = """\
QUY TẮC CHUNG PHÂN TÍCH TÀI LIỆU (BẮT BUỘC — áp dụng cho MỌI tiêu chí):
Chuẩn tham chiếu: BABOK (scope/actors/BR/AC) + IEEE 29148 (FR/NFR kiểm thử được). Không lan man.
A. NGUỒN SỰ THẬT: CHỈ Document excerpts từ file SRS đã upload.
   Không domain mẫu, không kiến thức ngoài tài liệu, không bịa từ tên file.
B. QUY TRÌNH EXTRACT (mỗi tiêu chí đều làm theo):
   (1) Quét excerpts tìm câu/đoạn thuộc tiêu chí đó.
   (2) Tách thành item độc lập — một ý = một item (atomic).
   (3) Ghi nội dung GẦN NGUYÊN VĂN (giữ tên riêng, số, điều kiện, message, path).
   (4) Self-check: item có truy vết được về 1 câu trong excerpts không? Không → xóa hoặc chuyển gaps.
C. CẤM OUTPUT CHUNG CHUNG / MƠ HỒ (reject nếu viết kiểu này):
   - «Hệ thống cho phép người dùng thực hiện các chức năng…»
   - «Cần kiểm tra đầy đủ / đảm bảo tính đúng đắn / xử lý phù hợp»
   - «Dữ liệu phải hợp lệ» / «Người dùng sử dụng thành công»
   - Paraphrase làm mất tên field, số, điều kiện, status code trong SRS.
D. MỖI ITEM PHẢI KIỂM CHỨNG ĐƯỢC (testable): chủ thể + điều kiện/hành động + kết quả (nếu SRS có).
   Không verify được bằng TC → bỏ hoặc gaps. Thiếu chi tiết SRS → giữ đúng mức SRS; không pad.
E. ĐÚNG KEY: không nhét Validation vào businessRules, không nhét Exception vào Acceptance, v.v.
   Một đoạn SRS lẫn nhiều loại → tách nhiều item, map đúng json_key.
F. THIẾU DỮ LIỆU: tiêu chí không có tín hiệu → [] (list rỗng). Chỉ gaps khi TBD/TODO/thiếu thật sự cản TC.
G. NGÔN NGỮ = ngôn ngữ tài liệu. Không dịch làm lệch nghĩa. Không markdown ngoài JSON.
H. Mục tiêu: Knowledge nuôi Sinh TC — chính xác > số lượng; cấm pad cho «đủ bộ».
I. CẤM PLACEHOLDER / MỤC LỤC / MARKDOWN DUMP: Không tạo item từ:
   - Tên section (Mục tiêu, Phạm vi, Tác nhân, Endpoints, Todo Model, API định nghĩa…)
     kể cả «Mục tiêu (2)» / «1. Mục tiêu»
   - Tiêu đề tài liệu / heading markdown (# ## Software Requirements Specification / SRS)
   - Dump nguyên đoạn markdown SRS vào name hoặc description
J. PHÂN TẦNG (đúng bucket — không nhân bản):
   features = capability nghiệp vụ (gộp FR cùng mục đích);
   useCases = **chỉ Luồng chính / MSS** (mermaid + steps) — CẤM Exception/Alt/Luồng phụ/validation flow;
   validationRules = field+rule (KHÔNG là flow); exceptions = lỗi; businessRules = policy;
   apiSummary = method+path|entry; executionContexts = WHO; acceptanceCriteria = AC đo được;
   constraints = NFR SMART.
K. CHI TIẾT: feature cần ≥1 tín hiệu kiểm thử (FR-id/path/field). Mục lục / mô tả trống → bỏ.
   Chính xác > số lượng — pad luồng phụ/validation = SAI.
"""


def empty_payload() -> dict[str, Any]:
    return {
        "summary": "",
        "features": [],
        "actors": [],
        "useCases": [],
        "executionContexts": [],
        "businessRules": [],
        "validationRules": [],
        "apiSummary": [],
        "exceptions": [],
        "acceptanceCriteria": [],
        "constraints": [],
        "gaps": [],
        "glossary": [],
        "databaseSummary": [],
        "openQuestions": [],
        "missingInformation": [],
    }


def _dedupe_list(items: list[dict], key: str) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for it in items:
        k = str(it.get(key) or "").strip().lower()
        if not k or k in seen:
            continue
        seen.add(k)
        out.append(it)
        if len(out) >= MAX_ITEMS:
            break
    return out


def _dedupe_apis(items: list[dict]) -> list[dict]:
    """Dedupe API rows by method+path (same path may host GET and POST)."""
    seen: set[str] = set()
    out: list[dict] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        method = str(it.get("method") or "").strip().upper()
        path = str(it.get("path") or "").strip()
        if not path:
            continue
        k = f"{method}|{path}".lower()
        if k in seen:
            continue
        seen.add(k)
        row = dict(it)
        row["method"] = method or str(it.get("method") or "")
        row["path"] = path
        out.append(row)
        if len(out) >= MAX_ITEMS:
            break
    return out


def _api_key(row: dict) -> str:
    return f"{str(row.get('method') or '').strip().upper()}|{str(row.get('path') or '').strip()}".lower()


def _as_list(value: Any) -> list:
    return value if isinstance(value, list) else []


def _split_fragments(text: str) -> list[str]:
    if not text:
        return []
    chunks = re.split(r"(?:\n+|[;•\-]\s+)", text)
    out: list[str] = []
    for c in chunks:
        s = (c or "").strip()
        if len(s) < 8:
            continue
        out.append(s[:500])
    return out


def _text_item(row: Any) -> str:
    if isinstance(row, dict):
        for k in ("text", "name", "title", "criterion", "rule", "message"):
            v = row.get(k)
            if v is not None and str(v).strip():
                return str(v).strip()
        return " ".join(str(v).strip() for v in row.values() if v).strip()
    return str(row).strip() if row is not None else ""


def _payload_fragments(payload: dict[str, Any]) -> list[str]:
    out: list[str] = []
    if payload.get("summary"):
        out.extend(_split_fragments(str(payload["summary"])))
    for key in (
        "features",
        "actors",
        "useCases",
        "executionContexts",
        "businessRules",
        "validationRules",
        "apiSummary",
        "exceptions",
        "acceptanceCriteria",
        "constraints",
        "gaps",
        "openQuestions",
        "missingInformation",
    ):
        for row in _as_list(payload.get(key)):
            t = _text_item(row)
            out.extend(_split_fragments(t))
    return out


def _append_unique(items: list[dict], key: str, value: dict, *, limit: int = MAX_ITEMS) -> None:
    target = str(value.get(key) or "").strip().lower()
    if not target:
        return
    for it in items:
        if str(it.get(key) or "").strip().lower() == target:
            return
    if len(items) < limit:
        items.append(value)


def _parse_numbered_use_case_title(text: str) -> str | None:
    """Return UC title when line is numbered use case (01 Xem…, UC-01: …), else None."""
    s = _strip_source_file_prefix(text or "").strip()
    if not s or len(s) < 5:
        return None
    m = _NUMBERED_UC_TITLE.match(s)
    if not m:
        return None
    title = (m.group(1) or "").strip()
    if not title or len(title) < 3:
        return None
    if not re.search(r"[A-Za-zÀ-ỹ]", title):
        return None
    if _is_criterion_section_label(title):
        return None
    return title[:200]



def _strip_source_file_prefix(text: str) -> str:
    """Strip document-index prefix «file.md › Heading» → «Heading»."""
    s = (text or "").strip()
    if " › " in s:
        s = s.split(" › ", 1)[-1].strip()
    elif " > " in s and re.search(r"(?i)\.\w{1,5}\s*>\s*", s):
        s = s.split(" > ", 1)[-1].strip()
    return s


def _strip_section_number_prefix(text: str) -> str:
    """Remove TOC numbering: «1. », «1.1. », «II. », «A) » before matching section labels."""
    s = (text or "").strip()
    s = re.sub(r"^\d+(?:\.\d+)*\.?\s+", "", s)
    s = re.sub(
        r"^(?:[IVXLC]{1,6}|[A-Za-z])[\s.\-–:)+]+\s*",
        "",
        s,
        flags=re.IGNORECASE,
    )
    return s.strip(" .-–—:")


def _normalize_feature_label(text: str) -> str:
    """
    Normalize a candidate feature/section name for junk detection:
    strip file› prefix, markdown #, TOC numbers, trailing «(2)» / «(Functional Requirements)».
    """
    s = _strip_source_file_prefix(text or "")
    if "#" in s:
        first = re.split(r"\s*#{1,6}\s*", s, maxsplit=1)[0].strip()
        if first:
            s = first
        s = re.sub(r"^#+\s*", "", s)
    s = _strip_section_number_prefix(s)
    s = re.sub(r"\s*\([^)]{0,80}\)\s*$", "", s)
    return s.strip(" .-–—:")


def _is_capability_heading(text: str) -> bool:
    """True when heading looks like FR / UC / Feature capability (not TOC/scope)."""
    raw = _strip_source_file_prefix(text or "")
    if not raw or _is_criterion_section_label(raw):
        return False
    if _parse_fr_title(raw) or _parse_numbered_use_case_title(raw):
        return True
    if _USECASE_HEAD.search(raw) or _FEATURE_HEAD.match(raw) or _FEATURE_HEAD_SIMPLE.search(raw):
        return not _is_criterion_section_label(raw)
    # Bare capability verb+object (Tạo todo, Xem danh sách) — not outline prose
    if _FEATURE_ACTION_HINT.search(raw) and len(raw.split()) <= 8 and len(raw) <= 80:
        return True
    return False


def _is_numbered_use_case_title(text: str) -> bool:
    return _parse_numbered_use_case_title(text) is not None


def _is_criterion_section_label(text: str) -> bool:
    s = _normalize_feature_label(text or "")
    return bool(s) and bool(
        _CRITERION_SECTION_LABEL.match(s) or _DOC_META_SECTION_LABEL.match(s)
    )


def _is_markdown_or_srs_dump(text: str) -> bool:
    """Reject names/descriptions that are document title or markdown heading dumps."""
    s = (text or "").strip()
    if not s:
        return False
    if s.count("#") >= 1 and (
        "requirement" in s.lower()
        or "srs" in s.lower()
        or "mục tiêu" in s.lower()
        or s.count("#") >= 2
        or len(s) > 80
    ):
        return True
    if s.lstrip().startswith("|") and s.count("|") >= 3:
        return True
    return bool(_MARKDOWN_OR_SRS_DUMP.search(s))


def _parse_fr_title(text: str) -> str | None:
    """Return FR capability title from «FR-01: Xem danh sách todo», else None."""
    s = _strip_source_file_prefix(text or "").strip()
    if not s:
        return None
    m = _FR_HEAD.match(s)
    if not m:
        return None
    title = (m.group(2) or "").strip()
    if not title or len(title) < 3:
        return None
    if _is_criterion_section_label(title):
        return None
    return _shorten_fr_capability(title)[:200]



def _shorten_fr_capability(text: str) -> str:
    """Turn «Hệ thống phải cho phép người dùng xem…» into a short capability name."""
    s = (text or "").strip()
    s = re.sub(
        r"(?i)^hệ\s*thống\s+phải\s+(?:cho\s+phép\s+(?:người\s*dùng\s+)?)?",
        "",
        s,
    ).strip()
    s = re.sub(r"(?i)^(?:the\s+system\s+shall\s+(?:allow\s+(?:the\s+user\s+to\s+)?)?)", "", s).strip()
    return (s or text or "").strip()


def _normalize_html_breaks(text: str) -> str:
    s = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    s = re.sub(r"(?i)<br\s*/?>", "\n", s)
    return s


# FR that are quality/validation/error — NOT user-facing FEATURES (Chức năng).
_SUPPORT_FR_HINT = re.compile(
    r"(?i)\b("
    r"kiểm\s*tra\s*tính\s*hợp\s*lệ|validate|validation|"
    r"từ\s*chối\s*(?:các\s*)?trường|unknown\s*fields?|"
    r"trả\s*mã\s*lỗi|mã\s*lỗi\s*phù\s*hợp|"
    r"hiển\s*thị\s*thông\s*báo\s*lỗi|"
    r"frontend\s+trước\s+khi|backend\s+trước\s+khi"
    r")\b"
)


def _is_support_fr_not_feature(name: str, desc: str = "") -> bool:
    """True for validation/error/platform FRs — route out of features."""
    blob = f"{name or ''} {desc or ''}"
    return bool(_SUPPORT_FR_HINT.search(blob))


def _route_support_fr(
    *,
    code: str,
    raw_req: str,
    rules: list[dict],
    validations: list[dict],
    exceptions: list[dict],
) -> None:
    """Place support FR into BR / validation / exceptions instead of features."""
    text = f"{code}: {raw_req}".strip()[:500]
    low = raw_req.lower()
    if re.search(r"(?i)mã\s*lỗi|thông\s*báo\s*lỗi|404|400|error|lỗi", low):
        exceptions.append({"text": text})
        return
    if re.search(r"(?i)hợp\s*lệ|validat|trường|field|frontend|backend", low):
        validations.append(
            {
                "field": "dữ liệu đầu vào",
                "rule": _shorten_fr_capability(raw_req)[:200] or raw_req[:200],
                "module": "Chung",
            }
        )
        rules.append({"id": code.replace("FR", "BR") if code.startswith("FR") else code, "text": text})
        return
    rules.append({"id": code, "text": text})


_MAIN_FLOW_LABEL = re.compile(
    r"(?i)^\s*luồng\s+chính|main\s+(?:success\s+)?(?:flow|scenario)|basic\s+flow\s*$"
)


def _extract_main_flow_steps(body: str) -> str:
    """Pull «Luồng chính» cell from UC detail table; split <br> into numbered steps."""
    # Do NOT convert <br> on the whole body first — that breaks single-line table rows.
    raw = (body or "").replace("\r\n", "\n").replace("\r", "\n")
    if not raw.strip():
        return ""
    # Robust: cell may contain <br> on one physical line
    m_cell = re.search(
        r"(?is)\|\s*(?:Luồng\s+chính|Main\s+(?:Success\s+)?(?:Flow|Scenario)|Basic\s+Flow)\s*\|\s*([^|]+)\|",
        raw,
    )
    if m_cell:
        got = _format_flow_steps(_normalize_html_breaks(m_cell.group(1)))
        if got:
            return got
    for line in raw.splitlines():
        row = line.strip()
        if not _is_markdown_table_row(row):
            continue
        cells = [c.strip() for c in row.strip("|").split("|")]
        if len(cells) < 2:
            continue
        label, value = cells[0], cells[1] if len(cells) == 2 else " | ".join(cells[1:])
        if _MAIN_FLOW_LABEL.match(label) or re.search(r"(?i)luồng\s+chính", label):
            got = _format_flow_steps(_normalize_html_breaks(value))
            if got:
                return got
    # Fallback: numbered steps in body (skip pure table-chrome lines inside formatter)
    return _format_flow_steps(_normalize_html_breaks(raw))


def _coerce_uc_steps(steps: str) -> str:
    """Keep clean numbered steps; extract Luồng chính from table dumps."""
    s = (steps or "").strip()
    if not s:
        return ""
    # Already a clean numbered list — don't re-parse as table
    if s.count("|") < 2 and re.search(r"(?m)^\s*\d+[.)]\s+\S", s):
        return _format_flow_steps(s) or s
    return _extract_main_flow_steps(s) or _format_flow_steps(s) or ""


def _format_flow_steps(text: str) -> str:
    """Normalize free-text / br-joined steps into «1. …\\n2. …»; drop table chrome."""
    s = _normalize_html_breaks(text or "").strip()
    if not s:
        return ""
    # If still one line with «1. … 2. …» without newlines, split on step numbers
    if "\n" not in s and re.search(r"\d+[.)]\s+\S", s):
        parts = re.split(r"(?=\d+[.)]\s+)", s)
        s = "\n".join(p.strip() for p in parts if p.strip())
    labels: list[str] = []
    for ln in s.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        # Drop markdown table chrome
        if _is_markdown_table_row(ln) or re.match(r"^\|?[\s:-]+\|", ln):
            continue
        if re.match(r"(?i)^\|\s*(mục|nội\s*dung|mô\s*tả|actor|tiền\s*điều|hậu\s*điều)", ln):
            continue
        if re.match(r"(?i)^(mục|nội\s*dung)\s*$", ln):
            continue
        m = re.match(r"^\s*\d+[.)]\s*(.+)$", ln)
        if m:
            step = m.group(1).strip()
        else:
            # Strip leading «Luồng chính |» residue
            step = re.sub(r"(?i)^luồng\s+chính\s*\|?\s*", "", ln).strip()
            if _is_markdown_table_row(step) or len(step) < 3:
                continue
            if re.match(r"(?i)^(mô\s*tả|actor|tiền\s*điều|hậu\s*điều|tiêu\s*chí)", step):
                continue
        if not step:
            continue
        if len(step) > 200:
            step = step[:200]
        # Skip if looks like leftover table header cell
        if re.match(r"(?i)^\|\s*", step) or step in ("---|---", "---"):
            continue
        labels.append(step)
    # Need real actions — not a single UC title echo
    labels = [x for x in labels if not re.match(r"(?i)^UC[\s\-_]*\d+", x)]
    if not labels:
        return ""
    # Single concrete action — still keep (mermaid synthesizer may pad / skip diagram)
    if len(labels) == 1:
        return f"1. {labels[0]}"
    return "\n".join(f"{i}. {lab}" for i, lab in enumerate(labels[:8], 1))


def _is_markdown_table_row(text: str) -> bool:
    s = (text or "").strip()
    return s.startswith("|") and s.count("|") >= 2


def _is_ui_widget_not_feature(name: str, desc: str = "") -> bool:
    """True when name is a UI control or bare field label — not an FR capability."""
    raw = (name or "").strip()
    if not raw:
        return False
    core = _normalize_feature_label(raw)
    if not core:
        return False
    combined = f"{raw} {desc}".strip()
    if _parse_fr_title(raw) or _parse_fr_title(desc):
        return False
    if _UI_CONTROL_PREFIX.match(raw) or _UI_CONTROL_PREFIX.match(core):
        return True
    if _FIELD_LABEL_ONLY.match(core) or _FIELD_LABEL_ONLY.match(raw):
        if not _FEATURE_ACTION_HINT.search(combined):
            return True
    if re.match(r"(?i)^(click|nhấn|bấm|tap)\s+", core) and len(core.split()) <= 5:
        if not re.search(
            r"(?i)\b(danh\s*sách|form|trang|page|module|công\s*việc|todo|order|user|admin)\b",
            combined,
        ):
            return True
    # Bare micro-label: ≤2 words, no capability verb, no concrete trace in desc
    words = [w for w in core.split() if w]
    if len(words) <= 2 and len(core) <= 28:
        if not _FEATURE_ACTION_HINT.search(core):
            if not _has_concrete_detail(desc) and not _parse_fr_title(desc):
                return True
    return False


def _is_junk_feature(name: str, desc: str = "") -> bool:
    """True when item is TOC/heading/model/markdown — not an SRS capability."""
    raw = (name or "").strip()
    if not raw:
        return True
    core = _normalize_feature_label(raw)
    if not core:
        return True
    if _is_criterion_section_label(raw) or _is_criterion_section_label(core):
        return True
    if _is_markdown_or_srs_dump(raw) or _is_markdown_or_srs_dump(core):
        return True
    # Short blurb dumps only — long UC step tables are OK when name is clean.
    if desc and len(desc.strip()) <= 160 and _is_markdown_or_srs_dump(desc):
        return True
    if len(core) > 100 or len(raw) > 120:
        return True
    if re.match(r"(?i)^UC[\s\-_]*\d+$", core):
        return True
    # Outline-only: numbered TOC without capability verb / FR / UC
    if re.match(r"^\d+(?:\.\d+)+", _strip_source_file_prefix(raw)) and not (
        _FEATURE_ACTION_HINT.search(core)
        or _parse_fr_title(raw)
        or _parse_numbered_use_case_title(raw)
    ):
        return True
    return False


def _is_junk_use_case_name(name: str) -> bool:
    """Reject TOC / scope / empty Exception headings as BUSINESS_FLOWS names."""
    raw = (name or "").strip()
    if not raw:
        return True
    if _is_junk_feature(raw, ""):
        return True
    core = _normalize_feature_label(raw)
    if re.search(
        r"(?i)^(phạm\s*vi|mục\s*tiêu|giới\s*thiệu|tổng\s*quan|introduction|"
        r"overall\s+description|out\s*of\s*scope)\b",
        core,
    ):
        return True
    return False


def _has_concrete_detail(text: str) -> bool:
    return bool(_CONCRETE_DETAIL.search(text or ""))


def _feature_desc_is_substantive(desc: str) -> bool:
    """Portable: keep VN capability when SRS body has measurable detail (no action verb required)."""
    s = (desc or "").strip()
    if len(s) < 40:
        return False
    if _has_concrete_detail(s):
        return True
    if _MEASURABLE_VALIDATION.search(s):
        return True
    return bool(re.search(r"\d", s))


def _is_valid_acceptance_text(text: str) -> bool:
    s = (text or "").strip()
    if not s or len(s) < 12 or _is_criterion_section_label(s) or _is_markdown_or_srs_dump(s):
        return False
    if re.search(r"(?i)\bAC[-\s]?\d+\b", s):
        return True
    return bool(_ACCEPTANCE_HINT.search(s))


_VAGUE_VALIDATION_RULE = re.compile(
    r"(?i)^(?:"
    r"dữ\s*liệu\s*(?:phải\s*)?(?:hợp\s*lệ|đúng)|"
    r"nhập\s*đúng|"
    r"validate(?:\s*đúng)?|"
    r"đúng\s*định\s*dạng|"
    r"hợp\s*lệ|"
    r"kiểm\s*tra\s*dữ\s*liệu|"
    r"validation(?:\s*rule)?s?|"
    r"required\s*fields?|"
    r"entity/table\s+\w+"
    r")\.?\s*$"
)
_MEASURABLE_VALIDATION = re.compile(
    r"(?i)\b("
    r"required|bắt\s*buộc|optional|không\s*bắt\s*buộc|"
    r"unique|duy\s*nhất|"
    r"max(?:imum)?|min(?:imum)?|độ\s*dài|length|maxlen|minlen|"
    r"tối\s*đa|tối\s*thiểu|ký\s*tự|"
    r"format|pattern|regex|email|phone|url|uuid|"
    r"string|number|int(?:eger)?|boolean|bool|date|datetime|"
    r"range|từ\s+\d+|đến\s+\d+|between|"
    r"enum|one\s*of|chỉ\s*nhận|"
    r"\d+\s*(?:ký\s*tự|chars?|characters?|digits?)|"
    r"nullable|not\s*null|"
    r"có|không"
    r")\b"
)


def _compact_validation_field(field: str) -> str:
    """Keep EN identifiers and VI multi-word labels (Họ tên, Mật khẩu…)."""
    s = re.sub(r"\s+", " ", (field or "").strip())
    s = s.strip(" :.-–—|")
    if not s:
        return ""
    if _is_criterion_section_label(s) or _is_markdown_or_srs_dump(s):
        return ""
    if re.match(r"(?i)^(field|trường|column|cột)$", s):
        return ""
    words = s.split()
    # Sentence-like dump → keep first 1–3 tokens; else keep full short label
    if len(words) > 6 or len(s) > 64:
        ident = re.match(r"^([A-Za-z_][\w.\-/]{1,47})", s)
        if ident and " " not in s[: len(ident.group(1)) + 1]:
            s = ident.group(1)
        else:
            s = " ".join(words[:3])
    return s[:80]


def _map_validation_cell(cell: str) -> str | None:
    """Normalize a table cell; None = drop (header noise)."""
    p = (cell or "").strip()
    if not p:
        return None
    if re.match(r"(?i)^(trường|field|kiểu|type|column|cột)$", p):
        return None
    if re.match(r"(?i)^(có|yes|y|true)$", p):
        return "required"
    if re.match(r"(?i)^(không|no|n|false)$", p):
        return "optional"
    return p


def _compact_validation_rule(rule: str, *, field: str = "") -> str:
    s = re.sub(r"\s+", " ", (rule or "").strip())
    s = s.strip(" :.-–—|")
    if not s:
        return ""
    if field:
        fl = re.escape(field.strip())
        s = re.sub(rf"(?i)^{fl}\s*[—\-–:|,]+\s*", "", s).strip()
        s = re.sub(rf"(?i)^{fl}\s+", "", s).strip()
    if " — " in s or " | " in s:
        parts = re.split(r"\s*[—|]\s*", s)
        mapped: list[str] = []
        for p in parts:
            if field and p.strip().lower() == field.lower():
                continue
            cell = _map_validation_cell(p)
            if cell:
                mapped.append(cell)
        s = ", ".join(mapped)
    else:
        cell = _map_validation_cell(s)
        s = cell or s
    s = re.sub(r"\s+", " ", s).strip(" ,;:")
    if len(s) > 120:
        s = s[:117].rstrip(" ,;:.-") + "…"
    return s


def _compact_validation_module(module: str) -> str:
    s = re.sub(r"\s+", " ", (module or "").strip())
    s = s.strip(" :.-–—|")
    if not s or _is_criterion_section_label(s):
        return "Chung"
    if len(s) > 60:
        s = s[:57].rstrip() + "…"
    return s


def _is_vague_validation(field: str, rule: str) -> bool:
    if not field or not rule:
        return True
    if _VAGUE_VALIDATION_RULE.match(rule):
        return True
    if _is_criterion_section_label(rule) or _is_markdown_or_srs_dump(rule):
        return True
    if _is_markdown_table_row(rule):
        return True
    if field.lower() == rule.lower():
        return True
    if len(rule) <= 28 and re.match(
        r"(?i)^(required|optional|unique|email|string|number|int|boolean|bool|date|"
        r"bắt\s*buộc|không\s*bắt\s*buộc)$",
        rule,
    ):
        return False
    if _MEASURABLE_VALIDATION.search(rule) or re.search(r"\d", rule):
        return False
    # Keep short non-vague VI constraint phrases (e.g. "không được trống")
    if len(rule) <= 40 and re.search(
        r"(?i)trống|định\s*dạng|độ\s*dài|bắt\s*buộc|tối\s*đa|tối\s*thiểu",
        rule,
    ):
        return False
    return True


def _normalize_validation_items(rows: list) -> list[dict]:
    """Keep atomic field+rule(+module); drop vague / duplicate clutter — không bỏ sót field thật."""
    out: list[dict] = []
    seen: set[str] = set()
    for r in rows:
        if not isinstance(r, dict):
            continue
        field = _compact_validation_field(str(r.get("field") or ""))
        raw_rule = str(r.get("rule") or "").strip()
        rule = _compact_validation_rule(raw_rule, field=field)
        module = _compact_validation_module(
            str(r.get("module") or r.get("feature") or r.get("screen") or "")
        )
        # Recover "Field: rule" / "Field — rule" when field empty (EN + VI)
        if not field and raw_rule:
            m = re.match(
                r"^(.{1,40}?)\s*[—\-–:]\s*(.+)$",
                raw_rule,
            )
            if m:
                field = _compact_validation_field(m.group(1))
                rule = _compact_validation_rule(m.group(2), field=field)
        if _is_vague_validation(field, rule):
            continue
        key = f"{module.lower()}|{field.lower()}|{rule.lower()}"
        if key in seen:
            continue
        seen.add(key)
        item = {"field": field, "rule": rule, "module": module}
        out.append(item)
        if len(out) >= MAX_ITEMS:
            break
    return out


def _promote_apis_from_text(apis: list[dict], text: str, *, note: str = "") -> None:
    for m in _API_RE.finditer(text or ""):
        row = {
            "method": m.group(1).upper(),
            "path": m.group(2),
            "note": (note or text)[:200],
        }
        key = _api_key(row)
        if any(_api_key(a) == key for a in apis):
            continue
        if len(apis) < MAX_ITEMS:
            apis.append(row)


def _sanitize_knowledge_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Drop section placeholders, SRS dumps, invalid AC, and vague items."""
    features_in = _as_list(payload.get("features"))
    apis = list(_as_list(payload.get("apiSummary")))
    kept_features: list[dict] = []

    for row in features_in:
        if not isinstance(row, dict):
            continue
        name = _strip_source_file_prefix(str(row.get("name") or "").strip())
        desc = str(row.get("description") or "").strip()
        if not name:
            continue
        fr_title = _parse_fr_title(name)
        if fr_title:
            name = fr_title
        if _is_ui_widget_not_feature(name, desc):
            low_field = _normalize_feature_label(name).lower()
            if _FIELD_LABEL_ONLY.match(low_field) or _FIELD_LABEL_ONLY.match(name):
                validations_extra = _as_list(payload.get("validationRules"))
                validations_extra.append(
                    {
                        "field": name[:80],
                        "rule": (desc or "SRS field")[:200],
                        "module": "Chung",
                    }
                )
                payload["validationRules"] = validations_extra
            continue
        if _is_junk_feature(name, desc):
            continue
        # Support FR (validation/error) → not Chức năng
        if _is_support_fr_not_feature(name, desc):
            low = f"{name} {desc}".lower()
            if re.search(r"(?i)mã\s*lỗi|thông\s*báo\s*lỗi|404|400|error", low):
                exceptions_extra = _as_list(payload.get("exceptions"))
                exceptions_extra.append({"text": (desc or name)[:500]})
                payload["exceptions"] = exceptions_extra
            else:
                validations_extra = _as_list(payload.get("validationRules"))
                validations_extra.append(
                    {
                        "field": "dữ liệu đầu vào",
                        "rule": name[:200],
                        "module": "Chung",
                    }
                )
                payload["validationRules"] = validations_extra
            continue
        combined = f"{name} {desc}".strip()
        if _is_numbered_use_case_title(name) and not fr_title:
            continue
        if desc:
            _promote_apis_from_text(apis, desc, note=desc[:200])
        # Empty-desc: keep only capability verbs. With desc: keep if concrete OR action name.
        if not desc:
            if not _FEATURE_ACTION_HINT.search(name):
                continue
        elif not (
            _has_concrete_detail(combined)
            or _FEATURE_ACTION_HINT.search(name)
            or _feature_desc_is_substantive(desc)
        ):
            continue
        # Compact description: keep FR-id + short clause, not essay
        if desc and len(desc) > 180:
            desc = desc[:177].rstrip() + "…"
        kept_features.append({"name": name[:200], "description": desc[:400]})

    payload["features"] = _dedupe_list(kept_features, "name")
    payload["apiSummary"] = _dedupe_apis(apis)

    use_cases_in = _as_list(payload.get("useCases"))
    from app.features.requirement_studio.flow_mermaid import (
        enrich_use_case_flow_fields,
        is_hollow_use_case,
        is_non_main_business_flow,
        _META_ANALYSIS_ECHO,
    )

    enriched_ucs: list[dict] = []
    hollow_gap_texts: list[str] = []
    rerouted_non_mss = 0
    validations_reroute: list[dict] = list(_as_list(payload.get("validationRules")))
    exceptions_reroute: list[dict] = list(_as_list(payload.get("exceptions")))

    def _reroute_dropped_use_case(uc_name: str, uc_steps: str) -> None:
        nonlocal rerouted_non_mss
        if not uc_name and not uc_steps:
            return
        rerouted_non_mss += 1
        blob = uc_steps or uc_name
        if _EXCEPTION_HINT.search(blob):
            exceptions_reroute.append({"text": f"{uc_name}: {blob[:400]}"})
        elif _VALIDATION_HINT.search(blob) or _MEASURABLE_VALIDATION.search(blob):
            validations_reroute.append(
                {
                    "field": uc_name[:80] or "dữ liệu",
                    "rule": blob[:300],
                    "module": "Chung",
                }
            )
        elif _RULE_HINT.search(blob):
            business_extra = _as_list(payload.get("businessRules"))
            business_extra.append(
                {"id": f"BR-{len(business_extra) + 1}", "text": f"{uc_name}: {blob[:400]}"}
            )
            payload["businessRules"] = business_extra

    for uc in use_cases_in:
        if not isinstance(uc, dict):
            continue
        name_raw = _strip_source_file_prefix(str(uc.get("name") or "").strip())
        name = _parse_numbered_use_case_title(name_raw) or name_raw
        steps_orig = str(uc.get("steps") or "").strip()
        mermaid_raw = str(uc.get("mermaid") or "").strip()
        steps_raw = _coerce_uc_steps(steps_orig)
        if (
            not name
            or _is_junk_use_case_name(name)
            or _is_criterion_section_label(name)
        ):
            continue
        if not steps_raw and not mermaid_raw:
            continue
        if is_hollow_use_case(name, steps_raw, mermaid_raw):
            # Promote analysis-meta about empty Exception Flow → short gap (once)
            blob = f"{name}\n{steps_raw}"
            if _META_ANALYSIS_ECHO.search(blob) or re.search(
                r"(?i)exception\s+flow|luồng\s+ngoại\s+lệ", name
            ):
                hollow_gap_texts.append(
                    "SRS khai báo Exception Flow / Luồng ngoại lệ nhưng chưa mô tả "
                    "điều kiện kích hoạt và phản hồi lỗi quan sát được."
                )
            elif is_non_main_business_flow(name, steps_raw):
                _reroute_dropped_use_case(name, steps_raw)
            continue
        # Must pass cleaned steps — original uc may still hold markdown table dump
        row = enrich_use_case_flow_fields(
            {
                **uc,
                "name": name[:200],
                "steps": steps_raw or steps_orig,
                "mermaid": mermaid_raw,
            }
        )
        if not row.get("name"):
            continue
        if not (row.get("steps") or row.get("mermaid")):
            continue
        if is_hollow_use_case(row.get("name"), row.get("steps"), row.get("mermaid")):
            if is_non_main_business_flow(
                str(row.get("name") or ""), str(row.get("steps") or "")
            ):
                _reroute_dropped_use_case(
                    str(row.get("name") or ""), str(row.get("steps") or "")
                )
            continue
        enriched_ucs.append(row)
    payload["useCases"] = _dedupe_list(enriched_ucs, "name")
    if validations_reroute:
        payload["validationRules"] = _normalize_validation_items(validations_reroute)
    if exceptions_reroute:
        payload["exceptions"] = _dedupe_list(exceptions_reroute, "text")
    if rerouted_non_mss > 0:
        hollow_gap_texts.append(
            f"{rerouted_non_mss} luồng non-MSS/validation đã chuyển sang "
            "Validation / Xử lý lỗi / Business rules — không nằm trong Luồng nghiệp vụ."
        )
    if hollow_gap_texts:
        gaps_extra = _as_list(payload.get("gaps"))
        seen_g = {str(g.get("text", "")).lower() for g in gaps_extra if isinstance(g, dict)}
        for txt in hollow_gap_texts:
            if txt.lower() not in seen_g:
                gaps_extra.append({"text": txt[:500]})
                seen_g.add(txt.lower())
        payload["gaps"] = _dedupe_list(gaps_extra, "text")[:MAX_GAPS]

    # Execution Context — WHO for E2E; only keep rows with a scenario/name ref from SRS.
    exec_in = _as_list(payload.get("executionContexts"))
    kept_exec: list[dict] = []
    for row in exec_in:
        if not isinstance(row, dict):
            continue
        name = str(row.get("name") or "").strip()
        actor = str(row.get("actor") or "").strip()
        if not name and not actor:
            continue
        if _is_criterion_section_label(name):
            continue
        roles_raw = row.get("roles")
        if isinstance(roles_raw, list):
            roles = [str(r).strip() for r in roles_raw if str(r).strip()][:8]
        elif isinstance(roles_raw, str) and roles_raw.strip():
            roles = [p.strip() for p in roles_raw.split(",") if p.strip()][:8]
        else:
            roles = []
        auth_raw = row.get("authRequired")
        auth_required: bool | None
        if isinstance(auth_raw, bool):
            auth_required = auth_raw
        elif str(auth_raw).strip().lower() in ("true", "yes", "1"):
            auth_required = True
        elif str(auth_raw).strip().lower() in ("false", "no", "0"):
            auth_required = False
        else:
            auth_required = None
        item: dict[str, Any] = {
            "name": (name or actor)[:200],
            "actor": actor[:120],
            "roles": roles,
            "permissions": str(row.get("permissions") or "").strip()[:400],
            "sessionHint": str(row.get("sessionHint") or "").strip()[:80],
            "notes": str(row.get("notes") or "").strip()[:300],
        }
        if auth_required is not None:
            item["authRequired"] = auth_required
        kept_exec.append(item)
    payload["executionContexts"] = _dedupe_list(kept_exec, "name")

    acceptance_in = _as_list(payload.get("acceptanceCriteria"))
    payload["acceptanceCriteria"] = _dedupe_list(
        [
            {"text": str(r.get("text") or "")[:500]}
            for r in acceptance_in
            if isinstance(r, dict) and _is_valid_acceptance_text(str(r.get("text") or ""))
        ],
        "text",
    )

    # Drop other lists whose sole content is a section heading / table dump / criteria echo.
    from app.features.requirement_studio.flow_mermaid import _META_ANALYSIS_ECHO as _META_ECHO

    for key, dedupe_key in (
        ("businessRules", "text"),
        ("exceptions", "text"),
        ("constraints", "text"),
        ("gaps", "text"),
    ):
        rows = _as_list(payload.get(key))
        cleaned = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            val = str(r.get(dedupe_key) or r.get("text") or "").strip()
            if not val:
                continue
            if _is_criterion_section_label(val) or _is_markdown_or_srs_dump(val):
                continue
            if _is_markdown_table_row(val):
                continue
            # Criteria-echo pretending to be an exception/gap — keep only as short gap below
            if key == "exceptions" and _META_ECHO.search(val):
                hollow_gap_texts.append(
                    "SRS khai báo Exception Flow / Luồng ngoại lệ nhưng chưa mô tả "
                    "điều kiện kích hoạt và phản hồi lỗi quan sát được."
                )
                continue
            if key == "gaps" and _META_ECHO.search(val) and len(val) > 120:
                # Replace long echo with short readable gap
                hollow_gap_texts.append(
                    "SRS khai báo Exception Flow / Luồng ngoại lệ nhưng chưa mô tả "
                    "điều kiện kích hoạt và phản hồi lỗi quan sát được."
                )
                continue
            cleaned.append(r)
        payload[key] = _dedupe_list(cleaned, dedupe_key) if cleaned else []

    if hollow_gap_texts:
        gaps = list(_as_list(payload.get("gaps")))
        for text in hollow_gap_texts:
            if not any(str(g.get("text") or "").strip() == text for g in gaps if isinstance(g, dict)):
                gaps.append({"text": text})
        payload["gaps"] = _dedupe_list(gaps, "text")

    validations_in = _as_list(payload.get("validationRules"))
    payload["validationRules"] = _normalize_validation_items(validations_in)

    actors_in = _as_list(payload.get("actors"))
    payload["actors"] = _dedupe_list(
        [
            r
            for r in actors_in
            if isinstance(r, dict)
            and str(r.get("name") or "").strip()
            and not _is_criterion_section_label(str(r.get("name") or ""))
            and not re.search(r"[-|]{3,}", str(r.get("name") or ""))
            and not re.search(r"[<>]{2,}|-{2,}>", str(r.get("name") or ""))
            and len(str(r.get("name") or "").strip()) <= 80
        ],
        "name",
    )

    return payload


def _reclassify_misplaced_features(payload: dict[str, Any]) -> dict[str, Any]:
    """Move numbered use-case titles out of features into useCases."""
    features = _as_list(payload.get("features"))
    use_cases = list(_as_list(payload.get("useCases")))
    uc_names = {
        str(uc.get("name") or "").strip().lower()
        for uc in use_cases
        if isinstance(uc, dict) and str(uc.get("name") or "").strip()
    }
    kept: list[dict] = []
    for row in features:
        if not isinstance(row, dict):
            continue
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        uc_title = _parse_numbered_use_case_title(name)
        if uc_title:
            desc = str(row.get("description") or "").strip()
            if desc and re.search(r"(?m)^\s*\d+[.)]\s+", desc):
                steps = desc
            elif desc:
                steps = f"1. {desc}\n2. Xác nhận kết quả trên giao diện"
            else:
                steps = f"1. Thực hiện {uc_title}\n2. Xác nhận kết quả trên giao diện"
            _upsert_use_case(use_cases, name=uc_title, steps=steps[:800])
            continue
        kept.append(row)
    payload["features"] = _dedupe_list(kept, "name")
    payload["useCases"] = _dedupe_list(use_cases, "name")
    return payload


def _derive_use_case_name_from_fragment(frag: str) -> str:
    """Derive a stable use-case title from SRS text — never a generic placeholder."""
    s = (frag or "").strip()
    if not s:
        return ""
    first = s.splitlines()[0].strip()
    uc_title = _parse_numbered_use_case_title(first)
    if uc_title:
        return uc_title
    # UC-01: Đăng nhập / Use case: Login / Luồng — Xác thực
    m_uc = re.match(
        r"(?i)^(?:use\s*case|uc[\s\-_]*\d+)\s*[:\-–]\s*(.+)$",
        first,
    )
    if m_uc and m_uc.group(1).strip():
        return m_uc.group(1).strip()[:200]
    if _USECASE_HEAD.search(first):
        for sep in (":", "—", "–", "-"):
            if sep in first:
                tail = first.split(sep, 1)[1].strip()
                if tail and len(tail) >= 3:
                    return tail[:200]
        return first[:200]
    m_feat = _FEATURE_HEAD.match(first)
    if m_feat and m_feat.group(2).strip():
        return m_feat.group(2).strip()[:200]
    # Short non-step line as title (section heading above steps)
    if first and len(first) <= 120 and not _FLOW_STEP_HINT.search(first):
        return first[:200]
    # Fallback: first step line trimmed (better than one shared label for all flows)
    for line in s.splitlines():
        ln = line.strip()
        if ln and _FLOW_STEP_HINT.search(ln):
            return ln[:200]
    return first[:200] if first else ""


def _fragment_already_in_use_cases(frag: str, use_cases: list) -> bool:
    """Skip re-extracting flows from text already stored in useCases."""
    needle = (frag or "").strip()
    if len(needle) < 12:
        return False
    probe = needle[: min(80, len(needle))]
    for uc in use_cases:
        if not isinstance(uc, dict):
            continue
        steps = str(uc.get("steps") or "")
        if probe in steps or needle in steps:
            return True
    return False


def _upsert_use_case(use_cases: list[dict], *, name: str, steps: str) -> None:
    """Insert or replace use case by name when new steps are richer."""
    n = (name or "").strip()[:200]
    s = (steps or "").strip()[:800]
    if not n or not s or _is_junk_use_case_name(n):
        return
    key = n.lower()
    for i, uc in enumerate(use_cases):
        if str(uc.get("name") or "").strip().lower() != key:
            continue
        old = str(uc.get("steps") or "")
        if _use_case_richness({"steps": s}) >= _use_case_richness({"steps": old}):
            use_cases[i] = {"name": n, "steps": s}
        return
    if len(use_cases) < MAX_ITEMS:
        use_cases.append({"name": n, "steps": s})


def _use_case_richness(item: dict[str, Any]) -> int:
    steps = str(item.get("steps") or "")
    mermaid = str(item.get("mermaid") or "")
    score = 0
    if mermaid and re.search(r"(?i)flowchart", mermaid):
        score += 100
    if steps.count("|") >= 3 or re.search(r"(?i)\|\s*Mục\s*\|", steps):
        score -= 100
    score += min(60, len(steps))
    score += steps.count("\n") * 12
    if re.search(r"(?m)^\s*\d+[.)]\s+\S", steps):
        score += 20
    return score


def _append_unique_use_case(use_cases: list[dict], *, name: str, steps: str) -> None:
    """Append use case; disambiguate name if same title but different steps."""
    from app.features.requirement_studio.flow_mermaid import enrich_use_case_flow_fields

    base_name = _strip_source_file_prefix((name or "").strip())[:200]
    steps_t = _extract_main_flow_steps(steps) or _format_flow_steps(steps)
    if not base_name or not steps_t or _is_junk_use_case_name(base_name):
        return
    for uc in use_cases:
        if str(uc.get("name") or "").strip().lower() == base_name.lower():
            # Prefer richer steps; do not create «Name (2)» duplicates
            existing = str(uc.get("steps") or "")
            if len(steps_t) > len(existing) + 20:
                uc["steps"] = steps_t
                enriched = enrich_use_case_flow_fields(uc)
                if enriched:
                    uc.clear()
                    uc.update(enriched)
            return
    if len(use_cases) < MAX_ITEMS:
        enriched = enrich_use_case_flow_fields({"name": base_name, "steps": steps_t})
        if enriched and enriched.get("mermaid"):
            use_cases.append(enriched)
        elif enriched and enriched.get("steps"):
            # Force mermaid synthesis path already inside enrich; keep if ≥2 steps
            use_cases.append(enriched)


def _enforce_criteria_split(payload: dict[str, Any]) -> dict[str, Any]:
    """
    Ensure mixed SRS lines are split into their own criteria buckets.
    This helps when documents merge many rules in one paragraph.
    """
    fragments = _payload_fragments(payload)
    if not fragments:
        return payload

    features = _as_list(payload.get("features"))
    actors = _as_list(payload.get("actors"))
    use_cases = _as_list(payload.get("useCases"))
    business_rules = _as_list(payload.get("businessRules"))
    validations = _as_list(payload.get("validationRules"))
    apis = _as_list(payload.get("apiSummary"))
    exceptions = _as_list(payload.get("exceptions"))
    acceptance = _as_list(payload.get("acceptanceCriteria"))
    constraints = _as_list(payload.get("constraints"))
    gaps = _as_list(payload.get("gaps"))

    for frag in fragments:
        # 1) API/UI
        for m in _API_RE.finditer(frag):
            row = {
                "method": m.group(1).upper(),
                "path": m.group(2),
                "note": frag[:200],
            }
            if not any(_api_key(a) == _api_key(row) for a in apis) and len(apis) < MAX_ITEMS:
                apis.append(row)
        # 2) Actors / permissions
        m_actor = _ACTOR_LINE_RE.match(frag)
        if m_actor:
            _append_unique(
                actors,
                "name",
                {"name": m_actor.group(1).strip()[:120], "description": "", "permissions": ""},
            )
        # 3) Business flow — only split mixed lines not already in useCases
        first_line = frag.splitlines()[0].strip() if frag else ""
        is_flow = (
            _FLOW_STEP_HINT.search(frag)
            or _USECASE_HEAD.search(frag)
            or _is_numbered_use_case_title(first_line)
        )
        if is_flow and not _fragment_already_in_use_cases(frag, use_cases):
            flow_name = _derive_use_case_name_from_fragment(frag)
            if flow_name:
                _append_unique_use_case(use_cases, name=flow_name, steps=frag[:800])
        # 4) Validation
        if _VALIDATION_HINT.search(frag):
            _append_unique(validations, "rule", {"field": "", "rule": frag[:500]})
        # 5) Error handling
        if _EXCEPTION_HINT.search(frag):
            _append_unique(exceptions, "text", {"text": frag[:500]})
        # 6) Acceptance — require real AC content, not section headings
        if _ACCEPTANCE_HINT.search(frag) and _is_valid_acceptance_text(frag):
            _append_unique(acceptance, "text", {"text": frag[:500]})
        # 7) NFR constraints
        if re.search(r"(?i)\b(performance|bảo mật|security|sla|timeout|audit|logging)\b", frag):
            _append_unique(constraints, "text", {"text": frag[:500]})
        # 8) Business rules
        if _RULE_HINT.search(frag) or (_AUTH_HINT.search(frag) and _RULE_HINT.search(frag)):
            _append_unique(
                business_rules,
                "text",
                {"id": f"BR-{len(business_rules) + 1}", "text": frag[:500]},
            )
        # 9) Features — only real capability lines from SRS (not TOC / markdown dumps)
        first_line = frag.splitlines()[0].strip() if frag else ""
        if (
            _is_numbered_use_case_title(first_line)
            or _is_junk_feature(first_line, frag)
            or _is_criterion_section_label(first_line)
            or _is_markdown_or_srs_dump(frag)
        ):
            pass
        elif m_feat := _FEATURE_HEAD.match(frag):
            feat_name = (m_feat.group(2).strip() or frag[:80])[:200]
            if not _is_junk_feature(feat_name, frag):
                _append_unique(
                    features,
                    "name",
                    {"name": feat_name, "description": frag[:400]},
                )
        elif (
            _FEATURE_HEAD_SIMPLE.search(frag)
            and not _USECASE_HEAD.search(frag)
            and len(frag) < 120
            and not _is_junk_feature(frag[:200], "")
        ):
            _append_unique(features, "name", {"name": frag[:200], "description": ""})
        # 10) Gaps
        if _GAP_HINT.search(frag):
            _append_unique(gaps, "text", {"text": frag[:500]}, limit=MAX_GAPS)

    payload["features"] = _dedupe_list(features, "name")
    payload["actors"] = _dedupe_list(actors, "name")
    payload["useCases"] = _dedupe_list(use_cases, "name")
    payload["businessRules"] = _dedupe_list(business_rules, "text")
    for i, r in enumerate(payload["businessRules"], start=1):
        r["id"] = f"BR-{i}"
    payload["validationRules"] = _normalize_validation_items(validations)
    payload["apiSummary"] = _dedupe_apis(apis)
    payload["exceptions"] = _dedupe_list(exceptions, "text")
    payload["acceptanceCriteria"] = _dedupe_list(acceptance, "text")
    payload["constraints"] = _dedupe_list(constraints, "text")
    payload["gaps"] = _dedupe_list(gaps, "text")[:MAX_GAPS]
    return payload


def normalize_knowledge_payload(raw: dict[str, Any] | None) -> dict[str, Any]:
    """
    Fold legacy keys into TC-readiness schema; dual-write legacy mirrors.
    Safe to call on every read/write.
    """
    base = empty_payload()
    if not isinstance(raw, dict):
        return base

    summary = raw.get("summary")
    if isinstance(summary, str):
        base["summary"] = summary.strip()
    elif isinstance(summary, list):
        base["summary"] = "\n".join(
            str(x).strip() for x in summary if str(x).strip()
        ).strip()
    elif summary is not None:
        base["summary"] = str(summary).strip()

    for key in PRIMARY_LIST_KEYS:
        if key == "gaps":
            continue
        items = _as_list(raw.get(key))
        if items:
            base[key] = items[:MAX_ITEMS]

    if not base["features"] and base["useCases"]:
        feats: list[dict] = []
        for uc in base["useCases"]:
            if not isinstance(uc, dict):
                continue
            name = str(uc.get("name") or "").strip()
            if name and not _is_numbered_use_case_title(name) and not _is_criterion_section_label(name):
                feats.append({"name": name, "description": ""})
        base["features"] = _dedupe_list(feats, "name")

    gaps_in = _as_list(raw.get("gaps"))
    if gaps_in:
        folded: list[dict] = []
        seen_g: set[str] = set()
        for g in gaps_in:
            text = _text_item(g)
            key = text.lower()
            if not text or key in seen_g:
                continue
            seen_g.add(key)
            if isinstance(g, dict) and "text" in g:
                folded.append({"text": str(g["text"])[:500]})
            else:
                folded.append({"text": text[:500]})
            if len(folded) >= MAX_GAPS:
                break
        base["gaps"] = folded
    else:
        merged: list[dict] = []
        seen: set[str] = set()
        for src_key in ("openQuestions", "missingInformation"):
            for row in _as_list(raw.get(src_key)):
                text = _text_item(row)
                key = text.lower()
                if not text or key in seen:
                    continue
                seen.add(key)
                merged.append({"text": text[:500]})
                if len(merged) >= MAX_GAPS:
                    break
            if len(merged) >= MAX_GAPS:
                break
        base["gaps"] = merged

    base["openQuestions"] = list(base["gaps"])
    base["missingInformation"] = list(base["gaps"])
    for key in ("glossary", "databaseSummary"):
        items = _as_list(raw.get(key))
        if items:
            base[key] = items[:MAX_ITEMS]

    if not base["validationRules"] and base["databaseSummary"]:
        for ent in base["databaseSummary"]:
            if not isinstance(ent, dict):
                continue
            name = str(ent.get("entity") or "").strip()
            if not name:
                continue
            note = str(ent.get("note") or "").strip()
            base["validationRules"].append(
                {
                    "field": name,
                    "rule": note if _MEASURABLE_VALIDATION.search(note or "") else "",
                }
            )
        base["validationRules"] = base["validationRules"][:MAX_ITEMS]

    return _sanitize_knowledge_payload(
        _reclassify_misplaced_features(_enforce_criteria_split(base))
    )


def build_knowledge_heuristic(
    chunks: list[tuple[str | None, str]],
    *,
    file_names: list[str] | None = None,
) -> dict[str, Any]:
    """
    Extract a readable Knowledge payload from (heading, text) chunks.
    Always available — no LLM required (R3 baseline).
    """
    payload = empty_payload()
    if not chunks:
        payload["gaps"].append(
            {"text": "Chưa có đoạn tài liệu — upload và tách đoạn trước."}
        )
        payload["summary"] = "Knowledge trống."
        return normalize_knowledge_payload(payload)

    headings = [h for h, _ in chunks if h]
    joined_preview = "\n\n".join(
        (f"## {h}\n{t}" if h else t) for h, t in chunks
    )[:1200]

    files = ", ".join(file_names[:8]) if file_names else ""
    summary_bits = []
    if files:
        summary_bits.append(f"Nguồn: {files}.")
    if headings:
        summary_bits.append(
            "Phạm vi / mục chính: " + "; ".join(dict.fromkeys(headings[:12])) + "."
        )
    summary_bits.append(joined_preview[:500].replace("\n", " ").strip())
    payload["summary"] = " ".join(summary_bits).strip()

    features: list[dict] = []
    rules: list[dict] = []
    actors: list[dict] = []
    use_cases: list[dict] = []
    pending_uc_index: list[str] = []
    validations: list[dict] = []
    apis: list[dict] = []
    exceptions: list[dict] = []
    acceptance: list[dict] = []
    gaps: list[dict] = []
    constraints: list[dict] = []
    glossary: list[dict] = []
    entities: list[dict] = []

    for heading, text in chunks:
        h_raw = (heading or "").strip()
        h = _strip_source_file_prefix(h_raw)
        body = (text or "").strip()

        if h and not _USECASE_HEAD.search(h) and _FEATURE_HEAD_SIMPLE.search(h):
            if not _is_junk_feature(h, body):
                flow_lines = [
                    ln.strip() for ln in body.splitlines() if _FLOW_STEP_HINT.search(ln)
                ]
                if flow_lines:
                    use_cases.append(
                        {
                            "name": h[:200],
                            "steps": "\n".join(flow_lines[:12])[:800],
                        }
                    )
                elif body:
                    features.append({"name": h[:200], "description": body[:400]})

        m_sec = _NUMBERED_SECTION_HEAD.match(h_raw) if h_raw else None
        if m_sec and body and not _is_criterion_section_label(h_raw):
            sec_name = m_sec.group(1).strip()[:200]
            if _FLOW_STEP_HINT.search(body) and not _is_junk_use_case_name(sec_name):
                steps = _extract_main_flow_steps(body) or _coerce_uc_steps(body)
                if steps:
                    _upsert_use_case(use_cases, name=sec_name, steps=steps)
            elif not _is_junk_feature(sec_name, body):
                features.append({"name": sec_name, "description": body[:400]})

        if h and _CAPABILITY_SECTION_HEAD.search(h) and body:
            first_line = next(
                (ln.strip() for ln in body.splitlines() if ln.strip() and not _is_markdown_table_row(ln.strip())),
                h,
            )
            feat_name = (
                _parse_numbered_use_case_title(first_line)
                or _parse_fr_title(first_line)
                or first_line[:200]
            )
            if feat_name and not _is_junk_feature(feat_name, body):
                features.append({"name": feat_name[:200], "description": body[:400]})

        if h and _VALIDATION_HINT.search(h) and body:
            for line in body.splitlines():
                row = line.strip()
                if not _is_markdown_table_row(row):
                    continue
                if re.search(r"(?i)\|\s*(?:trường|field|kiểu|type|bắt buộc)\s*\|", row):
                    continue
                cells = [c.strip() for c in row.strip("|").split("|")]
                if (
                    len(cells) >= 3
                    and cells[0]
                    and not re.match(r"(?i)^(?:trường|field|:[-]+)$", cells[0])
                    and len(cells[0]) <= 40
                ):
                    rule = ", ".join(c for c in cells[1:] if c)[:200]
                    validations.append({"field": cells[0][:80], "rule": rule})

        if h and _USECASE_HEAD.search(h) and not _is_junk_use_case_name(h):
            steps = _extract_main_flow_steps(body) or _coerce_uc_steps(body)
            if steps:
                _upsert_use_case(use_cases, name=h[:200], steps=steps)

        if h:
            fr_title = _parse_fr_title(h)
            if fr_title:
                if _is_support_fr_not_feature(fr_title, body):
                    _route_support_fr(
                        code="FR",
                        raw_req=body or fr_title,
                        rules=rules,
                        validations=validations,
                        exceptions=exceptions,
                    )
                else:
                    features.append(
                        {
                            "name": fr_title,
                            "description": (body[:400] if body else h[:400]),
                        }
                    )
            uc_title = _parse_numbered_use_case_title(h)
            if uc_title:
                steps = _extract_main_flow_steps(body)
                if not steps:
                    steps = _coerce_uc_steps(body)
                if steps:
                    _upsert_use_case(use_cases, name=uc_title, steps=steps)
            elif not fr_title and not _is_junk_feature(h, body):
                m_feat = _FEATURE_HEAD.match(h)
                if m_feat:
                    feat_name = m_feat.group(2).strip()[:200] or h[:200]
                    if not _is_junk_feature(feat_name, body):
                        features.append(
                            {
                                "name": feat_name,
                                "description": body[:400],
                            }
                        )
                elif (
                    _FEATURE_HEAD_SIMPLE.search(h)
                    and not _USECASE_HEAD.search(h)
                    and not _is_criterion_section_label(h)
                ):
                    features.append({"name": h[:200], "description": body[:400]})

            # Actor table under «Actor» / «Tác nhân» headings
            if re.search(r"(?i)\b(?:actor|tác\s*nhân|vai\s*trò)\b", h) and body:
                for line in body.splitlines():
                    row = line.strip()
                    if not _is_markdown_table_row(row):
                        continue
                    cells = [c.strip() for c in row.strip("|").split("|")]
                    if len(cells) < 2:
                        continue
                    aname = cells[0]
                    if not aname or re.search(
                        r"(?i)^(actor|vai\s*trò|mô\s*tả|tên|:[-]+)$", aname
                    ):
                        continue
                    if re.search(r"[-|]{3,}|[<>]{2,}", aname):
                        continue
                    actors.append(
                        {
                            "name": aname[:120],
                            "description": cells[1][:200] if len(cells) > 1 else "",
                            "permissions": "",
                        }
                    )

        for line in text.splitlines():
            s = line.strip()
            if not s or len(s) < 8:
                continue

            # Structured FR / UC / BR / AC / NFR from markdown tables (formal SRS).
            m_fr = _FR_TABLE_ROW.match(s)
            if m_fr:
                code = f"FR-{int(m_fr.group(1)):02d}"
                raw_req = m_fr.group(2).strip()
                feat_name = _shorten_fr_capability(raw_req)[:200]
                # Traceability cells like «| FR-01 | UC-01 | … |» are not capabilities.
                if re.match(r"(?i)^UC[\s\-_]*\d+$", feat_name):
                    continue
                if feat_name and not _is_junk_feature(feat_name, raw_req):
                    if _is_support_fr_not_feature(feat_name, raw_req):
                        _route_support_fr(
                            code=code,
                            raw_req=raw_req,
                            rules=rules,
                            validations=validations,
                            exceptions=exceptions,
                        )
                    else:
                        features.append(
                            {
                                "name": feat_name,
                                "description": f"{code}: {raw_req}"[:400],
                            }
                        )
                continue

            m_uc = _UC_TABLE_ROW.match(s)
            if m_uc:
                # Index-only — detail sections (### UC-xx) supply real Luồng chính.
                # Names collected for end-of-pass fallback if no detail found.
                uc_name = (m_uc.group(2) or "").strip()[:200]
                if uc_name and not _is_junk_use_case_name(uc_name):
                    pending_uc_index.append(uc_name)
                continue

            m_br = _BR_TABLE_ROW.match(s)
            if m_br:
                rules.append(
                    {
                        "id": f"BR-{int(m_br.group(1))}",
                        "text": m_br.group(2).strip()[:500],
                    }
                )
                continue

            m_nfr = _NFR_TABLE_ROW.match(s)
            if m_nfr:
                group = m_nfr.group(2).strip()
                desc = m_nfr.group(3).strip()
                text = f"{group}: {desc}" if group and desc else (desc or group)
                if text:
                    constraints.append({"text": text[:500]})
                continue

            m_api_tbl = _API_TABLE_ROW.match(s)
            if m_api_tbl:
                path = m_api_tbl.group(2)
                # Skip UAT placeholder paths like /todos/{id_sai}
                if not re.search(r"(?i)_sai|example|placeholder", path):
                    apis.append(
                        {
                            "method": m_api_tbl.group(1).upper(),
                            "path": path,
                            "note": s[:200],
                        }
                    )
                continue

            for m_ac in _AC_INLINE.finditer(s):
                ac_text = f"AC-{int(m_ac.group(1)):02d}: {m_ac.group(2).strip()}"
                if _is_valid_acceptance_text(ac_text):
                    acceptance.append({"text": ac_text[:500]})

            # Skip freeform extraction on table separator / header noise rows.
            if _is_markdown_table_row(s):
                # Field validation table: | title | String | Có | Độ dài 3–100 |
                if _VALIDATION_HINT.search(s) and not re.search(
                    r"(?i)\|\s*(?:trường|field|kiểu|bắt buộc)\s*\|", s
                ):
                    cells = [c.strip() for c in s.strip("|").split("|")]
                    if (
                        len(cells) >= 4
                        and cells[0]
                        and not re.match(r"(?i)^(trường|field|:[-]+)$", cells[0])
                        and not re.search(r"(?i)FR[\s\-_]*\d+|UC[\s\-_]*\d+|→|->", cells[0])
                        and len(cells[0]) <= 40
                    ):
                        rule = ", ".join(c for c in cells[1:] if c)[:200]
                        validations.append({"field": cells[0][:80], "rule": rule})
                for m in _API_RE.finditer(s):
                    path = m.group(2)
                    if re.search(r"(?i)_sai|example|placeholder", path):
                        continue
                    apis.append(
                        {
                            "method": m.group(1).upper(),
                            "path": path,
                            "note": s[:200],
                        }
                    )
                continue

            m_actor = _ACTOR_LINE_RE.match(s)
            if m_actor:
                actors.append(
                    {
                        "name": m_actor.group(1).strip()[:120],
                        "description": "",
                        "permissions": "",
                    }
                )
            else:
                m_story = _USER_STORY_ACTOR_RE.search(s)
                story_actor = (m_story.group(1) or m_story.group(2) or "").strip() if m_story else ""
                if story_actor:
                    actors.append(
                        {
                            "name": story_actor[:120],
                            "description": "",
                            "permissions": "",
                        }
                    )

            if _RULE_HINT.search(s):
                item = {"id": f"BR-{len(rules) + 1}", "text": s[:500]}
                if re.search(
                    r"(?i)\b(performance|bảo mật|security|sla|timeout|audit|logging)\b",
                    s,
                ):
                    constraints.append({"text": s[:500]})
                else:
                    rules.append(item)
                if _VALIDATION_HINT.search(s) and len(s) <= 220:
                    validations.append({"field": "", "rule": s[:500]})
            elif _VALIDATION_HINT.search(s) and len(s) <= 220 and not re.match(
                r"(?i)^(?:AC|FR|NFR)[\s\-_]*\d+", s
            ):
                validations.append({"field": "", "rule": s[:500]})

            if _AUTH_HINT.search(s) and _RULE_HINT.search(s):
                rules.append({"id": f"BR-{len(rules) + 1}", "text": s[:500]})

            if (
                _EXCEPTION_HINT.search(s)
                and not re.match(r"(?i)^(?:AC|FR|NFR)[\s\-_]*\d+", s)
                and not re.match(r"(?i)^(?:GET|POST|PUT|PATCH|DELETE)\s+/", s)
                and "—" not in s[:40]
            ):
                exceptions.append({"text": s[:500]})

            if _ACCEPTANCE_HINT.search(s) and _is_valid_acceptance_text(s):
                acceptance.append({"text": s[:500]})

            if _GAP_HINT.search(s):
                gaps.append({"text": s[:400]})

            m_g = _GLOSSARY_RE.match(s)
            if m_g:
                glossary.append(
                    {
                        "term": m_g.group(1).strip()[:80],
                        "definition": m_g.group(2).strip()[:400],
                    }
                )

            for m in _API_RE.finditer(s):
                apis.append(
                    {
                        "method": m.group(1).upper(),
                        "path": m.group(2),
                        "note": s[:200],
                    }
                )

            for m in _ENTITY_RE.finditer(s):
                entities.append({"entity": m.group(1), "note": s[:200]})

            if _FLOW_STEP_HINT.search(s):
                # Only attach flow bullets to capability / UC / FR headings — never TOC/scope.
                if h and not _is_capability_heading(h):
                    continue
                flow_name = (
                    _parse_numbered_use_case_title(h)
                    or _parse_fr_title(h)
                    or (h[:200] if h else "Luồng nghiệp vụ")
                )
                if _is_junk_use_case_name(flow_name):
                    continue
                use_cases.append({"name": flow_name[:200], "steps": s[:800]})

    payload["features"] = _dedupe_list(features, "name")
    payload["businessRules"] = _dedupe_list(rules, "text")
    for i, r in enumerate(payload["businessRules"], start=1):
        r["id"] = f"BR-{i}"
    payload["actors"] = _dedupe_list(actors, "name")
    # Fallback: UC index names with no detail section yet
    for uc_name in pending_uc_index:
        if any(
            str(u.get("name") or "").strip().lower() == uc_name.lower()
            for u in use_cases
        ):
            continue
        _upsert_use_case(
            use_cases,
            name=uc_name,
            steps=(
                f"1. Thực hiện {uc_name}\n"
                f"2. Xác nhận kết quả trên giao diện"
            ),
        )
    payload["useCases"] = _dedupe_list(use_cases, "name")
    payload["validationRules"] = _normalize_validation_items(validations)
    payload["apiSummary"] = _dedupe_apis(apis)
    payload["exceptions"] = _dedupe_list(exceptions, "text")
    payload["acceptanceCriteria"] = _dedupe_list(acceptance, "text")
    payload["constraints"] = _dedupe_list(constraints, "text")
    payload["glossary"] = _dedupe_list(glossary, "term")
    payload["databaseSummary"] = _dedupe_list(entities, "entity")

    structural_gaps: list[dict] = []
    if not payload["features"] and not payload["useCases"]:
        structural_gaps.append(
            {
                "text": "Chưa nhận diện Chức năng / Feature — cần tiêu đề Feature hoặc Use Case."
            }
        )
    if not payload["useCases"]:
        structural_gaps.append(
            {"text": "Chưa có Luồng nghiệp vụ (Use Case) có tiêu đề + steps."}
        )
    if not payload["businessRules"]:
        structural_gaps.append(
            {"text": "Chưa thấy Business Rule kiểm thử được (phải / bắt buộc / must…)."}
        )
    if not payload["actors"]:
        structural_gaps.append({"text": "Chưa nhận diện Actor / vai trò."})
    if not payload["validationRules"]:
        structural_gaps.append(
            {"text": "Chưa có Validation & dữ liệu (field, format, range)."}
        )
    if not payload["acceptanceCriteria"]:
        structural_gaps.append(
            {"text": "Chưa có Acceptance criteria (Done when / Given-When-Then)."}
        )
    if not payload["apiSummary"] and not payload["databaseSummary"]:
        structural_gaps.append(
            {"text": "Chưa có thông tin API / entity / model / bảng dữ liệu liên quan."}
        )

    payload["gaps"] = _dedupe_list(gaps + structural_gaps, "text")[:MAX_GAPS]
    return normalize_knowledge_payload(payload)


def parse_knowledge_llm_json(raw: str) -> dict[str, Any] | None:
    text = strip_code_fences(raw or "").strip()
    if not text:
        return None
    try:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            text = text[start : end + 1]
        data = json.loads(text)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    base = empty_payload()
    for key in base:
        if key not in data:
            continue
        val = data[key]
        if key == "summary":
            if isinstance(val, str):
                base["summary"] = val.strip()
            elif isinstance(val, list):
                base["summary"] = "\n".join(
                    str(x).strip() for x in val if str(x).strip()
                ).strip()
            elif val is not None:
                base["summary"] = str(val).strip()
        elif isinstance(val, list):
            limit = MAX_GAPS if key == "gaps" else MAX_ITEMS
            base[key] = val[:limit]
    return normalize_knowledge_payload(base)


def _chunk_rank_score(heading: str | None, text: str) -> int:
    h = (heading or "").strip()
    body = (text or "").strip()
    blob = f"{h}\n{body}"
    score = 0
    if h:
        score += 2
        if _FEATURE_HEAD_SIMPLE.search(h) or _FEATURE_HEAD.match(h):
            score += 6
        if _USECASE_HEAD.search(h):
            score += 6
    if _ACTOR_LINE_RE.search(blob) or _USER_STORY_ACTOR_RE.search(blob):
        score += 4
    if _RULE_HINT.search(blob):
        score += 3
    if _VALIDATION_HINT.search(blob):
        # Still include for validationRules/businessRules in LLM prompt (below UC/Feature).
        score += 2
    if _API_RE.search(blob):
        score += 2
    if _ACCEPTANCE_HINT.search(blob):
        score += 2
    if _EXCEPTION_HINT.search(blob):
        score += 1
    if _AUTH_HINT.search(blob):
        score += 2
    if _FLOW_STEP_HINT.search(blob):
        score += 3
    # Prefer denser chunks slightly
    score += min(3, len(body) // 800)
    return score


def rank_chunks_for_build(
    chunks: list[tuple[str | None, str]],
) -> list[tuple[str | None, str]]:
    """Prioritize TC-critical chunks; stable order among equal scores."""
    scored: list[tuple[int, int, str | None, str]] = []
    for i, (heading, text) in enumerate(chunks):
        scored.append((_chunk_rank_score(heading, text), i, heading, text or ""))
    scored.sort(key=lambda row: (-row[0], row[1]))
    return [(h, t) for _, _, h, t in scored]


def chunks_to_prompt_text(
    chunks: list[tuple[str | None, str]],
    *,
    max_chars: int | None = None,
    rank: bool = False,
) -> str:
    budget = max_chars if max_chars is not None else MAX_CHUNK_CHARS_FOR_BUILD
    ordered = rank_chunks_for_build(chunks) if rank else list(chunks)
    parts: list[str] = []
    total = 0
    for i, (heading, text) in enumerate(ordered):
        block = (
            f"[Chunk {i + 1}"
            + (f" | {heading}" if heading else "")
            + f"]\n{text.strip()}"
        )
        if total + len(block) > budget:
            remain = budget - total
            if remain > 200:
                parts.append(block[:remain] + "\n…")
            break
        parts.append(block)
        total += len(block)
    return "\n\n".join(parts)


def _list_item_identity(item: Any) -> str:
    if not isinstance(item, dict):
        return str(item).strip().lower() if item is not None else ""
    method = str(item.get("method") or "").strip().upper()
    path = str(item.get("path") or "").strip().lower()
    if method or path:
        return f"{method}:{path}"
    field = str(item.get("field") or "").strip().lower()
    rule = str(item.get("rule") or "").strip().lower()
    if field or rule:
        return f"{field}:{rule}"
    for k in ("name", "id", "title", "text", "criterion"):
        v = item.get(k)
        if v is not None and str(v).strip():
            return str(v).strip().lower()
    return _text_item(item).lower()


def _union_knowledge_lists(
    base_list: list[Any],
    overlay_list: list[Any],
    *,
    limit: int = MAX_ITEMS,
    prefer_rich_use_cases: bool = False,
) -> list[Any]:
    """Union lists. For useCases, keep the richer item when names collide."""
    out: list[Any] = []
    seen: dict[str, int] = {}
    for it in list(overlay_list) + list(base_list):
        if not isinstance(it, dict):
            continue
        ident = _list_item_identity(it)
        if not ident:
            continue
        if ident in seen:
            if prefer_rich_use_cases:
                idx = seen[ident]
                if _use_case_richness(it) > _use_case_richness(out[idx]):
                    out[idx] = it
            continue
        seen[ident] = len(out)
        out.append(it)
        if len(out) >= limit:
            break
    return out


def merge_knowledge_payloads(
    base: dict[str, Any] | None,
    overlay: dict[str, Any] | None,
) -> dict[str, Any]:
    """
    Merge LLM overlay onto heuristic base.
    Non-empty overlay summary wins. List keys are unioned (LLM first) so a
    thinner Cursor pass cannot wipe heuristic features / rules / APIs.
    For useCases, richer steps/mermaid wins on name collision (never let hollow
    LLM wipe heuristic flows).
    Empty overlay lists keep base.
    """
    out = normalize_knowledge_payload(base if isinstance(base, dict) else empty_payload())
    if not isinstance(overlay, dict):
        return out
    over = normalize_knowledge_payload(overlay)
    if (over.get("summary") or "").strip():
        out["summary"] = over["summary"]
    for key in PRIMARY_LIST_KEYS + LEGACY_LIST_KEYS:
        ov = over.get(key) or []
        if not isinstance(ov, list) or len(ov) == 0:
            continue
        # Drop hollow useCases from overlay before merge
        if key == "useCases":
            ov = [
                u
                for u in ov
                if isinstance(u, dict)
                and (
                    str(u.get("steps") or "").strip()
                    or str(u.get("mermaid") or "").strip()
                )
                and _use_case_richness(u) > 0
            ]
            if not ov:
                continue
        base_list = out.get(key) or []
        if not isinstance(base_list, list) or len(base_list) == 0:
            out[key] = ov
        else:
            out[key] = _union_knowledge_lists(
                base_list,
                ov,
                prefer_rich_use_cases=(key == "useCases"),
            )
    return normalize_knowledge_payload(out)



def chunks_input_hash(
    pairs: list[tuple[str | None, str]],
    file_names: list[str] | None = None,
) -> str:
    """Stable hash of chunk text used to skip LLM enrich when SRS unchanged."""
    import hashlib

    h = hashlib.sha256()
    for name in file_names or []:
        h.update(name.encode("utf-8", errors="ignore"))
        h.update(b"\0")
    for heading, text in pairs:
        h.update((heading or "").encode("utf-8", errors="ignore"))
        h.update(b"\0")
        h.update((text or "").encode("utf-8", errors="ignore"))
        h.update(b"\0")
    return h.hexdigest()[:32]



def knowledge_enrich_oneshot_system_prompt() -> str:
    """Single-call enrich system — compact; main-flow-only for useCases."""
    return (
        "You are a requirements analyst preparing Knowledge for QA.\n"
        "Return ONLY one JSON object (no markdown) with keys:\n"
        "- summary (string): 2–5 câu Scope in/out + actor\n"
        "- features ([{name,description}]): capability nghiệp vụ (gộp FR); name=động từ+đối tượng; "
        "description có FR-id — CẤM mục lục; field/validation → validationRules (không thành feature)\n"
        "- actors ([{name,description,permissions}])\n"
        "- useCases ([{name,steps}]): **CHỈ Luồng chính / MSS** mỗi UC "
        "(steps dạng 1.2.3. ngắn gọn) — CẤM Exception/Alt/Luồng phụ/validation flow "
        "(→ exceptions hoặc validationRules)\n"
        "- businessRules ([{id,text}])\n"
        "- validationRules ([{field,rule,module}]): field+rule đo được — KHÔNG tạo useCase từ validation\n"
        "- apiSummary ([{method,path,note}])\n"
        "- exceptions ([{text}])\n"
        "- acceptanceCriteria ([{text}])\n"
        "- constraints ([{text}])\n"
        "- executionContexts ([{name,actor,authRequired,roles,sessionHint,description}])\n"
        "- gaps ([{text}])\n\n"
        f"{ANALYSIS_FIDELITY_RULES.strip()}\n\n"
        "Empty list if absent. Prefer near-verbatim SRS. "
        "features ≠ useCases ≠ validationRules. "
        "useCases = main flows only."
    )


def build_enrich_oneshot_prompt(
    chunks: list[tuple[str | None, str]],
    *,
    file_names: list[str] | None = None,
) -> str:
    """One-shot user prompt with ranked SRS excerpts (speed path)."""
    files = ", ".join((file_names or [])[:20]) or "(unknown)"
    excerpt = chunks_to_prompt_text(
        chunks,
        max_chars=MAX_CHUNK_CHARS_ONESHOT_ENRICH,
        rank=True,
    )
    return (
        "Phân tích SRS — 1 lượt, trả về đủ Knowledge JSON.\n"
        f"Files: {files}\n\n"
        "Ưu tiên: features (capability) + useCases (**chỉ Luồng chính / MSS** + steps gọn).\n"
        "CẤM: mục lục→features; dump bảng→useCases; Exception/Alt/Luồng phụ/validation flow→useCases; "
        "1 field/widget = 1 feature. Validation → validationRules only.\n\n"
        "DOCUMENT EXCERPTS:\n\n"
        f"{excerpt}\n\n"
        "Return JSON now."
    )


