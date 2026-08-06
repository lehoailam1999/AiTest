# Plan: Codegen Performance — Job Builder · Context Snapshot · Worker Pool

> Mục tiêu: tăng tốc phản hồi AI khi sinh code Unit/E2E, đồng thời **giữ đúng đắn theo từng Test Case**.  
> Liên quan: [`CODEGEN_INDEX_RETRIEVE_ROADMAP.md`](CODEGEN_INDEX_RETRIEVE_ROADMAP.md) (Phase 7 Context Cache), [`CODEGEN_LEGACY_CLEANUP.md`](CODEGEN_LEGACY_CLEANUP.md).  
> **Prerequisite:** ổn định Gen/Inspect/Verify trước khi làm phase này — xem [`E2E_STABILITY_BEFORE_PERF_PLAN.md`](E2E_STABILITY_BEFORE_PERF_PLAN.md).

**Ngày lập:** 2026-08-06

---

## 1. Hiện trạng (baseline kiến trúc)

Unit/E2E codegen hiện tại:

```text
1 TC → 1 HTTP → 1 CLI oneshot (Cursor cold-start)
```

| Khía cạnh | Hiện tại |
|-----------|----------|
| Parallelism | Desktop `runPool` — Unit ×3, E2E ×3 (Cursor ×2) |
| Context | Index → Plan → Retrieve **mỗi TC** |
| Job Builder codegen | **Chưa có** (chỉ TC-gen fan-out trong `jobs.py`) |
| Context Snapshot cache | **Chưa có** (roadmap Phase 7 unchecked) |
| Worker pool cố định | **Chưa** — `CLISessionPool` chủ yếu interactive; Cursor forced oneshot |

### Unit codegen (map code)

| Stage | Module |
|-------|--------|
| Batch UI | `desktop/src/pages/GenerateUnitPage.tsx` (`UNIT_GEN_CONCURRENCY=3`) |
| Context | `ideLocalCommands` → `contextBuilder/buildFromRetrieve` |
| API | `api/app/routers/generate_unit.py` |
| CLI | `BaseCLIAdapter.generate_unit` — 1 call / TC |

### E2E codegen (map code)

| Stage | Module |
|-------|--------|
| Batch | `desktop/src/lib/e2eWorkspace/e2eJobRunner.ts` → `generateE2eBatch` |
| Per-TC | `generateE2eForTestCase` (index, FE, Inspect cache, locator contract, scaffold) |
| API | `api/app/routers/generate_e2e.py` |
| Guard | `e2e_codegen_guard.apply_e2e_codegen_guards` + `e2e_journey_enforce` |
| CLI | Cursor oneshot (thường 1–2 pass nếu có `pomScaffold`) |

### Sơ đồ hiện tại

```text
Desktop batch (runPool N)
  └─ for each TC (parallel ≤3 / ≤2 Cursor)
       ├─ Plan + Retrieve + read files   ← lặp mỗi TC
       ├─ [E2E] Inspect / locator / scaffold
       └─ HTTP POST /generate-{unit|e2e}
            └─ CLI oneshot
                 └─ parse + [E2E] guards → files của TC đó
```

### Ba việc ưu tiên (impact lớn nhất)

1. **Job Builder** — gom 5–10 TC cùng Service/Engine → giảm ~100 CLI calls xuống ~10–20.
2. **Context Snapshot** — sau index, snapshot theo Service/Class (hoặc FE surface) → tái sử dụng, không retrieve lại.
3. **Long-lived CLI + Worker Pool** — 3–5 worker phân phối job, tránh cold-start thrash.

**Thứ tự triển khai:** Snapshot → Job Builder → Worker Pool.

---

## 2. Mục tiêu đo được

| Metric | Baseline (Phase 0) | Đích |
|--------|-------------------|------|
| CLI calls / 100 TC | ~100–200 (E2E 2-pass) | ~10–25 |
| Time in retrieve+read | đo p50/p95 | ↓ ≥60% khi cache hit |
| Wall-clock gen 50 TC | đo | ↓ ≥50% |
| Pass rate guard / Verify | giữ ≥ hiện tại | không regress |

