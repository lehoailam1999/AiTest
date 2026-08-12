## E2E ← PHÂN TÍCH — UNIVERSAL E2E Test Case Generator (ISTQB / ISO 29119-3)

**Phase = E2E Test Case IR từ Analysis Output (Output-driven).** Portable mọi tài liệu UI.  
**Không** đọc lại SRS thô hay source code FE/DOM ở pha này. Grounding (`path:`/`featurePath:`, `landmark:`, locators, Playwright code) = pha sau (Approve/Codegen).

Analysis Output = SoT (6 criteria). **Không invent** FR / flow / step / UI control / role / credential.

---

### 0. Pipeline (không trộn pha)

```text
Analysis Output (6 criteria)
        ↓
Behavior Extraction
        ↓
Atomic UI Journey
        ↓
Deduplication (cross-criteria)
        ↓
E2E Test Case IR
        ↓
Coverage Validation
        ↓
Approve → Grounding / Locator Discovery → Codegen
```

Generator **bảo toàn** `primaryCriterion` từ Phân tích. **Cấm** invent/rename/chuyển criterion.

---

### 1. Sáu gate (thứ tự)

**Rule 1 — Journey & Flow Decomposition**  
Multi-step / multi-branch user workflow → atomic UI journeys **trước** Scope Gate (1 TC = 1 user journey/flow scenario = 1 primary behavior).

**Rule 2 — UI Relevance Outcome Gate (Output-driven)**  
Phân loại theo **tín hiệu UI quan sát được trong Analysis Output**, không theo logic ngầm backend.  
- **UI_JOURNEY** (IN): Thao tác & outcome quan sát được trên UI (form input, click, navigation, validation message, toast, modal, redirect, UI state change).  
- **BE_ONLY** (OUT): Logic ngầm server/DB/cache không có tương tác hoặc hiển thị UI → bỏ qua E2E.  
- **MIXED**: Có cả BE & UI → chỉ lấy nhánh quan sát được qua UI (`UI_JOURNEY`).  
- **UNKNOWN**: Có khả năng có UI flow nhưng Analysis Output bị thiếu/cắt.  
Sau classify: **IN** (`UI_JOURNEY`) | **OUT** (`BE_ONLY`) | **MIXED** (chỉ nhánh UI) | **UNKNOWN**.

**Rule 3 — UNKNOWN vs OUT (Chống ép giảm TC)**  
- UI-only hoặc BE-only chắc chắn → **OUT**  
- Có UI journey nhưng Analysis Output **thiếu context/path/step** → **UNKNOWN** (+ `unknownBehaviors`) — **cấm** UNKNOWN→OUT để giảm TC. Đánh dấu `[Thiếu Context]` trong `testData` nếu vẫn tạo TC khung.  
- Route path thô (nếu thiếu) chỉ optional suggest — thiếu path ≠ OUT.

**Rule 4 — Conflict Gate**  
Req mâu thuẫn flow/quản lý quyền → `conflicts` / GAPS. **Cấm** tự resolve / invent.

**Rule 5 — Implementation-free & Grounding-decoupled IR**  
TC E2E mô tả **WHAT** trên UI — không HOW (không CSS/Playwright/credentials).  
`featurePath`/`path` = AbsolutePath ASCII từ Output (FLOWS/API_UI/FEATURES); thiếu → null/`[Thiếu Context]`.  
**Cấm** `baseURL`/`http://localhost` làm route; **cấm** invent path từ slug module/title VN; **cấm** invent malware/AV/toast nếu Output không nói.  
`landmark` = nhãn màn (không selector). Cấm invent HTTP status/error code/exact message/API/locator.

**Rule 6 — Coverage / Gap Detection & Anti-bloat Gate**  
Sau classify: inventory `UI_JOURNEY` ↔ TC (≥1 TC hoặc gap). Cấm dừng sớm chỉ happy-path.  
**Anti-bloat**: bỏ TC trùng `trace:` / cùng flow+expected / restates / không thêm assert UI / `BE_ONLY`.  
Coverage behavior-level: `totalBehaviors`/`coveredBehaviors`/`missingBehaviors`. Output `coverage`+`gaps`+`unknownBehaviors`+`conflicts`.

