# AI Test Rules (Single SoT)

## Rule Index (Phase 0)

**Cursor/agent:** [`../.cursor/rules/rule-index.mdc`](../.cursor/rules/rule-index.mdc) — map chức năng → profile, checklist sửa rule.
Audit chi tiết để ở:
- [`RULE_INDEX_PLAN.md`](RULE_INDEX_PLAN.md)
- [`rule_inventory.csv`](rule_inventory.csv)
- [`rule_flow_matrix.csv`](rule_flow_matrix.csv)

**Target repo conventions (E2E):** [`TARGET_RULES_PROJECT_PROFILE_PLAN.md`](TARGET_RULES_PROJECT_PROFILE_PLAN.md) — tách Engine AITest vs `.ai-test/project.profile.json` trên SUT.

Phase 1 status:
- `api/app/rules/rule_registry.yaml` + loader đã có.
- Runtime đã wire `UUTGS` đọc từ registry (behavior giữ nguyên).
- MVP selective cho Unit sẵn sàng qua `AITEST_RULE_RETRIEVE_MODE=selective` (profile `PROFILE-UNIT-CODEGEN`).
- `E2ECG-FULL` đã có trong registry (`content_file`) và runtime đã đọc từ registry + fallback an toàn.
- Selective E2E chỉ bật khi thêm `AITEST_RULE_RETRIEVE_E2E=1`.
- Analysis rules (`ANALYSIS-TC-READINESS`, `ANALYSIS-CHAT-DIFF`) và TC-gen blocks đã migrate vào registry (fallback-safe).
- Phase 3 flags:
  - `AITEST_RULE_RETRIEVE_ANALYSIS=1` để bật selective profile cho Analysis rules.
  - `AITEST_RULE_RETRIEVE_TCGEN=1` để bật selective profile cho TC-gen blocks.
- Phase 3 observability:
  - Runtime inject logs có `rule_ids[]` theo profile ở các điểm Unit/E2E/Analysis/TC-gen.
  - Log format thống nhất: `RuleProfile apply profile=<...> mode=<...> ids=<rule_ids> chars=<n>`.
- Phase 4 status:
  - `.cursor/rules/*.mdc` chuyển sang pointer-only để tránh drift nội dung rule.
  - Khi `AITEST_RULE_RETRIEVE_MODE=selective`, selective profile mặc định ON cho Analysis/TC-gen/E2E.
  - Các biến `AITEST_RULE_RETRIEVE_ANALYSIS|TCGEN|E2E` giữ vai trò tắt cục bộ (`0/false/no/off`) khi cần rollback từng lớp.

### Rollout selective an toàn (khuyến nghị)

1. Bật `AITEST_RULE_RETRIEVE_MODE=selective`.
2. Bật theo lớp:
   - Analysis: `AITEST_RULE_RETRIEVE_ANALYSIS=1`
   - TC-gen: `AITEST_RULE_RETRIEVE_TCGEN=1`
   - E2E codegen: `AITEST_RULE_RETRIEVE_E2E=1`
3. Chạy smoke 5-10 job thật cho từng luồng (Analysis/TC-gen/Unit/E2E).
4. Quan sát log:
   - Có đủ `profile` và `ids` đúng domain.
   - `chars` giảm so với full mode.
5. Nếu có lỗi, rollback theo gate đơn lẻ (tắt đúng biến lỗi), không tắt toàn bộ selective.

### Mẫu truy vấn log (PowerShell)

```powershell
# theo dõi realtime
Get-Content .\api\logs\app.log -Wait | Select-String "RuleProfile apply profile="

# lọc theo E2E selective
Select-String -Path .\api\logs\app.log -Pattern "profile=PROFILE-E2E-CODEGEN"
```

---

## Requirement Studio — Phân tích (Knowledge)

**Một luồng, một chỗ sửa:**

