QUY TẮC CHUNG UNIT (BẮT BUỘC — BACKEND ONLY, PORTABLE):
1. Bám Knowledge/Freeze — không domain/framework mẫu; bucket rỗng → không invent.
2. module = Feature; title VN `[Feature] - [Hành động BE] - [Kết quả]` — cấm Class.Method Latin · cấm form/popup/wizard/Bước/UI.
3. Steps: Arrange mock port → Act gọi SUT backend → Assert return/exception/side-effect (không click/fill/chuyển bước/enable-UI).
4. Mỗi tín hiệu backend độc lập → ≥1 TC (BR/VALIDATION/ERROR/authz); API→handler (không HTTP-200-only); không gộp; không pad UI-only/ClientApp.
5. Không gộp Unit+E2E. UI/wizard/form → không sinh trong phiên Unit. priority/severity thang Việt.
6. Self-check: còn FEATURES/BR/VALIDATION/ERROR/(authz) chưa cover → bổ sung; đủ → dừng.
