# AITest — Roadmap refactor Gen Unit + Playwright E2E (Index → Retrieve → Generate)

> **Mục tiêu sản phẩm:** Sinh Unit Test + Playwright E2E, phản hồi nhanh (target 2–5s khi warm/cache), scale project vài nghìn → hàng chục nghìn file, Desktop App + AI CLI.  
> **Nguyên tắc cốt lõi:** Index một lần → Retrieve nhiều lần → AI chỉ nhận đúng context → Generate → Validate → Cache.  
> **Phạm vi file này:** Kế hoạch triển khai theo phase/sprint, map vào code hiện tại, KPI, và thứ tự PR. Không thay SoT rule E2E (`api/app/llm/e2e_codegen_rules.py`).

---

## 0. Hiện trạng (baseline cần refactor)

| Lớp | Unit | E2E Playwright |
|-----|------|----------------|
| Entry API | `api/app/routers/generate_unit.py` | `api/app/routers/generate_e2e.py` |
| Orchestration | `api/app/services/unit_test_orchestrator.py` (+ LLM adapters) | Desktop: `desktop/src/lib/e2eWorkspace/e2eJobRunner.ts` |
| Context / nguồn FE | Workspace expand / heuristic | `resolveE2eFeSources.ts`, `inspectDomCache`, `derivePomScaffoldFromTc.ts` |
| Rules / guard | Prompt unit trong LLM layer | `e2e_codegen_rules.py`, `e2e_codegen_guard.py`, `e2e_journey_enforce.py` |
| Validate / heal | Compile/run hooks (từng phần) | Auto-heal loop trong `e2eJobRunner` |
| Requirement context | Freeze / Knowledge Studio (SRS) | Cùng Knowledge + TC analysis |

**Vấn đề cần giải:** Context còn heuristic/dump, thiếu Code Knowledge Index bền vững (`.ai-test/index.db`), retrieve chưa tách Unit vs E2E theo symbol/route/selector, cache chưa đủ tầng → cold path chậm, repo lớn dễ lệch context.

**Tách rõ 2 knowledge:**

1. **Requirement Knowledge** (SRS → Phân tích) — giữ pipeline hiện tại.  
2. **Code Knowledge Index** (AST/symbol/graph) — xây mới theo Phase 1–4 dưới đây; Business Retriever nối 2 nguồn khi gen.

---

## Phase 1 — Source Indexing (nền tảng)

**Mục tiêu:** Có Code Knowledge Base local, tìm đúng file/symbol &lt; 100 ms.

### 1.1 Deliverables

| # | Việc | Output / lưu trữ |
|---|------|------------------|
| P1.1 | Scan project (ignore `node_modules`, `dist`, `.git`, binaries) | File list + metadata |
| P1.2 | Parse AST (TypeScript/JS trước; Python sau) | Class, function, method, interface, enum, import/export, decorator |
| P1.3 | Build indexes | Symbol, Dependency (import), File hash/metadata |
| P1.4 | Incremental | File watcher **hoặc** content hash → chỉ re-index file đổi |
| P1.5 | Persist | `.ai-test/index.db` (SQLite) cạnh project target |

### 1.2 Vị trí code (đã ship MVP Phase 1)

```
desktop/src/lib/codeIndex/
  index.ts                 # public API
  scanProject.ts
  parseTsAst.ts            # lightweight-ts-js-v1 (regex structural; chưa tree-sitter)
  buildSymbolIndex.ts
  buildDependencyGraph.ts
  hashContent.ts
  incrementalSync.ts       # syncProjectIndex — chạy trên projectRoot
  indexStore.ts            # load/save
  lookup.ts                # lookupSymbol
  tauriIo.ts               # createTauriCodeIndexIo()
```

**Cách dùng trên project thật (Desktop Tauri):**

```ts
import { createTauriCodeIndexIo, syncProjectIndex, lookupSymbol } from "./lib/codeIndex";

const io = createTauriCodeIndexIo();
const { snapshot, elapsedMs, parsed, reused } = await syncProjectIndex(projectRoot, io);
const hits = lookupSymbol(snapshot, "OrderService");
// File: {projectRoot}/.ai-test/index.db  (JSON schema aitest-code-index-v1)
```

> Có — Phase 1 **xử lý trên project bạn mở** (`projectRoot`). Index nằm cạnh project, không đẩy cả repo lên Python API.

**Ghi chú format:** `.ai-test/index.db` hiện là **JSON document** (schema v1) để zero native deps; Sprint 1b có thể đổi sang SQLite/`rusqlite` giữ cùng API.

API Python **không** bắt buộc index toàn repo; Desktop index local, khi gen chỉ gửi **Top-K paths + excerpt** lên `/generate-unit` / `/generate-e2e`.

### 1.3 KPI Sprint 1

