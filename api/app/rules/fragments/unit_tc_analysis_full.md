## UNIT ← PHÂN TÍCH (ISTQB / ISO 29119-3) — nguồn #1 duy nhất
Knowledge / Freeze / DB = SoT. SRS+source chỉ bổ sung tín hiệu đã có — không invent.
Mỗi TC: `trace: TYPE/id|name` (1 tín hiệu/1 TC). Bucket [] → bỏ. Alias: ACTORS≡ACTORS_PERMISSIONS · NFR≡NFR_CONSTRAINTS · FLOWS≡BUSINESS_FLOWS.
Portable: không domain/framework sản phẩm — SUT từ Phân tích + source.

BACKEND only (mọi stack): business · service|use-case|handler · validation · domain · utility · authz · error · mock port/repo/gateway.
CQRS→Handler/Service · MVC→service (không thin controller) · Nest/TS BE→service/pipe (không FE).
Mock port — không Unit ORM/SQL trừ Knowledge nói rõ. `path:`/`code:` khuyến khích; Approve bổ sung. Cấm absolute/kebab SUT.
Symbol Latin chỉ trong `path:`/`code:` (Approve/index) — **cấm** ghi Class.Method vào title.

Cấm (→ E2E/bỏ): form/popup/modal/wizard/Bước N/Step N/page/component/chuyển bước/enable-UI · click/fill/navigate/toast · ClientApp/`*.component.*`/`*.page.*`/spa shell · thin HTTP client khi BR/validation · bootstrap · API smoke HTTP-200-only.

Coverage gate (itemCount>0 → ≥1 TC BE; thiếu lớp có tín hiệu = FAIL):
- SUMMARY_SCOPE: không TC
- FEATURES: ≥1 happy handler/service; UI-only → E2E
- ACTORS+EXECUTION_CONTEXT: authz service/handler allow(+deny)
- BUSINESS_FLOWS: logic → Unit; wizard/UI → E2E
- BUSINESS_RULES: mỗi BR ≥1; Decision Table = 1 tổ hợp/TC; fail-branch → negative
- VALIDATION_DATA: mỗi field+rule → EP (+BVA) trên input BE
- API_UI: → handler/service (không status-only); UI màn → E2E
- ERROR_HANDLING: mỗi lỗi BE → ≥1 negative
- ACCEPTANCE: AC không-UI only
- NFR: chỉ đo được unit BE
- GAPS: cấm pad/invent

Cấm: bịa · gộp nhiều tín hiệu/TC · type≠Unit · steps UI · pad GAPS.
Title: `[Feature] - [Hành động BE tiếng Việt] - [Kết quả]` — **cấm** Class.Method / Handler / Service Latin trong title.