| Bước | Module | Việc làm |
|------|--------|----------|
| Upload → `extracted_text` | `application.py` (`ingest_upload`) + `requirement_file_parse.py` | Parse file |
| Heuristic (sync) | `knowledge_builder.py` (`build_knowledge_heuristic`) | Regex, không LLM |
| Orchestration | `knowledge_pipeline.py` | `build_knowledge` → schedule `enrich_knowledge_background` |
| Enrich (oneshot CLI) | `knowledge_pipeline.py` + `enrich_cache.py` | 1 CLI, merge, disk cache |
| 12 bucket schema + fidelity | `knowledge_builder.py` (`ANALYSIS_CRITERIA_GUIDE`, `ANALYSIS_FIDELITY_RULES`) | SoT nội dung |
| LLM oneshot prompt | `knowledge_builder.py` (`knowledge_enrich_oneshot_system_prompt`, `build_enrich_oneshot_prompt`) | Runtime inject |
| Chat checklist / diff | `analysis_rules.py` | TC-readiness + knowledgeDiff |
| Persist analysis rows | `analysis_records.py` | 12 `RequirementAnalysisRecord` |
| Cursor dev narrative | `.cursor/rules/requirement-analysis.mdc` | Đồng bộ với `analysis_rules.py` |

Env: `AITEST_KNOWLEDGE_ENRICH_TIMEOUT_SEC` (mặc định = `AITEST_CURSOR_ONESHOT_TIMEOUT` = 360s).

---

File rule duy nhat cho runtime E2E:
- `api/app/llm/e2e_codegen_rules.py` (E2ECG Rules 1-27)

Tai lieu nay la pointer de team nho:
- Khong copy/duy tri bo rule trung lap o cac file khac.
- Khi doi rule, sua duy nhat `e2e_codegen_rules.py`.

## Enforcement runtime
- Prompt system: `api/app/llm/e2e_codegen_rules.py`
- Guard runtime: `api/app/services/e2e_codegen_guard.py`
- Journey check: `api/app/services/e2e_journey_enforce.py`
- TC ← Analysis: `api/app/llm/e2e_tc_analysis_rules.py`
- TC soft DoR annotate: `api/app/services/e2e_tc_dor_annotate.py`
- Desktop Gen DoR: `desktop/src/lib/e2eWorkspace/assertTcReadyForE2eGen.ts`

## Taxonomy loi chuan
### E2E (`AI_TEST_RULES` / E2ECG)
- `ContextMissing`
- `PreconditionFailed`
- `LocatorNotFound`
- `BusinessAssertionFailed`

### Unit (Phase 6)
- `CompileError` | `ImportError` | `AssertionFailed` | `RuntimeError` | `Timeout` | `Other`

Runtime: `api/app/services/failure_taxonomy.py` · Desktop `unitFailureMetrics.ts` / `e2eFailureMetrics.ts`.
Validate + auto-fix: bounded retries (max 5); repair packet = error + failing file + Top-K.

## E2E grounding (TC → FE → Playwright)
1. Resolve FE seed: Code Index retrieve (exclude `AItest/` POM; syncIfMissing on Gen) → fallback `resolveE2eFeSources`
2. `featurePath` from TC markers (`path|route|url|featurePath`) or single FE `routerLink` — never invent `/admin/...` without TC evidence; no Forensic noun path boost
3. Desktop DoR before Gen: post-login TC needs `path:` + (expectedOutcome | testData seed | actionable step) — else skip Gen
4. Desktop Inspect per TC; login-wall → fail-closed unless auth+FE hooks; `skipAutoInspect` on API
5. Locator contract from FE + live DOM (roles/labels/testid); empty contract → skip Gen
6. Guard Rule 23: ban invented `process.env.E2E_*` outside allowlist (BASE_URL/USERNAME/PASSWORD/STORAGE_STATE/LOGIN_PATH/ROLE/FEATURE_PATH/`E2E_<ROLE>_USERNAME|PASSWORD`); rewrite from TC testData when possible
7. Soft POM stubs fail-closed without Spec arg / DOM candidate
8. Heal re-inspects feature DOM when Gen cleared login-wall snapshot
9. Bind project root warms Code Index in background
10. Verify injects multi-role `E2E_<ROLE>_*` from `.ai-test/auth` (+ Desktop `roleCredentials` when provided)

## DoR tong quat (tham chieu)
Bo rule Day du (context, locator, precondition, data, assert, wait/retry, done criteria)
nam trong E2ECG Rules 20-27.
