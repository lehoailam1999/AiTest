# AITest Unit Gen — Fix Plan (Cross-Project)

> SoT backlog để sửa **AITest engine / Desktop / Extension Gen**.
> Áp dụng cho **mọi dự án** (không hardcode Forensic).
> Nguồn: lỗi SUT mismatch (TC-007, TC-023, TC-076), review `unit-conventions.md`, TC-022 unresolved, log `.ai-test/logs/unit-gen-debug/`.

**Mục tiêu:** Resolve đúng SUT → Guard domain → Gate cứng → mới gọi AI CLI → Related đúng → Gen đúng stack → Smoke run được.

---

## 0. Nguyên tắc thiết kế

| Nguyên tắc | Ý nghĩa |
| --- | --- |
| Discover trước, Gen sau | Đọc `.ai-test/unit-conventions.md` + `.ai-test/project.profile.json` của **target repo** |
| Fail-closed | Thiếu marker / lệch domain / feature không có trong code → **không Gen** |
| Adapter theo project | Framework, output root, sutMap, domainGuards nằm trong **profile repo** |
| Gate trước CLI | Sai SUT thì **không gọi AI CLI** (tránh TC-007: unresolved vẫn Gen OrganizationUnit) |
| Không invent | Cấm BR / MaxLength / malware / allow-list tự bịa ngoài excerpt production |

---

## 1. Lỗi đã quan sát (root causes)

| Triệu chứng | Root cause AITest |
| --- | --- |
| TC vật chứng nhưng primary = `OrganizationUnitCreateCommandHandler` | Resolve theo token mơ hồ (`Create` / `Unit`); **không gate** khi unresolved |
| Related = FE `unit-type-color.pipe.ts` | Related expander không same-feature |
| Prompt ép *“only allowed primary SUT”* khi alignment thấp | Pack prompt bỏ qua fail-closed |
| TC malware trỏ `resumable-upload.service` | Auto-enrich fuzzy; thiếu logic-layer + feature-gap check |
| TC-022 `Resolved SUT = unresolved` | Đúng fail-closed; thiếu UI marker / sutMap fallback |
| Gen `.cs` chứa Jest/TS; assert giả | Thiếu stack gate + assertion contract + runnable DoD |

---

## 2. Project profile schema (mọi repo)

Bổ sung / chuẩn hóa `.ai-test/project.profile.json` → `unit`:

```json
{
  "unit": {
    "runner": "dotnet",
    "testFrameworks": ["xunit", "moq", "fluentassertions"],
    "outputRoot": "AItest/UnitTest",
    "requireMarkers": ["path", "code"],
    "minAlignment": 50,
    "sutMap": {
      "<ModuleName>": {
        "default": { "path": "<repo-relative>", "code": "<Symbol>" },
        "<scenarioKey>": { "path": "<repo-relative>", "code": "<Symbol>" }
      }
    },
    "domainGuards": [
      {
        "whenModuleMatches": "(?i)<domain-keywords>",
        "allowPathContains": ["<FeatureFolder>"],
        "denyPathContains": ["<UnrelatedFolders>"]
      }
    ],
    "relatedPolicy": {
      "maxFiles": 4,
      "sameFeatureOnly": true,
      "denyGlobs": [
        "**/ClientApp/**/pipe/**",
        "**/ClientApp/**/constant/**",
        "**/components/**"
      ]
    },
    "smoke": {
      "command": "",
      "timeoutMs": 120000
    }
  }
}
```

**AITest core chỉ đọc schema** — không nhúng path feature của một repo vào engine.

### Sample Forensic (điền trên target repo — không hardcode engine)

