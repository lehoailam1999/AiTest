## E2E ← PHÂN TÍCH (SPEED) — Universal E2E TC IR (Output-driven)

SoT = Analysis Output (6 criteria). **PRIMARY** giữ nguyên criterion: BUSINESS_FLOWS · ACCEPTANCE · VALIDATION_DATA · BUSINESS_RULES · ACTORS_EXEC_CONTEXT · ERROR_HANDLING.  
**Pha này không đọc raw SRS / source code.** Grounding (`path:`/`landmark:`, locators, Playwright TS) = Approve/Codegen sau.

**6 gate:** (1) Atomic UI journey trước scope (1 TC = 1 primary behavior). (2) Outcome UI từ Analysis Output — UI_JOURNEY→IN, BE_ONLY→OUT, MIXED→nhánh UI, UNKNOWN→không invent. (3) BE_ONLY→OUT; thiếu Output→UNKNOWN (cấm UNKNOWN→OUT). (4) Conflict→conflicts/GAPS. (5) Implementation-free IR; cấm invent HTTP status/error code/locator/route. (6) Coverage & Anti-bloat: inventory IN↔TC; bỏ trùng trace/flow; coverage per behavior (`totalBehaviors`/`coveredBehaviors`/`missingBehaviors`).

**Cross-criteria dedup:** cùng behavior ở nhiều criteria → 1 TC, gộp `criteria[]`; `BUSINESS_FLOWS` ưu tiên primary.  
**VALIDATION_DATA:** chỉ gen dimensions có trong Output (Required/Empty/Blank/Null/Min/Max/Below Min/Above Max/Format/Type/Allowed Value/Duplicate/Invalid Reference). Cấm gen full validation matrix tự động.

`primaryCriterion` + `criteria[]`. `journeyId`=`<reqId>-J<seq>`. Scenario: HAPPY_PATH|ALTERNATIVE_PATH|EXCEPTION_FLOW|UI_VALIDATION|PERMISSION_ALLOW|PERMISSION_DENY|BOUNDARY_UI|ERROR_UI.  
`authContext`: authRequired, authRole, multiRole. Post-login: `featurePath` AbsolutePath từ Output (thiếu → `[Thiếu Context]`); **cấm** baseURL/localhost làm path; **cấm** invent malware/toast nếu Output không nói. Wizard → steps concrete.  
Title VN `[Feature] - [Thao tác UI] - [Kết quả quan sát được]`. Steps `[Hành động] → [Element] → [Data]`.  
JSON: testCases[] + coverage(per criterion: totalBehaviors/coveredBehaviors/missingBehaviors) + gaps + unknownBehaviors + conflicts.