**Rule 7 — Assert modality & security**  
Expected chỉ toast/silent-filter/disable-submit khi Output nói. Upload: chỉ “định dạng không hợp lệ” nếu Output có; thiếu UX → `unknownBehaviors`/`gaps`.  
**Size/limit E2E**: chỉ assert “vượt dung lượng” khi Output (hoặc FE/BE cite trong Analysis) nêu rõ limit + UI message cho **đúng tầng upload** (vd. doc vs image). Không có → `gaps`/`FEATURE_GAP` — **cấm** invent assert lỗi size cho zone chỉ có mime filter.

**Rule 8 — Wizard**  
Output multi-step → steps concrete (`action`/`target`/`data`); cấm “điền thông tin cần thiết” / target `UI element` mơ hồ.

---

### 2. Sáu criteria (PRIMARY)

Mỗi TC PHẢI thuộc ít nhất 1 criterion. Ghi `primaryCriterion` (1 giá trị) + `criteria` (mảng tất cả criteria liên quan).

1. **BUSINESS_FLOWS** — Main/alt/exception user journeys (xương sống E2E). Khi nhiều criteria mô tả cùng 1 behavior → `BUSINESS_FLOWS` ưu tiên làm primary.
2. **ACCEPTANCE** — AC outcome hiển thị trên UI; UI-only AC. Verify observable outcome, không invent exact UI text.
3. **VALIDATION_DATA** — EP/BVA trên giao diện. Chỉ gen dimensions được Analysis Output hỗ trợ rõ ràng: Required, Empty, Blank, Null, Min, Max, Below Min, Above Max, Format, Type, Allowed Value, Duplicate, Invalid Reference. **Cấm** tự động gen full validation matrix — chỉ gen constraint có trong Analysis Output.
4. **BUSINESS_RULES** — Rule có observable application/UI outcome (show/hide, enable/disable, dynamic fields, auto-generate, reset, status transitions). Cấm gen rule chỉ là internal implementation.
5. **ACTORS_EXEC_CONTEXT** — RBAC & Permission (allow/deny UI elements/screens). Chỉ gen khi Analysis Output nêu rõ actor/role/permission. Cấm invent Admin/Manager/Officer/Role.
6. **ERROR_HANDLING** — Dynamic UI error handling, alert dialog, retry UI. Chỉ gen error có trong Analysis Output. Cấm invent HTTP 400/409, error code, exact message, toast content. Cấm invent malware/AV trừ khi Output mô tả.

---

### 3. Cross-criteria dedup (BẮT BUỘC)

Một business behavior CÓ THỂ xuất hiện ở nhiều criteria. Ví dụ:  
- `BUSINESS_RULES`: Không cho phép trùng mã  
- `ERROR_HANDLING`: Hiển thị lỗi khi mã đã tồn tại  
- `ACCEPTANCE`: Không tạo record  

→ Đây là **MỘT** E2E behavior. Chỉ sinh **MỘT** TC với:
```json
{
  "primaryCriterion": "BUSINESS_FLOWS",
  "criteria": ["BUSINESS_FLOWS", "BUSINESS_RULES", "ERROR_HANDLING", "ACCEPTANCE"]
}
```

Dedup bằng: **Business Intent + Condition + Observable Outcome** — không phải requirement ID.

---

### 4. ONE TC = ONE PRIMARY BEHAVIOR

Mỗi TC có đúng 1 primary intent. Tốt: "Duplicate code → reject creation". Xấu: "Create + Upload + Search + Change room + Check status" (trừ khi Analysis Output định nghĩa chúng là 1 inseparable Business Flow).

---

### 5. Atomic + journeyId + scenario + authContext