---

## 3. Phase 0 — Metrics baseline

**Effort:** 1–2 ngày · **Đổi hành vi:** không

### Việc cần làm

| Work | Module |
|------|--------|
| Instrument per-TC | Desktop: `e2eJobRunner.generateE2eForTestCase`, `GenerateUnitPage` — segments `retrieve \| inspect \| http \| cli \| guard` |
| API timings | `generate_unit.py` / `generate_e2e.py` + `BaseCLIAdapter._run_prompt` |
| Counters | `cliCalls`, `retrieveCalls`, `cacheHit`, `provider`, `concurrency`, `batchSize` |
| Aggregate | Extend `e2eFailureMetrics.ts` / `unitFailureMetrics.ts` (hoặc `*GenLatencyMetrics`) — thêm p50/p95 gen latency |
| Log | Optional: `aitest.codegen.metrics` JSON trên API |

### Exit criteria

Báo cáo % thời gian: retrieve vs CLI cold-start vs inspect.

---

## 4. Phase 1 — Context Snapshot Cache

**Effort:** 3–5 ngày · **Risk:** thấp · **Win:** giảm retrieve/IO mạnh

### Ý tưởng

Sau index, tạo snapshot theo SUT/FE surface; mọi TC cùng service **load snapshot**, không retrieve lại.

```text
Incremental Index (.ai-test/index.db)
        │
        ▼
Context Snapshot Cache   ← NEW
  key = project + indexVersion + testType + (class | featurePath)
  value = budgeted packet (SUT + deps + convention)
        │
        ▼
Per-TC overlay (steps, locatorContract, auth)  ← vẫn riêng từng TC
```

### Map vào codebase

| Mới | Gắn vào |
|-----|---------|
| `desktop/src/lib/contextBuilder/contextSnapshotCache.ts` | Persist `.ai-test/cache/context/` (align roadmap Phase 7) |
| Wire Unit | `ideLocalCommands.buildGenerateContext` / `buildIndexBackedContext` — load index **1 lần/batch** |
| Wire E2E | `generateE2eForTestCase` — share `CodeIndexSnapshot`; cache FE packet theo `featurePath` + primary FE |
| API optional | Desktop gửi cached `contextFiles` / `contextSnapshotId` (đã có hook Phase 5) |
| Invalidate | `syncProjectIndex` đổi `indexVersion` / content hash |

### Grain (bắt buộc)

| Loại | Key snapshot |
|------|----------------|
| Unit | `primarySutPath` / class |
| E2E | `featurePath` + primary FE component (**không** gom cả module nếu khác route) |

- DOM Inspect giữ `inspectDomCache` hiện có — **không** nhét vào snapshot source.
- Snapshot = **source evidence chung** only.

### Correctness

- Mỗi TC vẫn gắn: steps, expected, `locatorContract`, `authRole`, `featurePath`.
- Không cache DOM sang route khác.
- Miss cache → fallback retrieve như hôm nay.

---

## 5. Phase 2 — Job Builder (batch codegen)

**Effort:** Unit 5–8 ngày + E2E 5–8 ngày · **Risk:** trung bình → cao (E2E) · **Win:** giảm CLI calls mạnh

### Ý tưởng

Gom 5–10 TC **cùng context snapshot** → **1 CLI call** → structured blocks → split → **guard per TC** → merge.

```text
Approved TCs
    │
    ▼
Job Builder (NEW)
  Unit: group by (packagePrefix, primaryRel)
  E2E:  group by (featurePath, authRole, storageStateRel)
  batchSize: 5–8 (Cursor lean 3–5)
    │
    ▼
1 prompt = Shared context + N × ### TC id=<uuid>
    │
    ▼
Parse → map files → testCaseId
    │
    ▼
Per-TC: apply_e2e_codegen_guards / UUTGS checks
    │
    ▼
mergeFiles (E2E POM) như hôm nay
```

### Map vào codebase