```json
"sutMap": {
  "Tạo mới vật chứng": {
    "default": {
      "path": "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      "code": "EvidenceCreateCommandHandler"
    },
    "duplicate-code": {
      "path": "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      "code": "EvidenceCreateCommandHandler"
    }
  }
},
"domainGuards": [
  {
    "whenModuleMatches": "(?i)vật chứng|evidence|thu giữ|lưu trữ",
    "allowPathContains": ["Evidence", "Upload", "StorageRoom", "evidence"],
    "denyPathContains": ["OrganizationUnit", "Account", "UserNotActivated", "Role", "Menu"]
  }
]
```

---

## 3. Pipeline Gen chuẩn (6 bước)

```text
Approve TC → Sync MD
  → A. Resolve SUT
  → B. Domain guard + alignment
  → C. Related closure (≤4)
  → D. Hard gate (block | gen)
  → E. Prompt AI CLI → write outputRoot
  → F. Smoke compile/run
```

### A. Resolve SUT

1. Test Data có `path:` + `code:` → verify file tồn tại + symbol có trong file.
2. Không có → `unit.sutMap[module][scenarioKey|default]`.
3. Không có → progressive index (`index.db` / ProjectFileIndex) với `minAlignment`.
4. Vẫn fail → `Resolved SUT = unresolved` + `FAIL_NEEDS_MARKER`.

**Marker format (Test Data):**

```text
path: src/.../SomeHandler.cs
code: SomeHandler
file: SomeHandler.cs
trace: BR-...; exception=...; errorKey=...; input=...
```

- `path:` **repo-relative** (cấm `D:/...`).
- `code:` **type/symbol** (cấm kebab filename stem).

### B. Domain guard

- So khớp module keywords với path tokens.
- Hit `denyPathContains` **hoặc** alignment `< minAlignment` → **block Gen**.
- Ví dụ cần chặn: module “vật chứng” + path `OrganizationUnit*`.

### C. Related files

- Lấy từ primary: Handler → Command/Query → port/DTO/exception liên quan rule.
- `sameFeatureOnly: true`.
- Áp `denyGlobs` từ profile.

### D. Hard gate trước CLI (P0 — bắt buộc)

| Điều kiện | Quyết định | Code |
| --- | --- | --- |
| `unresolved` | **Block** — không gọi CLI | `FAIL_NEEDS_MARKER` |
| domain guard fail | **Block** | `FAIL_DOMAIN_GUARD` |
| feature TC không có trong excerpt | **Block** | `FAIL_FEATURE_GAP` / `FAIL_SUT_MISMATCH` |
| alignment thấp | **Block** | `FAIL_SUT_MISMATCH` |
| pass | Pack prompt + Gen | — |

**Cấm** câu ép: *“this is the only allowed primary SUT”* khi unresolved / alignment thấp / domain fail.

### E. Prompt contract (portable)

1. `.ai-test/unit-conventions.md` (policy SoT)
2. Approved TC MD (chỉ TC đó)
3. Primary SUT excerpt + related ≤ 4
4. Output: **một** markdown fence — hoặc empty fence + một dòng refuse code
5. Assertion map từ Expected — **chỉ khi** có trong excerpt
6. Naming: `{Symbol}Tests_{shortId}.{ext}` — **cấm** `Sut.{hash}.test.cs`
7. Stack/extension match (`.cs` ≠ Jest/TS)

### F. Runnable DoD

- Emit đúng extension theo language/profile.
- Post-gen smoke: `unit.smoke.command` hoặc detect runner.
- Compile/run fail → `gen_needs_fix` (chưa Done).

---

## 4. Bổ sung `unit-conventions.md` (sync xuống mọi repo)

Đảm bảo conventions có:

1. Marker bắt buộc `path` + `code` trước Gen
2. Logic-layer allow-list
3. Related-files closure max 4, same-feature
4. Assertion contract (không assert generic)
5. Feature gap → refuse, không invent
6. Stack/extension fail-closed
7. Refuse codes: `FAIL_NEEDS_MARKER` | `FAIL_SUT_MISMATCH` | `FAIL_FEATURE_GAP` | `FAIL_DOMAIN_GUARD`
8. Runnable DoD + naming `{Symbol}Tests_{id}`