- Index lần đầu ~2.000 file TS/JS: &lt; 1 phút.  
- Lookup symbol/class → file: &lt; 100 ms.  
- Sửa vài file → sync: &lt; 2 s.

### 1.4 Out of scope Phase 1

Call graph sâu, Route/UI/Selector index (để Phase 4 / Sprint 4), embedding vector DB.

---

## Phase 2 — Test Planner

**Mục tiêu:** Từ Requirement + Test Case quyết định loại test và từ khóa retrieve.

### 2.1 Input / Output

```json
{
  "testType": "Unit | Integration | E2E | API",
  "module": "Order",
  "action": "CreateOrder",
  "keywords": ["Order", "Payment", "Inventory"],
  "hints": { "framework": "jest|vitest|pytest", "e2eStack": "playwright" }
}
```

### 2.2 Vị trí code (đã ship MVP Phase 2)

```
desktop/src/lib/testPlanner/
  types.ts
  analyzeIntent.ts       # heuristic classify + keywords + path
  planFromTestCase.ts    # → TestPlan roadmap shape
  index.ts
api/app/services/test_planner.py   # mirror cho gen server-side
```

**Cách dùng:**

```ts
import { planFromTestCase } from "./lib/testPlanner";

const plan = planFromTestCase(tc, {
  requirement: { title: reqTitle, featureNames: ["Order"], language: "TypeScript" },
});
// { testType, module, action, keywords, hints: { featurePath, e2eStack, framework, … } }
```

Tái sử dụng tín hiệu TC (`type`, `path:`, UI vs mock steps) — cùng hướng với FE path hint / unit analysis; Phase 3 retrieve sẽ consume `plan.keywords`.

### 2.3 KPI

≥ 90% TC map đúng `testType` trên bộ fixture nội bộ (Unit vs E2E) — covered by `testPlanner.phase2.test.ts` / `test_test_planner.py`.

---

## Phase 3 — Retrieval Engine

**Mục tiêu:** Top-K 5–10 file đúng ngữ cảnh từ Code Index + TestPlan.

### 3.1 Retrievers (đã ship MVP)

| Retriever | Lấy gì | Dùng cho |
|-----------|--------|----------|
| **UnitRetriever** | Index symbols + path unit-shaped + import deps | Gen Unit |
| **E2eRetriever** | Index + FE path bonus + `featurePath` | Gen E2E |
| **BusinessRetriever** | **TC-first** (expected/steps); Knowledge/freeze **optional** keyword filter | Cả hai — không re-parse SRS |

> Ý sản phẩm: TC đã sinh từ SRS là nguồn nghiệp vụ chính. BusinessRetriever không thay TC; chỉ bổ sung AC/rule từ Knowledge nếu caller truyền vào.

```
desktop/src/lib/retrieval/
  rankScore.ts
  unitRetriever.ts      # retrieveUnitSources
  e2eRetriever.ts       # retrieveE2eSources
  businessRetriever.ts  # retrieveBusinessContext (TC-first)
  retrieveForPlan.ts    # route by plan.testType
  index.ts
```

```ts
import { planFromTestCase } from "./lib/testPlanner";
import { retrieveForPlan } from "./lib/retrieval";

const plan = planFromTestCase(tc);
const { files, business } = retrieveForPlan(snapshot, plan, tc);
// files.files = Top-K pathRel + rankScore  (5–10)
// business.snippets = expected/steps (+ optional Knowledge)
```

`resolveE2eFeSources` vẫn dùng cho E2E runtime hiện tại; E2eRetriever là lớp index-first song song — wire vào `e2eJobRunner` ở Phase 4/5.

### 3.2 Ranking

`rankScore` = keyword ∩ path/symbol + `unitPathBonus` / `e2ePathBonus` + featurePath tokens + import proximity (Unit).

### 3.3 KPI

Top-K clamp **5–10**; fixture tests trong `retrieval.phase3.test.ts`.
---

## Phase 4 — Context Builder

**Mục tiêu:** Desktop đọc đúng Top-K source, build prompt mỏng, ổn định + **portable** gen.

### 4.1 Đã ship MVP

```
desktop/src/lib/contextBuilder/
  budgets.ts              # UNIT_INDEX_BUDGET / E2E_INDEX_BUDGET
  buildFromRetrieve.ts    # buildIndexBackedContext
  index.ts
```

Luồng: `planFromTestCase` → `retrieveForPlan` → đọc Top-K (budget) → `AITestContextPacket` + `e2eFe` bundle + dependency summary + TC business snippets.

**Wire:**
- Unit: `buildGenerateContext` ưu tiên index-backed packet (fallback IDE closure).
- E2E: `e2eJobRunner` ưu tiên `buildIndexBackedContext` (fallback `resolveE2eFeSources`).

### 4.2 Prompt shape

