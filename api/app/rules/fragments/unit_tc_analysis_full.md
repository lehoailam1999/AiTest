## UNIT ← PHÂN TÍCH — UNIVERSAL Backend TC IR (ISTQB / ISO 29119-3)

**Phase = Test Case IR từ Knowledge/Freeze/DB.** Portable mọi tài liệu.  
**Không** cần source code để sinh TC. Source Retrieval + `path:`/`code:` = pha sau (Approve).

Knowledge/Freeze = SoT. **Không invent** BR / limit / permission / HTTP / exception / class / method.

---

### 0. Pipeline (không trộn pha)

```text
Knowledge PRIMARY buckets → Atomic Backend Behavior → Unit TC IR → Approve → Source Retrieval → Codegen
```

Generator **bảo toàn** `primaryBucket` từ Phân tích (BUSINESS_RULES | VALIDATION_DATA | ERROR_HANDLING | ACCEPTANCE).  
**Cấm** invent/rename/chuyển bucket.

---

### 1. Sáu gate (thứ tự)

**Rule 1 — Behavior Decomposition**  
Multi-behavior / multi-constraint → atomic BE **trước** Scope Gate (1 TC = 1 behavior).

**Rule 2 — Backend Outcome Gate (SRS-only)**  
Phân loại theo **outcome BE quan sát được trong Knowledge**, không theo keyword UI bề mặt.  
**Cấm** suy “không có BE” chỉ vì SRS viết từ góc UI.  
Ví dụ: «chỉ hiển thị vụ án được tham gia» → BE filter/authz (IN). «Nút mở File Explorer» → OUT.  
**IN** khi Knowledge mô tả constraint/decision/persist/reject/return/authz/state/calc/side-effect.  
**Không** bắt buộc source excerpt để IN.  
Sau classify: **IN** | **OUT** | **MIXED** (chỉ nhánh BE) | **UNKNOWN**.

**Rule 3 — UNKNOWN vs OUT**  
- UI-only chắc chắn → **OUT**  
- Có khả năng BE nhưng Knowledge **thiếu/cắt** → **UNKNOWN** (+ `unknownBehaviors`) — **cấm** UNKNOWN→OUT để giảm TC  
- Source excerpt (nếu có) chỉ **optional confirm** — thiếu excerpt ≠ OUT

**Rule 4 — Conflict Gate**  
Req mâu thuẫn → `conflicts` / GAPS. **Cấm** tự resolve / invent.

**Rule 5 — Implementation-free IR**  
TC mô tả **WHAT** phải test — **không** HOW (class/method/handler/repo/DTO/ORM/HTTP/exception/mock lib).  
`layerHint` / `sourceSignal` = **null** trừ khi Knowledge/excerpt **nói rõ**. **Cấm** suy `maxLength→dto`, `duplicate→repository`.

**Rule 6 — Coverage / Gap Detection**  
Sau classify: inventory tín hiệu IN (đặc biệt VALIDATION_DATA + FILE_DATA_SECURITY) ↔ TC.  
Mỗi IN → ≥1 TC **hoặc** gap. Cấm dừng sớm chỉ happy-path/BR.  
Output `coverage` + `gaps` + `unknownBehaviors` + `conflicts`.

---

### 2. PRIMARY (itemCount>0 → đánh giá; 0 TC hợp lệ nếu toàn OUT)

1. BUSINESS_RULES — decision/constraint/authz/state/calc BE  
2. VALIDATION_DATA — chỉ chiều criterion hỗ trợ (required/null/empty/blank/min/max/len/format/type/pattern/allowed/combo/duplicate/invalid-ref); EP/BVA khi có biên  
3. ERROR_HANDLING — reject/fail/recover/fallback **có trong** Knowledge  
4. ACCEPTANCE — AC outcome BE; UI-only AC → OUT  

Categories gắn thêm (A–I) khi hữu ích: Logic · Validation · Authz · Integrity · State · Server-processing · Error · Dependency · File/security.

---

### 3. Atomic + behaviorId + scenario

`behaviorId` = `<requirementId>-B<seq>` (vd. `BR-25-B04`) — 1 behavior / 1 TC.  
Scenario chỉ khi relevant: POSITIVE|NEGATIVE|BOUNDARY|NULL|EMPTY|BLANK|DUPLICATE|NOT_FOUND|AUTHORIZATION|INVALID_STATE|DEPENDENCY_FAILURE — **không** blind matrix.  
Dedup cùng BE across buckets → một TC, gộp `requirementIds`.

---

### 4. Output contract (JSON only)

Root: `testCases`, `coverage` (per PRIMARY: total/covered/missing), `gaps`, `unknownBehaviors`, `conflicts`.

Mỗi TC tối thiểu: `title`, `type=Unit`, `primaryBucket`, `scenario`, `trace.{requirementIds,behaviorId}`, `preconditions`, `testData.{input,target,existingState}`, `steps.{prepare,execute}`, `expectedResult.{type,observable,description}`, `testDataHints.{layerHint,sourceSignal}` (null nếu không biết), `status` READY_FOR_GROUNDING|NOT_READY.

`READY_FOR_GROUNDING` chỉ nghĩa là nội dung IR đủ để Approve tìm source. Pha sinh TC **cấm** phát `READY_FOR_CODEGEN`; chỉ Approve authoritative mới được phát trạng thái đó. `automationReady=false` ở pha này.

**Nguồn cover:** chỉ BUSINESS_RULES · VALIDATION_DATA · ERROR_HANDLING · ACCEPTANCE(BE).  
FEATURES = tên `module` — **cấm** pad TC từ FEATURES/FLOWS/useCases/UI.

**Approve-ready (bắt buộc — không invent class/method):**  
- `primaryBucket` + `behaviorId` + `requirementIds`  
- `target.scope`: `field` (một field), `multi` (invariant nhiều field), hoặc `aggregate` (toàn command/entity, không có một field đích).
- VALIDATION field/multi → `target.field` + `target.constraint` (+ boundary/value khi có); multi ghi đủ label, phân cách dấu phẩy.
- BUSINESS_RULE tổng thể/happy-path có nhiều input → `target.scope=aggregate`; không bịa `target.field` chung chung.
- `expectedResult.observable` ∈ create|update|query|validate|reject|persist|authz|state  
- Title VN: `[Feature] - [Hành động BE] - [Kết quả]` — động từ nghiệp vụ (tạo/cập nhật/từ chối/lọc/đọc/gán) — **cấm** Class.Method / click / điền form / màn hình.  
Steps/expected: ngôn ngữ nghiệp vụ BE — không class/repo/HTTP invent.

---

### 5. File / incomplete

File: chỉ chiều Knowledge nêu (format/size/…). Size chưa số → dùng «configured maximum» — **cấm** invent số.  
SRS cắt/TBD → `unknownBehaviors`, không TC phần thiếu.