---

## 5. Backlog triển khai AITest

### P0 — Chặn Gen sai (làm trước)

- [x] Gate: `unresolved` ⇒ không gọi AI CLI *(Approve-intent Phase 5)*
- [x] Domain guard trước pack prompt *(decideUnitSutGate / aliases)*
- [x] Không ép primary SUT khi alignment thấp
- [x] Debug log: `alignmentScore`, `candidatesTop3`, `gateDecision`, `blockedReason`
- [x] Khi block: không ghi `primaryPath` lệch domain như Gen hợp lệ

### P1 — Resolve đúng trên mọi project

- [ ] Schema `unit.sutMap` + `domainGuards` + `relatedPolicy` trong profile *(một phần profile; UI sutMap còn mở)*
- [ ] UI Approve/Gen: unresolved → bắt điền marker hoặc chọn candidate
- [x] Scoring: phạt cross-feature; token chung không thắng body-rule class features
- [x] Auto-append `path/code` chỉ khi confident **và** intent-aligned *(+ body-rule)*
- [x] Verify `path` repo-relative + `code` là symbol thật

### P2 — Related + prompt

- [x] Related expander `sameFeatureOnly` + deny FE *(Approve-intent Phase 4)*
- [ ] Prompt preflight + assertion contract *(partial — conventions / guards)*
- [ ] `suggestedPath` = `{Symbol}Tests_{shortId}.{ext}`
- [ ] Refuse protocol thống nhất trong CLI response parser

### P3 — Chạy được

- [ ] Detect/emit test project refs theo profile
- [ ] Post-gen smoke run; fail → `gen_needs_fix`
- [ ] Sync template conventions + profile schema vào docs AITest

---

## 6. Debug log contract

Ghi `.ai-test/logs/unit-gen-debug/{TC}.md`:

```yaml
testCaseId: TC-xxx
module: ...
resolvedSut: path + code | unresolved
alignmentScore: number
candidatesTop3: [{ path, score, reason }]
domainGuard: pass | fail
gateDecision: gen | block
blockedReason: ...
relatedFiles: [...]
suggestedPath: ...
promptChars: ...
```

**Acceptance:** case giống TC-007 → `gateDecision=block`, không gửi `OrganizationUnit*` làm primary.

---

## 7. Definition of Done (portable)

- [ ] Đọc được `unit-conventions.md` + `project.profile.json` của target repo
- [ ] unresolved / mismatch / feature-gap → **block Gen**
- [ ] Có `path`+`code` hợp lệ **hoặc** hit `sutMap`
- [ ] Related ≤ 4, cùng feature
- [ ] CLI nhận đúng domain SUT
- [ ] Output đúng stack / extension / `outputRoot`
- [ ] Smoke runner chạy được (hoặc fail có status rõ)
- [ ] Không invent rule ngoài excerpt

---

## 8. Thứ tự sprint

1. **P0** gate + domain guard + debug log → hết lỗi kiểu TC-007  
2. **P1** profile schema + sutMap UI/marker  
3. **P2** related + prompt + naming  
4. **P3** post-gen compile/run + sync templates  

---

## 9. One-liner

**AITest = Resolve đúng → Guard domain → Gate cứng → mới gọi CLI → Related đúng → Gen đúng stack → Smoke run; cấu hình qua profile/conventions từng dự án — không hardcode một repo.**

---

## 10. Tham chiếu

| File | Vai trò |
| --- | --- |
| `.ai-test/unit-conventions.md` | Policy SoT trên target repo |
| `.ai-test/project.profile.json` | Adapter unit/E2E theo project |
| `.ai-test/unit-sut-marker-template.md` | Template marker cho author TC |
| `.ai-test/logs/unit-gen-debug/*.md` | Evidence lỗi resolve/gate |
| `.ai-test/test-cases/**/TC-*.md` | Approved TC MD sync |