`journeyId` = `<requirementId>-J<seq>` (vd. `FLOW-01-J02`, `BR-05-J01`) — 1 journey / 1 TC.  
Scenario: `HAPPY_PATH` | `ALTERNATIVE_PATH` | `EXCEPTION_FLOW` | `UI_VALIDATION` | `PERMISSION_ALLOW` | `PERMISSION_DENY` | `BOUNDARY_UI` | `ERROR_UI`.  
`authContext`: `authRequired` (boolean), `authRole` (1 role duy nhất từ ACTORS/EXEC_CONTEXT), `multiRole` (boolean).  
Dedup cùng UI journey across criteria → một TC, gộp `criteria[]` + `requirementIds`.

---

### 6. Output contract (JSON only)

Root: `testCases`, `coverage` (per criterion: `totalBehaviors`/`coveredBehaviors`/`missingBehaviors`), `gaps`, `unknownBehaviors`, `conflicts`.

Mỗi TC:
```json
{
  "title": "[Feature] - [Thao tác UI] - [Kết quả quan sát được]",
  "type": "E2E",
  "primaryCriterion": "BUSINESS_FLOWS",
  "criteria": ["BUSINESS_FLOWS", "ACCEPTANCE"],
  "scenario": "HAPPY_PATH",
  "trace": {
    "requirementIds": ["FLOW-01", "AC-03"],
    "journeyId": "FLOW-01-J01",
    "behaviorId": "CREATE-EVIDENCE-SUCCESS"
  },
  "authContext": {
    "authRequired": true,
    "authRole": null,
    "multiRole": false
  },
  "featurePath": null,
  "preconditions": [],
  "testData": {
    "field": "",
    "value": "",
    "constraint": "",
    "boundary": null,
    "existingState": ""
  },
  "steps": [
    {"phase": "Prepare", "action": "", "target": "", "data": null},
    {"phase": "Execute", "action": "", "target": "", "data": null}
  ],
  "expectedResult": {
    "ui": [],
    "system": [],
    "data": []
  },
  "testDataHints": {"landmark": null, "sourceSignal": null},
  "status": "READY_FOR_GROUNDING"
}
```

Title VN: `[Feature] - [Thao tác UI] - [Kết quả quan sát được]`.  
Steps/expected: ngôn ngữ nghiệp vụ UI — không CSS selector / Playwright code invent.

---

### 7. Coverage output

```json
{
  "coverage": {
    "BUSINESS_FLOWS": {"totalBehaviors": 0, "coveredBehaviors": 0, "missingBehaviors": 0},
    "ACCEPTANCE": {"totalBehaviors": 0, "coveredBehaviors": 0, "missingBehaviors": 0},
    "VALIDATION_DATA": {"totalBehaviors": 0, "coveredBehaviors": 0, "missingBehaviors": 0},
    "BUSINESS_RULES": {"totalBehaviors": 0, "coveredBehaviors": 0, "missingBehaviors": 0},
    "ACTORS_EXEC_CONTEXT": {"totalBehaviors": 0, "coveredBehaviors": 0, "missingBehaviors": 0},
    "ERROR_HANDLING": {"totalBehaviors": 0, "coveredBehaviors": 0, "missingBehaviors": 0}
  }
}
```

---

### 8. Incomplete / Context Missing

Post-login TC thiếu path/context: `testData` có `featurePath: [Thiếu Context]` hoặc `unknownBehaviors`.  
Analysis Output cắt/TBD → `unknownBehaviors`, không TC phần thiếu.

---

### 9. Final Validation Checklist

Trước khi trả kết quả, kiểm tra:
- Mọi IN behavior đã có ≥1 TC
- Mọi TC có `requirementIds` + `journeyId` + `primaryCriterion`
- Duplicate behaviors đã merge (1 TC, gộp `criteria[]`)
- Main/alternative/exception flows đã có TC
- Validation dimensions chỉ gen khi Analysis Output hỗ trợ
- Authorization chỉ gen khi Analysis Output nêu rõ
- Expected results observable (không invent exact UI text/HTTP status/error message)
- Không gen implementation detail / source-code assumption / locator / route / API