```text
Test Case (+ business from TC)
+ Top source files (budget)
+ Dependency summary
+ [E2E] FE seed / related (+ DOM riêng)
```

### 4.3 Portable rules (siết gen mọi dự án)

- Unit SoT: `uutgs_rules.py` §10 *Portable across ANY project*
- E2E SoT: `e2e_codegen_rules.py` §IV Rules 29–33
- Không hardcode product/route/credential; stack chỉ từ packet; layout `AItest/…`; fail-closed khi thiếu context.

### 4.4 Budget

- Unit ~36k total / primary 12k / related ×7  
- E2E ~28k / primary 10k / related ×5  

Test: `npm run test:context-builder` · `pytest tests/test_portable_codegen_rules.py`
---

## Phase 5 — AI Generator

**Mục tiêu:** CLI/LLM chỉ generate theo loại; input đã hẹp.

### 5.1 Unit

Generate: Mock → Arrange → Act → Assert (theo framework project).

Giữ route `POST /generate-unit`; body bổ sung (optional, legacy-safe):

```json
{
  "planner": { "...": "Phase 2" },
  "contextFiles": [{ "path": "...", "content": "..." }],
  "indexVersion": "..."
}
```

- [x] Desktop `buildIdeLocalGenerateBody` / `buildGenerateContext` gắn `planner` + `indexVersion` + `contextFiles`
- [x] API parse extras → `UnitRequest.planner_hint` (packet/workspace vẫn thắng)
- [x] Prompt AAA block khi có planner; không planner → hành vi cũ

### 5.2 Playwright

Generate: Fixture → Locator → Action → Assertion → Cleanup.

- [x] Giữ `POST /generate-e2e` + batch trong `e2eJobRunner`; không nhân đôi rule
- [x] Gắn `planner` / `indexVersion`; `featurePath` hint từ plan khi thiếu override
- [x] Prompt phase-5 block khi có planner; fallback FE resolve giữ nguyên

### 5.3 KPI Sprint 3 / 5

- Phần lớn Unit gen **compile** được vòng 0–1.  
- E2E: luồng chính chạy được (auth + happy path) trên project fixture.

Test: `pytest tests/test_phase5_gen_input.py` · `npm run test:phase5-gen`
---

## Phase 6 — Validation + Auto-fix

**Mục tiêu:** Run → lỗi có taxonomy → LLM fix có bounded retries.

| Loại | Run | Fix loop |
|------|-----|----------|
| Unit | compiler / test runner project | tối đa N lần (cap 5); chỉ gửi error + file test + Top-K |
| E2E | Playwright | tái sử dụng heal trong `e2eJobRunner` + taxonomy `ContextMissing` / `LocatorNotFound` / … (`AI_TEST_RULES.md`) |

**Không** infinite loop; metrics: `e2eFailureMetrics.ts` + `unitFailureMetrics.ts`.

- [x] `failure_taxonomy.py` — classify Unit + map E2E chuẩn  
- [x] Unit orchestrator: slim repair packet + `failureClass` trên `/unit-sandbox-repair`  
- [x] Desktop Auto-Repair: taxonomy trong progress; repair body Top-K (không re-expand full packet)  
- [x] E2E heal prompt gắn taxonomy; metrics map → AI_TEST_RULES  
- [x] Bounded retries (Desktop + API cap 5)

Test: `pytest tests/test_failure_taxonomy.py` · `npm run test:phase6-metrics`
---

## Phase 7 — Cache (đa tầng)

| Cache | Key gợi ý | Effect |
|-------|-----------|--------|
| Context Cache | `projectHash + planner + topK paths` | Bỏ đọc disk lặp |
| Prompt Cache | hash prompt canonical | Debug / dedupe |
| Embedding Cache | (optional, sau) chunk id | Rank semantic |
| LLM Response Cache | hash(prompt+model) | Warm path → gần tức thì |

Lưu dưới `.ai-test/cache/` (gitignore). KPI warm generate: tiến tới **2–5s** (phụ thuộc model/CLI).

> **Chi tiết triển khai tiếp theo (Job Builder + Context Snapshot + Worker Pool):**  
> [`CODEGEN_PERF_BATCH_SNAPSHOT_WORKER_PLAN.md`](CODEGEN_PERF_BATCH_SNAPSHOT_WORKER_PLAN.md)

---

## Roadmap sprint (thứ tự PR)

### Sprint 1 — Code Index Foundation (2–3 tuần)

- [x] `codeIndex` scan + TS/JS lightweight parse + symbol + import graph + hash  
- [x] `.ai-test/index.db` + incremental sync (`syncProjectIndex`)  
- [ ] CLI/UI: “Index project” + progress (wire vào Desktop)  
- [x] KPI lookup in-memory (unit test); đo &lt; 100 ms trên project lớn khi có UI  
- [ ] Sprint 1b: SQLite native + tree-sitter/ts createSourceFile  

