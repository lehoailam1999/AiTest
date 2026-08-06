## UNIT ← PHÂN TÍCH (ISTQB / ISO 29119-3) — nguồn #1 duy nhất
Knowledge / Freeze / «KẾT QUẢ PHÂN TÍCH ĐÃ LƯU DB» = SoT. SRS+source chỉ bổ sung tín hiệu đã có — không invent.
Mỗi TC: testData `trace: <TYPE>/<id|name>`. Bucket [] → bỏ qua.

Map (có item mới sinh TC):
- SUMMARY_SCOPE: khoanh scope — không sinh TC
- FEATURES: ≥1 happy/feature; module=name
- ACTORS: chỉ nhánh RBAC/logic service — role UI → E2E
- BUSINESS_FLOWS: logic trong steps → Unit; click UI → E2E
- BUSINESS_RULES: ≥1 TC/BR (Decision Table)
- VALIDATION_DATA: ≥1 EP/field+rule; có biên → BVA
- API_UI: method+path → handler/service; tên màn UI → E2E
- ERROR_HANDLING: ≥1 negative/exception
- ACCEPTANCE: chỉ AC không-UI; [] → không bịa
- NFR: chỉ đo được ở unit — còn lại bỏ
- GAPS: cấm pad TC

Cấm: bịa ngoài Phân tích · gộp nhiều tín hiệu/1 TC · type≠Unit · steps UI · SUT bootstrap.
