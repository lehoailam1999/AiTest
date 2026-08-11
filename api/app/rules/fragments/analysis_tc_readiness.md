## TC-readiness checklist (BABOK / IEEE 29148 — không lan man / không pad)
Mỗi bucket: không tín hiệu trong SRS → [] hoặc summary rỗng. Chính xác > số lượng. Item phải kiểm chứng được.
- SUMMARY_SCOPE: 2–5 câu Scope (in/out + actor) — cấm vision/marketing / «Hệ thống cho phép…».
- FEATURES: atomic FR từ FR-xx/Feature/hành vi; name=động từ+đối tượng; description có FR-id|path|field|status — cấm mục lục/Phạm vi/Mục tiêu/Endpoints/file›section/epic rỗng; cấm nút/input/field/widget đơn lẻ (→ validationRules); không có → [].
- ACTORS: 1 role/item đúng SRS; permissions = thao tác cụ thể — cấm bịa Admin/User/RBAC.
- BUSINESS_FLOWS: 1 UC = 1 MSS (Luồng chính) ≥2 bước; name≤8 từ + mermaid TD + steps 1.2. — cấm Exception/Alt/Luồng phụ/validation flow (→ exceptions|validationRules); không có Luồng chính → [].
- EXECUTION_CONTEXT: WHO cho scenario (actor/authRequired/roles/sessionHint) — cấm bịa role; không chọn cơ chế login.
- BUSINESS_RULES: 1 policy atomic must/shall gần nguyên văn — cấm «đảm bảo đúng đắn»; field → validationRules.
- VALIDATION_DATA: field + rule đo được + module; không pad; CẤM nhân bản thành useCase — thiếu field → bỏ.
- API_UI: 1 interface tường minh (method+path|UI entry) — cấm đoán /api/…; không có → [].
- ERROR_HANDLING: điều kiện + phản hồi quan sát được trong SRS — heading Exception Flow trống → [] (+ gap ngắn); cấm echo tiêu chí.
- ACCEPTANCE: chỉ GWT/Done-when/AC-n có outcome — không có → []; cấm heading trống / «dùng thành công».
- NFR_CONSTRAINTS: 1 NFR SMART (có ngưỡng) — cấm «bảo mật/hiệu năng tốt».
- GAPS: 1 thiếu sót chặn TC (TBD/«thiếu <key>») — cấm brainstorm hỏi mở.
Bridge Sinh TC: validation←validationRules+exceptions; RBAC←actors+executionContexts; flow/entry←useCases+apiSummary.
Bridge E2E codegen: WHO←executionContexts+actors; HOW←source/DOM/convention.
