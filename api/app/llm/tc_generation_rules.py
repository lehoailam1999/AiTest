"""Quy tắc sinh test case dùng chung (BE) — áp dụng mọi job generate TC.

Chỉnh file này để đổi hành vi AI toàn hệ thống. Không nhập từ UI.
"""

from __future__ import annotations

# Rule mặc định: cover đủ mọi Feature/file, không bỏ sót module.
DEFAULT_TC_GENERATION_RULES = """\
QUY TẮC SINH TEST CASE (BẮT BUỘC — hệ thống):
1. Context đa file: mỗi khối Feature / mỗi file SRS = một chức năng (module) riêng.
2. Phải phân tích HẾT nội dung tài liệu được cung cấp cho phạm vi job hiện tại — không bỏ mục/quy tắc nghiệp vụ.
3. Nếu có nhiều Feature và job không giới hạn 1 chủ đề: phải sinh TC cho TẤT CẢ chức năng; mỗi chức năng ít nhất 1 happy path + 2 negative/biên lấy từ đúng tài liệu Feature đó.
4. Trường module của mỗi TC = đúng tên chức năng (Feature) tương ứng — không gộp nhiều chức năng vào một module.
5. Không bịa yêu cầu ngoài tài liệu; không trùng hoặc paraphrase nhẹ TC đã liệt kê.
6. Ưu tiên kịch bản kiểm thử: happy path → validation/phủ định → biên → lỗi hệ thống quan trọng (nếu tài liệu có).
7. Toàn bộ title, steps, expectedResult, precondition, testData, type, priority, severity bằng tiếng Việt.
"""


def get_tc_generation_rules() -> str:
    """Entry point duy nhất — sau này có thể đọc từ env/file nếu cần."""
    return DEFAULT_TC_GENERATION_RULES.strip()
