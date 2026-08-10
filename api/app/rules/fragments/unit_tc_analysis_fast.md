## UNIT ← PHÂN TÍCH (SPEED)
SoT = Knowledge/Freeze/DB. Cover bucket itemCount>0 phía backend: FEATURES + mỗi BR (≥1; fail-branch) + mỗi VALIDATION (EP/+BVA) + ERROR + (API→handler, không HTTP-200-only) + (ACTORS/EXEC_CONTEXT authz) + AC không-UI.
`trace: TYPE/id|name` 1 tín hiệu/1 TC. []/GAPS → không invent/pad. type=Unit only.
SUT = handler/service/use-case/validator/domain; mock port/repo. CQRS→Handler/Service · MVC→service (không thin controller).
Cấm: form/popup/modal/wizard/Bước N/chuyển bước/enable-UI/page/component/click-fill · ClientApp/`*.component.*`/`*.page.*` → E2E hoặc bỏ.
Title VN: `[Feature] - [Hành động BE] - [Kết quả]` — cấm Latin Class.Method trong title. path:/code: khi Approve.
