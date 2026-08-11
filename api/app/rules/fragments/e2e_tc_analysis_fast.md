## E2E ← PHÂN TÍCH (gọn) — đủ cover, cấm thừa
SoT = Knowledge/Freeze/DB. Gate: FEATURES + (FLOWS|AC). type=E2E. `trace:` unique/TC.
Phân loại UI relevance: UI_JOURNEY (thao tác/outcome UI) → sinh TC; BE_ONLY (logic ngầm BE) → bỏ qua E2E.
Cover đủ item có tín hiệu UI: FLOWS · FEATURES · AUTH WHO · VALIDATION/BR · ERROR/permission.
Post-login: `path:`/`featurePath:` bắt buộc (E2E_GROUNDING). Login/PUBLIC miễn.
Step: `[Hành động]→[Element]→[Data]` — cấm step chỉ «kiểm tra» chung. Thiếu → `[Thiếu Context]`.
Số TC = số tín hiệu cần cover — không trần N. CẤM: pad · trùng trace · cùng expected+flow · SRS invent · BE_ONLY.
1 tín hiệu/TC · expected 1–3 assert UI · []/GAPS không invent.