**PR gợi ý:** `feat(code-index): phase1 symbol+import index` → `feat(ui): index project button`

### Sprint 2 — Retrieval + Planner (2 tuần)

- [x] `testPlanner` từ TC (`planFromTestCase` / `analyzeIntent`)  
- [x] `UnitRetriever` + ranking Top-K (`retrieveUnitSources`)  
- [x] `E2eRetriever` index-first (`retrieveE2eSources`; legacy `resolveE2eFeSources` giữ nguyên)  
- [x] BusinessRetriever **TC-first** (+ Knowledge optional)  

**PR:** `feat(retrieve): unit+e2e top-k from index` → wire gen ở Sprint 3/5

### Sprint 3 — Unit gen trên pipeline mới (2–3 tuần)

- [x] Context Builder Unit (index-backed)  
- [x] `buildGenerateContext` ưu tiên index packet  
- [x] Portable UUTGS §10  
- [x] Phase 5: planner/contextFiles trên `/generate-unit` (additive)  
- [x] Phase 6: compile/verify + auto-fix bounded + taxonomy  
- [ ] Bỏ hoàn toàn expand full workspace  

**PR:** `refactor(generate-unit): index-retrieve context only`

### Sprint 4 — UI & E2E Index (2 tuần)

- [ ] Route / Component / Selector (`data-testid`, `aria-*`, `id`) / API client index  
- [ ] Gắn vào E2eRetriever  
- [ ] KPI: TC E2E → đúng page + route + API  

**PR:** `feat(code-index): route+selector+api indexes`

### Sprint 5 — Playwright gen trên pipeline mới (2–3 tuần)

- [x] E2E Context via index retrieve trong `e2eJobRunner` (+ legacy fallback)  
- [x] Portable E2ECG §IV  
- [x] Phase 5: planner/indexVersion trên `/generate-e2e` (additive)  
- [x] Phase 6: heal bounded + taxonomy metrics  
- [ ] Run + heal đo lại KPI trên project fixture  

**PR:** `refactor(e2e): retrieve-first codegen path`

### Sprint 6 — Performance & Cache (liên tục)

- [ ] Context / LLM response cache  
- [ ] Parallel retrieve  
- [ ] Context compression (summary deps)  
- [ ] Đo cold vs warm; dashboard metrics nhẹ  

**PR:** `perf(codegen): multi-layer cache + budgets`

---

## Sơ đồ sau refactor

```text
Desktop: Open Project
    → Source Scanner → AST → Code Index (.ai-test/index.db)
                              ↑ incremental hash/watch
User: Gen Unit / E2E
    → Test Planner
    → Unit | E2E | Business Retriever (Top-K)
    → Context Builder (budget)
    → AI CLI / API (generate-unit | generate-e2e)
    → Compile/Run → Auto-fix (≤N)
    → Cache layers
```

---

## Kỳ vọng performance (không cam kết một % duy nhất)

| Bước | Sau Phase 1–3 + 7 |
|------|-------------------|
| Retrieve context | &lt; 100 ms |
| Sync vài file | &lt; 2 s |
| Cold generate | Thường cải ~20–50% wall-clock (prompt hẹp); vẫn phụ thuộc AI CLI |
| Warm / cache hit | Có thể 5–20×; target UX **2–5s** |
| Re-index full 2k file | &lt; 1 phút |

Chi tiết phân tích: trao đổi kiến trúc nội bộ; đo baseline trước Sprint 2 rồi cập nhật bảng số thật vào cuối file này.

---

## Definition of Done (toàn chương trình)

1. Gen Unit và E2E **không** phụ thuộc dump toàn repo.  
2. Mọi gen đi qua Planner → Retriever → Context Builder → LLM → Validate.  
3. Index incremental ổn định trên project ≥ 2k file.  
4. E2E rules vẫn **một SoT** (`e2e_codegen_rules.py`).  
5. Có metrics cold/warm + số vòng heal/fix.  
6. Document này và `SYSTEM_MASTER_DOCUMENTATION.md` được cập nhật khi ship Sprint 3 và 5.

---

## Việc không làm trong roadmap này

- Thay vector DB / pgvector cho code index (phase sau nếu cần semantic).  
- Gộp Requirement Knowledge builder vào cùng SQLite code index.  
- Viết lại toàn bộ UI Desktop ngoài chỗ wire Index / Gen.  
- Đổi taxonomy lỗi E2E đã chuẩn hóa.

---

*Owner: AITest platform · Cập nhật khi kết thúc mỗi Sprint (ngày + PR link).*

---

## Legacy cleanup

Xem [`CODEGEN_LEGACY_CLEANUP.md`](./CODEGEN_LEGACY_CLEANUP.md) — bảng KEEP / FALLBACK / REMOVE sau Phase 1–4.
