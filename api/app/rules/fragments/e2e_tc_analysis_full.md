## E2E ← PHÂN TÍCH (Output-driven) — nguồn #1 duy nhất
Approved Knowledge / Freeze / DB = SoT (12 bucket + summary).
CẤM: đọc lại SRS thô · source invent FR · pad · exploratory · TC thừa/trùng.
Bucket [] → bỏ qua. Mỗi TC: testData `trace: <TYPE>/<id|name>` (unique trong module).
Số TC = số tín hiệu Output cần cover — không trần N cố định, không «cho đủ số».
target_url/auth_hint = runtime hint, không tạo FR.

0. OUTPUT COMPLETENESS (gate TRƯỚC khi sinh):
   Tối thiểu: FEATURES (≥1) + (BUSINESS_FLOWS hoặc ACCEPTANCE) có item.
   Thiếu → chỉ cover phần đủ; ghi [Thiếu Output] / [Giả định] — KHÔNG bịa flow/AC. GAPS = cảnh báo.
1. SoT lock: chỉ Output đã duyệt.
2. UI relevance (chắt lọc UI): Classify: UI_JOURNEY (thao tác & outcome UI) | BE_ONLY (logic ngầm server/DB → bỏ qua E2E) | UNKNOWN (không invent UI). Chỉ sinh E2E TC cho UI_JOURNEY.
3. Traceability (ISTQB): `trace:` → FEATURES|FLOWS|BR|VALIDATION|AC|ERROR|ACTORS|EXEC_CONTEXT|API_UI. 1 tín hiệu chính / 1 TC. Cùng `trace:` → tối đa 1 TC.
4. Workflow / use-case: BUSINESS_FLOWS = xương sống. Mỗi main + mỗi alt/exception có trong FLOWS → ≥1 TC (entry→exit). Back/Cancel/Save-draft chỉ khi FLOWS/AC có tín hiệu.
5. Decision / permission: ACTORS + EXECUTION_CONTEXT → ≥1 TC quyền (allow/deny) khi có RBAC.
6. EP / BVA: VALIDATION có miền/biên trên UI → ≥1 TC lớp tương đương hoặc biên (không clone assert).
7. BR Expansion: mỗi BUSINESS_RULES quan sát được trên UI → ≥1 TC.
8. Scenario Expansion: Happy · Validation · Permission · Boundary · Error — CHỈ nhánh có tín hiệu UI.
9. Step Expansion: mỗi step dạng `[Hành động] → [Element/nhãn UI] → [Data nếu có]`. CẤM bước chỉ «kiểm tra / verify» không rõ control. Post-login thiếu path: → ghi `[Thiếu Context]` trong testData.
10. Expected Binding: chỉ outcome AC/BR/ERROR/VALIDATION/FLOW hiển thị UI — 1–3 assert observable.
11. Coverage gate: mọi FEATURES/FLOWS/BR/VALIDATION/AC/ERROR/(ACTORS RBAC)/EXECUTION_CONTEXT có UI_JOURNEY → ≥1 TC.
12. Anti-bloat (siết thừa): bỏ TC nếu (a) trùng trace, (b) cùng flow+expected, (c) restates TC khác, (d) không thêm assert mới, (e) BE_ONLY. SUMMARY/NFR/GAPS → không pad.
13. Lock: không đổi/bổ sung requirement ngoài Output.
14. AUTH WHO: `authRequired` · `authRole` (1 role) · multi → `roles:` + `multiRole: true`. Role CHỈ từ ACTORS/EXECUTION_CONTEXT.
15. FEATURE PATH (E2E_GROUNDING): TC sau login / không PUBLIC → `testData` BẮT BUỘC `path: /…` hoặc `featurePath: /…` từ FLOWS|API_UI|FEATURES — cấm invent. Login/Logout/PUBLIC: miễn.

Map: FEATURES→happy · FLOWS→journey · EXEC_CONTEXT/ACTORS→auth/permission · BR→rule UI · VALIDATION→EP/BVA · API_UI→entry · ERROR→negative · ACCEPTANCE→expected.
Cấm: type≠E2E · Unit/API thuần / BE_ONLY · duplicate journey · bịa role · pad số lượng · thiếu path: post-login.