| Mới | Gắn vào |
|-----|---------|
| `desktop/src/lib/unitWorkspace/codegenJobBuilder.ts` | `GenerateUnitPage` thay `runPool` 1-1 |
| `desktop/src/lib/e2eWorkspace/codegenJobBuilder.ts` | `generateE2eBatch` |
| API batch body | `generate_unit` / `generate_e2e`: `items[{ testCaseId, … }]` + shared `contextFiles` |
| Prompt contract | `unit_user_prompt` / `e2e_user_prompt` — section `### TC id=` + FILE tagged `testCaseId` |
| Split + guard | Parse → ownership → **guard per TC** → `mergeFiles` |
| Env | `AITEST_CODEGEN_BATCH_SIZE` (mirror `tc_speed` fan-out) |
| Fallback | Parse fail → retry oneshot từng TC |

### Không reuse mù quáng

- **Không** dùng `api/app/routers/jobs.py` TC-gen fan-out làm codegen Job Builder (artifact khác: TC draft ≠ code files).
- **Không** nhét 100 TC vào 1 prompt.

### Unit vs E2E batching grain

| | Unit | E2E |
|--|------|-----|
| Batch grain | Service / class | Route + role |
| Size | 5–10 | 3–6 |
| Risk chính | Tên test trùng | Locator / journey bleed |
| 2-pass scaffold | N/A | Phase 2a: cùng POM surface (shared page 1 lần + N specs); nếu khó → batch Unit trước |

### Correctness (bắt buộc)

1. **Shared block:** SUT / FE / stack / POM surface  
2. **Per-TC blocks:** steps, expected, locator contract, journey markers, auth  
3. **Guard per TC** sau split (`apply_e2e_codegen_guards` + `e2e_journey_enforce`) — không guard cả batch một lần  
4. Không batch login TC với feature TC  
5. Partial fail: TC OK giữ file; TC fail retry solo  
6. Locator contract / `featurePath` fail-closed vẫn theo từng TC  

### Đề xuất thứ tự Phase 2

1. **2a — Job Builder Unit** (đúngness dễ kiểm soát hơn)  
2. **2b — Job Builder E2E** (sau khi split/guard đã ổn định)

---

## 6. Phase 3 — Long-lived CLI + Worker Pool

**Effort:** 3–5 ngày · **Risk:** trung bình · **Win:** khuếch đại Phase 1–2 (giảm cold-start contention)

### Ý tưởng

Với Cursor (oneshot bắt buộc): **pool 3–5 slot** queue job — không phải “1 chat dùng chung mọi project”.

```text
Desktop submit jobs
        │
        ▼
API Worker Pool (NEW)  N=3..5
  ┌─────┬─────┬─────┐
  │ W1  │ W2  │ W3  │  ← queue + fair per-project
  └─────┴─────┴─────┘
        │
   Cursor: oneshot slot (empty workspace — giữ isolation)
   Other CLI: reuse CLISessionPool interactive
```

### Map vào codebase

| Mới | Gắn vào |
|-----|---------|
| `api/app/llm/cli/worker_pool.py` | Wrap/extend `CLISessionPool` + `process_runner` |
| Config | `AITEST_CLI_WORKERS=3..5` |
| Desktop | `runPool` concurrency ≤ worker N (hoặc 1 API “submit batch”) |
| Metrics | `queueWaitMs` từ Phase 0 |

### Correctness / isolation

- Không share Cursor interactive session cross-project.
- Giữ empty-workspace oneshot (không ghi product source).
- Backpressure: UI không oversubscribe hơn N.

### Lưu ý

`CLISessionPool` hiện tại **không** đủ coi là xong Phase 3 với Cursor — Cursor vẫn forced oneshot; worker = **slot/queue**, không phải resume-chat đa TC.

---

## 7. Luồng đích (sau đủ 3 phase)