---

## 11. Approve intent → body-rule resolve (Phases 0–6)

Pipeline portable (không hardcode Forensic). Map vào bước **A/C/D** ở §3:

```text
Approve
  → P1 extractUnitIntent (classes + rulePatterns + classFeatureTokens)
  → P2 filterUnitLogicLayerCandidates (deny FE; prefer Service/Handler)
  → P3 body-rule score (excerpt hits) → write path:/code: | skip note
  → P4 expandUnitRelatedPaths (≤4) → related:
  → Sync MD / Grounding
  → P5 Gen gate: thiếu path+code → FAIL_NEEDS_MARKER (không CLI)
```

| Phase | Vai trò | SoT / wire | Trạng thái |
| --- | --- | --- | --- |
| **0** | Gỡ wizard/FE/product primary hacks; giữ fail-closed | `progressiveSeed*`, `enrich*`, `tcSeedResolver`, `rankScore` | Done |
| **1** | Intent VI/EN → patterns/tokens | `packages/ide-protocol/src/unitIntentAliases.ts` → seed + enrich | Done |
| **2** | Logic-layer filter | `unitLogicLayerFilter.ts` → seed, enrich, Extension related | Done |
| **3** | Body-rule score + write-back | `unitBodyRuleScore.ts` + `enrichTcTestDataFromIndexAsync` | Done |
| **4** | Related ≤4 | `unitRelatedExpand.ts` → Test Data `related:` + Gen packet | Done |
| **5** | Gen needs markers | Desktop `decideUnitGenGate` / `assertTcReady*` / `unitJobRunner`; Extension early deny | Done |
| **6** | Docs + verify TC-092 | Section này + `scripts/verify-tc092-approve-resolve.mts` | Done |

### Map với pipeline Gen §3

| §3 bước | Approve phases |
| --- | --- |
| A Resolve SUT | P1 → P2 → P3 (+ soft-scope body-rule class tokens, không Evidence-only) |
| C Related | P4 |
| D Hard gate | P5 (`FAIL_NEEDS_MARKER` khi unresolved / skip note) |
| E/F Prompt + smoke | Ngoài scope Approve-intent (vẫn backlog §5 P2–P3) |

### Body-rule pool rule (P1∩P3 — critical)

Khi `requiresBodyRule`:

1. Primary pool = token của intent class **có** `requiresBodyRule` (vd. `upload_size_limit` → `Upload`/`InitUpload`), **không** lấy hết `upload_resource` Digital* hay alias `Evidence`.
2. Requirement/module chỉ soft-bonus qua `scorePath`.
3. Write-back chỉ khi excerpt có ≥1 `rulePatterns` hit + margin.

### Verify TC-092 (Forensic thật)

```bash
npx tsx scripts/verify-tc092-approve-resolve.mts D:/Xlab/Forensic/forensic
```

**Acceptance (đã xanh):** entry `UploadService.cs` / `UploadService`; `ruleHits` gồm MaxFileSize+FileSize+ArgumentException; related ≤4; không `resumable-upload` / pipe / component.

### Debt còn lại (không chặn P0–P6 Approve)

- Behavior TC vs anemic entity: demote `/Entities/` POCO; Gen floor alignment ≥50; reject without throw → FEATURE_GAP (2026-08).
- `upload_resource` domain nouns → SUT `.ai-test/code-aliases.json` (không hardcode product enum trong protocol).

- `upload_resource` vẫn có cue/`DIGITAL_EVIDENCE` mang mùi domain — nên đẩy sang `.ai-test/code-aliases.json` từng repo.
- Backlog §5 (sutMap UI, smoke run, conventions sync) vẫn mở — khác sprint Approve-intent.
- Cần Approve lại trên Desktop + reload Extension để Gen thấy marker mới.

<!-- aitest:fix-plan — backlog sửa AITest Unit Gen cross-project -->
