# Unit Approve → Source Grounding → Sync MD

> **As-built** (khớp code hiện tại) + **roadmap** (5 lớp đề xuất).  
> Không coi roadmap là đã ship. Cursor/agent: pointer ngắn ở [`.cursor/rules/code-aliases-unit-gen.mdc`](../.cursor/rules/code-aliases-unit-gen.mdc).  
> Architect tổng thể (báo cáo): [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---
## 1. Hai pha (không gộp)

| Pha | Owner | SoT |
|-----|--------|-----|
| **Sinh Unit TC** | API LLM | Knowledge PRIMARY → TC IR (`unit_tc_analysis_*.md`) — **không** ghi `path:`/`code:` |
| **Approve grounding** | Desktop | Module → Function → Title → `index.db` → (optional body-rule / excerpt) → sync MD |

Sinh TC ≠ Approve. Sai `path`/`code` → sửa ranking Approve, không vá bằng product nouns trong SUT knobs.

---

## 2. Flow as-built (hiện tại)

```text
TC (DB) + Module/Function/Title
  → buildUnitApproveQuery (intent + preferTokens + CRUD cues)
  → CodeIndexSnapshot (index.db / in-memory snapshot)
  → retrieveUnitSources + logic-layer filter
  → moduleGate / feature-folder discover (fail-closed)
  → rank (CRUD verb, opPrefer, body-rule, …)
  → preferredCodeMarkerFromIndex → code: Type | Type.Method
  → expand related paths
  → confidence band (HIGH|MEDIUM|LOW)
  → validateUnitPrimaryBeforeWrite (index/symbol/CRUD/moduleGate)
  → checkIndexFileFreshness (contentHash vs disk; else skip)
  → writeBack? → markers path:/code:/related: → Sync MD
  → companion `{TC}.grounding.json` (Layer 5 contract)
```

**Fallback AI (đã có):** `pickFromShortlist` / `llm-shortlist` — chỉ khi deterministic fail-closed (ungated / ambiguous / soft). **Không** phải SoT implementation.

**Đã ship (partial):**

- Layer 1–4: symbol / confidence / validate / freshness (xem §7)  
- Layer 5: Source Grounding Contract JSON cạnh sync MD (`*.grounding.json`)

**Không có (chưa ship):**

- Method-level range **trong** sync-MD markers (chỉ trong index + contract JSON)  
- Gen IR dependency graph đầy đủ (Approve contract đã có `deps`)  

---

## 3. `index.db` / CodeIndex — schema thật

SoT types: [`desktop/src/lib/codeIndex/types.ts`](../desktop/src/lib/codeIndex/types.ts).

### Đã có

| Field | Where | Note |
|-------|--------|------|
| `pathRel` | `files`, symbols | Relative — **cấm** `D:/...` |
| `contentHash` | `FileIndexRecord` | Hash lúc index |
| `indexedAt` | `FileIndexRecord` | ISO time |
| `language` | `FileIndexRecord` / parse | `ts`/`tsx`/`js`/`jsx`/`cs` |
| `symbolsByFile[].name` | `IndexedSymbol` | Class / method / … |
| `symbolsByFile[].kind` | `SymbolKind` | class, method, function, … |
| `symbolsByFile[].parent` | optional | Parent type khi `kind=method` |
| `symbolsByFile[].line` | 1-based | Start line |
| `symbolsByFile[].endLine` | optional | **Layer 1** — inclusive end khi brace body biết; snapshot cũ có thể thiếu |
| `importsByFile` / `dependencyGraph` | snapshot | Import edges (chủ yếu TS; C# hạn chế) |
| `symbolIndex` | name → paths | Lookup |

### Spec đề xuất ≠ schema hiện tại

| Spec muốn | Thực tế |
|-----------|---------|
| `end_line` | **Có (optional)** trên `IndexedSymbol` — best-effort parser |
| `framework` | **Chưa có** trên index |
| `repo_revision` / git commit | **Chưa có** trên meta |
| `symbol` = `Class.Method` trong MD | `code:` = **Type** hoặc **Type.Method** khi method pick unambiguous (`preferredCodeMarkerFromIndex`) |
| JSON Grounding Contract | **Có (partial)** — `{testCaseId}.grounding.json` cạnh MD khi sync Approve |
| Method range trong MD markers | **Chưa** — `endLine` trong index + `.grounding.json` (không trong MD body) |

---

## 4. Markers sync MD (as-built)

```text
path: src/.../FooHandler.cs
code: FooHandler
# or: code: FooHandler.Handle  (Layer 1 — method unambiguous)
related: src/.../A.cs, src/.../B.cs
contract: TC-xxx.grounding.json
# auto-enriched from index.db (score=… ruleHits=… method=Handle confidence=HIGH writeBack=yes)
# MEDIUM example: … confidence=MEDIUM warning=soft-margin writeBack=yes
```

- `path` / `code` = primary SUT entry cho Gen (`code:` Type hoặc Type.Method).  
- `confidence` (Layer 2) = HIGH\|MEDIUM\|LOW trên resolve; LOW không sync markers.  
- `related` = deps mở rộng từ index/expand — **không** thay excerpt method body.  
- `contract:` (Layer 5) = companion JSON cạnh MD (`primary.line`/`endLine`, `related`, `deps`, `confidence`).  
- Gen Unit (IDE): đọc markers + FS SUT (+ optional `.grounding.json`); Cursor CLI sinh **test code**, không được coi là SoT implementation của production handler.

---

## 5. Rules bắt buộc (giữ nguyên)

```text
Module → Function → Title → index.db
Module Gate fail-closed
CRUD verb alignment (create|read|update|delete) — validate_reject ≠ create shape
Same-family Handler prefer; same-family score tie ≠ skip
No product hardcoding in AITest protocol
Optional: code-aliases.json / sutMap / domainGuards / unit-intent-rules.json
Empty SUT knobs vẫn Approve được nếu index đủ
```

Sai ranking → sửa `unitBodyRuleScore` / `resolveUnitPrimaryFromIndex` / `unit-intent-defs.json` — **không** invent product nouns vào SUT knobs.

---

## 6. Resolver priority (as-built → target)

| # | Tầng | As-built |
|---|------|----------|
| 1 | `index.db` deterministic | **Có** — primary path |
| 2 | Source FS exact read | **Partial** — `readExcerpt` cho body-rule; chưa freshness gate |
| 3 | IDE semantic resolver | **Partial** — bridge/caps khi Gen; Approve chủ yếu index |
| 4 | Cursor CLI / LLM shortlist | **Có** — fallback shortlist only |

Target: (1)+(2) HIGH → không gọi (4).

---

## 7. Roadmap 5 lớp (khớp kiến trúc hiện có)

Khi implement tiếp, **map vào types/files hiện có**, không invent parallel SoT:

| Lớp | Trạng thái | Hướng gắn code hiện tại |
|-----|------------|-------------------------|
| **1 Symbol-level** | **Partial ship** | `IndexedSymbol.endLine?`; `preferredCodeMarkerFromIndex` → `code:` Type\|Type.Method; **không** đổi path ranking / writeBack gates |
| **2 Confidence** | **Partial ship** | `mapUnitApproveConfidence` → `HIGH\|MEDIUM\|LOW`; MEDIUM write + `warning=soft-margin` trong MD; LOW = `writeBack=false` (`FAIL_CONFIDENCE_LOW`) |
| **3 Validate trước write** | **Partial ship** | `validateUnitPrimaryBeforeWrite` sau confidence: index file, moduleGate, CRUD/op verb, `code:` ∈ `symbolsByFile` (`parseCodeMarker`); excerpt optional khi caller truyền |
| **4 Freshness** | **Partial ship** | `checkIndexFileFreshness` — so `files[path].contentHash` vs hash disk (khi có `readDisk`/`readExcerpt`); mismatch → `STALE_INDEX` (không LLM fallback); placeholder hash (test snapshot) → skip |
| **5 Contract** | **Partial ship** | `buildUnitSourceGroundingContract` → companion `{TC}.grounding.json` cạnh MD khi sync; primary path/code/line/endLine + related + deps; MD có `contract:` pointer |

Acceptance cases (CRUD sibling, wrong domain, empty knobs, …) — nhiều case **đã cover** trong `unitResolve.test.ts` / `unitBodyRuleScore.test.ts`; contract emit = `unitSourceGroundingContract.test.ts`.

Layer 1 helpers: `desktop/src/lib/approvedTcSync/progressiveSeedFromCodeIndex.ts` (`parseCodeMarker`, `preferredCodeMarkerFromIndex`).

---

## 8. File SoT (đừng sửa nhầm)

| Việc | File |
|------|------|
| Approve resolve | `desktop/src/lib/unitResolve/resolveUnitPrimaryFromIndex.ts` |
| CRUD / body-rule | `packages/ide-protocol/src/unitBodyRuleScore.ts` |
| Confidence band | `packages/ide-protocol/src/unitApproveConfidence.ts` |
| Validate trước write | `desktop/src/lib/unitResolve/validateUnitPrimaryBeforeWrite.ts` |
| Freshness / STALE_INDEX | `desktop/src/lib/unitResolve/checkIndexFileFreshness.ts` |
| Grounding Contract | `desktop/src/lib/approvedTcSync/unitSourceGroundingContract.ts` |
| Intent cues | `packages/ide-protocol/src/defaults/unit-intent-defs.json` |
| Enrich + sync MD | `desktop/src/lib/approvedTcSync/enrichUnitMarkersFromIndex.ts` |
| `code:` Type\|Method | `desktop/src/lib/approvedTcSync/progressiveSeedFromCodeIndex.ts` (`preferredCodeMarkerFromIndex`) |
| Index schema | `desktop/src/lib/codeIndex/types.ts` |
| Agent pointer | `.cursor/rules/code-aliases-unit-gen.mdc` |
| Sinh TC (pha khác) | `api/app/rules/fragments/unit_tc_analysis_*.md` |

---

## 9. Tóm tắt lệch spec ↔ hệ thống

| Spec nói | Hệ thống hôm nay |
|----------|------------------|
| File→Class→Method→Deps contract | **Partial** — MD markers + companion `.grounding.json` (path/code/line/endLine/related/deps) |
| HIGH/MEDIUM/LOW | **Có** — `mapUnitApproveConfidence` + MD `confidence=` / `warning=soft-margin` |
| Validate rồi mới write | **Partial** — confidence + validate (L3) + freshness hash (L4 khi có reader) |
| index WHERE / FS WHAT | Index + optional disk hash; clip excerpt ≠ SoT freshness (dùng full-file `readDisk`) |
| Cursor chỉ fallback | Đúng hướng (`llm-shortlist`) |

Cập nhật doc này khi ship từng lớp roadmap — **không** ghi như đã xong trong `.mdc`.