```text
                     Source Code
                          │
                   Incremental Index
                          │
         ┌────────────────┼────────────────┐
         ▼                ▼                ▼
    File Index      Symbol Index    Dependency Graph
                          │
                          ▼
                 Context Snapshot Cache
                          │
─────────────────────────────────────────────────────
                  Approved Test Cases
                          │
                          ▼
               Mapping (Service/Method | Route+Role)
                          │
                          ▼
                    Job Builder
          (1 Job = 1 Service/Surface + 5~10 TC)
                          │
                          ▼
                Context Builder
          (Load Snapshot, không Retrieve lại)
                          │
                          ▼
               Cursor Worker Pool
             (3~5 Long-lived / queued slots)
                          │
                          ▼
              Structured Test Blocks
                 (tagged testCaseId)
                          │
                          ▼
         Split → Guard per TC → Merge → Compile → Retry
```

---

## 8. Lịch & phụ thuộc

```text
Phase 0 metrics
    → Phase 1 Context Snapshot   (win lớn, risk thấp)
        → Phase 2a Job Builder Unit
            → Phase 2b Job Builder E2E
                → Phase 3 Worker Pool
```

| Phase | Effort | Win | Risk |
|-------|--------|-----|------|
| 0 Metrics | 1–2d | đo được | thấp |
| 1 Snapshot | 3–5d | ↓ retrieve/IO | thấp |
| 2a Job Builder Unit | 5–8d | ↓ CLI calls | trung bình |
| 2b Job Builder E2E | 5–8d | ↓ CLI E2E | cao hơn (locator) |
| 3 Worker Pool | 3–5d | ↓ cold-start thrash | trung bình |

---

## 9. Checklist đúng đắn (gate trước merge mỗi phase)

- [ ] Locator contract vẫn **per TC** vào guard  
- [ ] Journey / `featurePath` fail-closed per TC  
- [ ] Auth role / storageState không chéo trong batch group  
- [ ] E2E: `apply_e2e_codegen_guards` + `e2e_journey_enforce` **sau split**, trước merge  
- [ ] Unit: UUTGS isolation + unique test names dưới `AItest/UnitTest/...`  
- [ ] Partial batch failure: TC OK giữ file; TC fail retry solo  
- [ ] Snapshot invalidate đúng khi `indexVersion` đổi  
- [ ] Regression tests:  
  - `api/tests/test_e2e_codegen_guard.py`  
  - `api/tests/test_phase5_gen_input.py`  
  - batch-split tests (mới)  
  - desktop job builder / snapshot cache tests (mới)

---

## 10. Việc không làm

- Không coi `CLISessionPool` = xong Worker Pool cho Cursor.  
- Không cache Inspect DOM across `featurePath`.  
- Không nhét toàn bộ suite vào 1 prompt.  
- Không dùng `jobs.py` TC fan-out làm codegen Job Builder.  
- Không hy sinh guard fail-closed để “cho gen qua”.

---

## 11. Gợi ý bước tiếp theo

1. Implement **Phase 0 + Phase 1** (ít đụng correctness).  
2. **Job Builder Unit (2a)**.  
3. **Job Builder E2E (2b)** khi split/guard đã ổn.  
4. **Worker Pool** để khuếch đại throughput.

---

## 12. Tham chiếu module chính

| Concern | Path |
|---------|------|
| E2E batch runner | `desktop/src/lib/e2eWorkspace/e2eJobRunner.ts` |
| Unit gen UI | `desktop/src/pages/GenerateUnitPage.tsx` |
| Context builder | `desktop/src/lib/contextBuilder/` |
| Retrieval | `desktop/src/lib/retrieval/` |
| Code index | `desktop/src/lib/codeIndex/` |
| Test planner | `desktop/src/lib/testPlanner/` (+ `api/app/services/test_planner.py`) |
| E2E API | `api/app/routers/generate_e2e.py` |
| Unit API | `api/app/routers/generate_unit.py` |
| CLI adapters | `api/app/llm/cli/adapters/` |
| Session pool | `api/app/llm/cli/session_pool.py` (hiện có) |
| E2E guards | `api/app/services/e2e_codegen_guard.py` |
| TC-gen fan-out (tham khảo pattern, không reuse trực tiếp) | `api/app/routers/jobs.py`, `api/app/llm/tc_speed.py` |
