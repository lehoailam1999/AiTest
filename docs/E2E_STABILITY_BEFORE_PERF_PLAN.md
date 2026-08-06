# Plan: Ổn định E2E Job + Playwright (trước Performance Phase)

> **Ưu tiên:** Làm Gen + Inspect + Verify chạy ổn trên **mọi dự án** trước khi triển khai Job Builder / Snapshot / Worker Pool ([`CODEGEN_PERF_BATCH_SNAPSHOT_WORKER_PLAN.md`](CODEGEN_PERF_BATCH_SNAPSHOT_WORKER_PLAN.md)).  
> **Ngày:** 2026-08-06 (rev: portable / no product hardcode)  
> **Nguyên tắc:** chỉ heuristic theo **path shape + TC markers + FE/DOM evidence** — không nhúng tên module/route/testid của một app cụ thể vào runtime.  
> **Tiếp theo (convention đích):** [`TARGET_RULES_PROJECT_PROFILE_PLAN.md`](TARGET_RULES_PROJECT_PROFILE_PLAN.md) — Discover `.ai-test/project.profile.json` trên SUT rồi Gen theo profile.

---

## Nguyên tắc portable (bắt buộc khi implement)

| Được | Không được |
|------|------------|
| Exclude theo shape: `/support/fixtures/`, `*.fixture.ts`, `*.e2e.*`, `/playwright/`, generated `AItest/` | Exclude tên product (`Forensic`, `evidence`, …) |
| Rank: token overlap TC `module`/`title`/`path:` ↔ path segments FE | Boost cứng `/evidence/` hay penalty `/case-record/` |
| `featurePath` từ TC `path:` usable, FE `routerLink`, route catalog score | Invent `/admin/...` cố định theo app |
| `authRole` từ TC / Analysis `executionContexts` / project E2E settings | Default cứng `admin` nếu không có nguồn |
| Guard/heal theo phase Auth → Feature entry → Act | Hardcode label nút / testid app |

**Ví dụ Forensic trong log chỉ dùng để minh họa triệu chứng** (Phụ lục A) — không phải spec fix.

---

## 0. Kết luận nhanh

Các sửa gần đây (locator CSS OR, `field_*` ↔ formControlName, create/modal ranking, strip `path: [Thiếu Context]`) giúp **một lớp grounding**, nhưng batch Gen thực tế vẫn fail vì **4 lớp portable**:

| # | Lớp lỗi | Triệu chứng (mọi project) | Mức độ |
|---|---------|---------------------------|--------|
| A | Index/FE seed nhiễu hoặc lệch domain | Primary = test fixture / `*.service.ts`; FE folder không overlap token với TC module | **Pipeline bug** |
| B | Auth / Inspect = login wall | DOM password/login; Gen FE-only; contract trống khi FE nghèo | **Setup + pipeline** |
| C | Thiếu WHO trên TC | `ContextMissing: role/authRef` khi không có `authRole` / Analysis actor | **TC DoR + enrich có nguồn** |
| D | Journey order sau Gen | `Feature entry` / `Auth` sau Act dù đã heal | **Guard/heal** |

→ Ổn định S0–S5 trước Performance phases.

---

## 1. Phân loại lỗi (portable)

### 1.1 Index primary nhiễu (test/fixture thắng FE)

**Triệu chứng:** log `unsuitable primary=…/support/fixtures/*.ts` rồi fallback legacy.

**Nguyên nhân:** `isExcludedFromE2eRetrieve` hẹp hơn Unit (thiếu `/support/fixtures/`, `*.fixture.ts`, cây test E2E vendor).

**Hướng sửa (portable):** mở rộng exclude theo **shape**, áp mọi repo:

- `/support/fixtures/`, `/fixtures/` (kèm `storageState` / auth helper test)
- `*.fixture.ts|js`
- Path chứa `/\.e2e/` hoặc `*.e2e.` (Playwright project trees), `/playwright/`
- Generated: `/aitest/`, `/e2etest/`, `*.page.ts` dưới pages/_shared (đã có một phần)
- Chuẩn hóa absolute → relative trước khi exclude

Không cần tên monorepo hay product.

### 1.2 FE seed / featurePath lệch domain TC

**Triệu chứng:** TC thuộc domain A nhưng seed nằm folder domain B (token phụ trong title “kéo” file khác), hoặc route-catalog score thấp thắng FE đã rõ.

**Nguyên nhân:** rank token bag-of-words không ưu tiên **module / path hint**; service TS không HTML vẫn được seed.

**Hướng sửa (portable):**

1. **Token lock (không hardcode domain):**  
   - Lấy token từ `tc.module`, `path:`/`featurePath` usable, + top tokens title.  
   - Boost path segment match; **penalty** path không chia sẻ token module khi module có ≥1 token dài (≥3–4 ký tự).  
   - Nếu nhiều ứng viên cùng score → ưu tiên `.html` / `.component.html` / create|update|modal|form hơn `.service.ts`.
2. **FE quality gate:** primary phải có grounding hook (`data-cy|testid|formControlName|routerLink`) **hoặc** sibling template attach được — nếu không → thử candidate kế tiếp.
3. **Route catalog:** chỉ thắng khi score ≥ ngưỡng **và** không mâu thuẫn FE seed đã có absolute path mạnh hơn.

### 1.3 Inspect login wall → DOM cleared

**Triệu chứng chung:** Inspect ra form login; Gen FE-only; Verify sau fail auth.

**Hướng sửa (portable):**

- Không cache Inspect khi `loginWall=true` cho feature TC.  
- Taxonomy tách `AuthRequired` vs `LocatorNotFound`.  
- Gate UI: cần Auth Discover / credentials / storageState trước Gen feature TC (mọi app).

### 1.4 ContextMissing `role/authRef`

**Nguyên nhân:** gate `_validate_required_context` cần tín hiệu role trong auth hints; nhiều TC chỉ có placeholder path.

**Hướng sửa (portable):**

- Enrich `authRole` **chỉ khi có nguồn:** TC marker → Analysis `executionContexts`/`actors` → project E2E settings (user-configured).  
- Không invent role.  
- Message fail nêu rõ nguồn còn thiếu.

### 1.5 Journey order fail

Heal Auth → Feature entry → Act chưa cover mọi shape Spec. Sửa heal/reorder + test synthetic Spec — **không** phụ thuộc app.

---

## 2. Definition of Done (mọi dự án)

Đo trên **smoke set của project đang gắn** (10 TC Approved, đa dạng HappyPath/Validation), sau khi Auth + Target URL sẵn sàng:

| Gate | Tiêu chí portable |
|------|-------------------|
| G1 FE seed | ≥90% TC: primary path **chia sẻ token** với `module` hoặc `path:` usable; primary có FE hooks hoặc sibling HTML |
| G2 Index noise | 0 primary thuộc exclude shape (fixture / playwright test tree / generated POM) |
| G3 featurePath | 100% feature TC có `featurePath` usable (không placeholder); khớp FE `routerLink` hoặc catalog trên ngưỡng |
| G4 Auth Inspect | Khi có storageState/credentials hợp lệ → Inspect feature path **không** login-wall |
| G5 Gen | ≥80% Gen thành công trên smoke set đã thỏa G3+G4 + có role nguồn |
| G6 Journey | 0 fail `order: Auth/Feature/Act` trên fixture heal synthetic + smoke Spec |
| G7 Verify | Module Playwright chạy ổn (PASS/FAIL nghiệp vụ, có artifact; không crash env) |

Chỉ khi G1–G6 đạt mới mở Performance plan.

---

## 3. Plan phase (ổn định, portable)

### Phase S0 — Baseline taxonomy (0.5–1 ngày)

1. Đếm % fail: `index_noise | wrong_fe_domain | login_wall | missing_role | empty_contract | journey_order | locator | other`.  
2. Smoke set = 10 TC **của project hiện tại** (không cố định tên module).  
3. Ghi: Auth Discover / storageState / Target URL / provider.

**Exit:** bảng baseline + smoke IDs.

---

### Phase S1 — Index/FE exclude + domain lock bằng token — **ưu tiên #1** ✅ (implemented)

**Effort:** 1–2 ngày · **Status:** landed in `rankScore.ts` / `e2eRetriever.ts` / `resolveE2eFeSources.ts`

| # | Việc | File | Portable? |
|---|------|------|-----------|
| S1.1 | Mở rộng `isExcludedFromE2eRetrieve` theo shape (fixtures, `*.fixture.*`, e2e test trees, playwright) | `rankScore.ts` | Yes |
| S1.2 | Test exclude với path giả lập (`app.E2E/support/fixtures/auth.fixture.ts`, …) | `retrieval.phase3.test.ts` | Yes |
| S1.3 | Cùng rule trong `isLikelyFePath` / legacy resolve | `resolveE2eFeSources.ts` | Yes |
| S1.4 | Penalty `.service.ts` / backend-ish khi không có sibling template hooks | `e2ePathBonus` / `e2eFeRankBonus` | Yes |
| S1.5 | **Module–path token overlap** boost/penalty (từ `tc.module` + usable `path:`) | `e2eRetriever.ts`, `resolveE2eFeSources.ts` | Yes |
| S1.6 | FE quality gate + form-surface sibling (create/update/modal/form) theo action tokens trong title/steps (tạo/create/add/…) | `attachSiblingFeTemplates` | Yes |

**Exit:** không còn primary fixture; smoke seed overlap token với module/path.

---

### Phase S2 — featurePath + WHO enrich (có nguồn) ✅ (implemented)

**Effort:** 1–2 ngày · **Status:** landed — Desktop enrich → Gen body; portable catalog; clearer ContextMissing

| # | Việc | File | Portable? |
|---|------|------|-----------|
| S2.1 | Strip placeholder path + enrich `featurePath` từ FE/catalog — wire `testData` override vào Gen | `assertTcReadyForE2eGen.ts`, `e2eJobRunner.ts`, `generate_e2e.py` | Yes |
| S2.2 | Enrich `authRole` từ TC → Analysis actors → Auth Discover defaultRole | `deriveAuthContextFromTc.ts`, `e2eJobRunner.ts`, `E2ETestPage.tsx` | Yes |
| S2.3 | API: accept role từ `executionContext` / body `authRole` / enriched `testData`; message thiếu nguồn rõ | `e2e_codegen_guard.py`, `generate_e2e.py` | Yes |
| S2.4 | Route-catalog: bỏ synonym product; `MIN_MATCH_SCORE=3`; FE primary → `STRONG_CATALOG_SCORE=4` | `e2eRouteCatalog.ts` | Yes |
| S2.5 | *(Optional)* Tool “enrich TC DoR” trong Studio — deferred | Studio UI | Yes |

**Exit:** smoke không `ContextMissing: role/authRef` khi project/TC/Analysis đã có WHO.

---

### Phase S3 — Auth Inspect + Playwright ổn định ✅ (implemented)

**Effort:** 2–3 ngày (phụ thuộc môi trường SUT) · **Status:** landed — no login-wall cache; AuthRequired taxonomy; Verify wires storageState/role; Auth gate banner

| # | Việc | Portable? |
|---|------|-----------|
| S3.1 | Checklist: Auth Discover / credentials / storageState / Target URL | Yes (vận hành + gate) |
| S3.2 | Không cache Inspect `loginWall` cho feature TC | Yes — `inspectDomCache.ts` |
| S3.3 | Taxonomy `AuthRequired` tách khỏi locator | Yes — API + Desktop metrics |
| S3.4 | Verify module với `E2E_*` + storageState; headed 1 Spec | Yes — `e2eJobRunner` + `E2ETestPage` |
| S3.5 | Gate banner: điều kiện Auth trước Gen feature TC | Yes — soft gate + bypass |

**Exit:** Inspect feature path có landmark FE khi auth OK; Verify không crash env.

---

### Phase S4 — Journey heal / enforce ✅ (implemented)

**Effort:** 1–2 ngày · **Status:** landed — brace-safe nested steps; Auth-after-Act + Act-before-Entry heal; fail message includes 3 step titles

| # | Việc | File |
|---|------|------|
| S4.1 | Fixture Spec synthetic (Act trước Entry / Auth sau Act) | `test_e2e_phase2_journey.py` |
| S4.2 | Củng cố heal + reorder nested `test.step` | `e2e_journey_enforce.py`, `e2e_codegen_guard.py` |
| S4.3 | Fail message kèm 3 step titles | `validate_feature_journey_order` |

**Exit:** heal 100% fixture synthetic đã biết.

---

### Phase S5 — Smoke E2E Job (project đang gắn) ✅ (implemented)

**Status:** portable harness — pick 10 TC → sequential Gen → taxonomy → Verify ≤3 → G1–G7 report

| # | Việc | File |
|---|------|------|
| S5.1 | `pickE2eSmokeSet` đa dạng Happy/Validation/Auth | `e2eSmokeSet.ts` |
| S5.2 | `runE2eSmokeJob` Gen sequential + taxonomy + Verify subset | `e2eSmokeRunner.ts` |
| S5.3 | Evaluate gates G1–G7 + `reportText` | `e2eSmokeSet.ts` |
| S5.4 | UI: nút **S5 Smoke · 10 TC + taxonomy + Verify** | `E2ETestPage.tsx` |

**Cách chạy:** E2E Job → chọn Requirement (hoặc dùng pool Approved) → **S5 Smoke**. Xem gate tags + Log. Live G1–G7 phụ thuộc Auth + Target URL + SUT của project gắn.

**Exit:** G1–G6 PASS trên smoke set project → mới làm [`CODEGEN_PERF_BATCH_SNAPSHOT_WORKER_PLAN.md`](CODEGEN_PERF_BATCH_SNAPSHOT_WORKER_PLAN.md).
---

## 4. Việc thừa / sai cần siết (portable)

| Hạng mục | Hành động | Status |
|----------|-----------|--------|
| Primary fixture/test tree rồi unsuitable fallback | Exclude shape sớm (S1) | ✅ `isExcludedFromE2eRetrieve` |
| Seed lệch domain vì token phụ trong title | Token overlap module/path (S1.5) | ✅ `modulePathTokenBonus` / `extractDomainTokens` |
| Cache Inspect login-wall | Không cache (S3.2) | ✅ `inspectDomCache` skip `loginWall` |
| Fail-closed role khi thiếu nguồn | Enrich có nguồn + message rõ (S2) | ✅ authRole enrich + ContextMissing hint |
| Locator CSS OR / `field_*` bridge | Giữ (đã portable) | ✅ giữ |
| **R6 cấm heal giả** (generic `main\|nav\|h1` / metadata text) | Strip + fail `BusinessAssertionFailed`; không inject | ✅ `heal_missing_business_assertions` no-inject |
| **R9 syntax gate** trước Verify | Brace/paren Spec+POM | ✅ API `assert_e2e_ts_syntax_ok` + Desktop `e2eSyntaxGate` |
| Performance batch/worker | Block đến sau S5 | ⏳ harness S5 xong — **mở perf khi G1–G6 PASS trên smoke thật** |

---

## 5. Thứ tự triển khai

```text
S0 baseline (smoke set = project hiện tại)
  → S1 exclude shape + token overlap + FE quality gate
    → S2 path/WHO enrich từ nguồn có thật
      → S3 Auth Inspect cache + taxonomy
        → S4 Journey heal (synthetic)
          → S5 Smoke Gen + Verify
            → (ok) CODEGEN_PERF plan
```

---

## 6. Checklist PR (portable tests)

- [ ] Exclude: `*/support/fixtures/auth.fixture.ts`, `*/Something.E2E/**`, `*.e2e.ts` không bao giờ primary  
- [ ] Rank: TC `module=Orders` + title có từ phụ domain khác → vẫn ưu tiên path chứa `orders` nếu có ứng viên  
- [ ] Rank: `.service.ts` không hook thua `.component.html` cùng folder  
- [ ] Enrich: `path: [Thiếu Context]` + FE `routerLink='/x/y'` → `featurePath=/x/y`  
- [ ] Role: không invent; có Analysis actor → inject được  
- [ ] Inspect: login-wall không vào cache feature  
- [x] Journey: Act-before-Entry heal pass trên fixture generic  

---

## 7. Phạm vi không làm

- Job Builder / Context Snapshot / Worker Pool (file perf).  
- Hardcode route/testid/role/product name vào rules hoặc rank.  
- Script migration TC gắn một app (trừ tool Studio user-driven, portable).

---

## 8. Tóm tắt

Ổn định E2E = sửa **pipeline generic** (exclude shape, token overlap, auth cache, DoR có nguồn, journey heal) — dùng log một project chỉ để bắt bệnh, **không** biến tên folder/route của project đó thành luật hệ thống.

---

## Phụ lục A — Ví dụ triệu chứng (một project, không phải spec fix)

Log Gen trên app quản lý chứng cứ từng thấy:

- Primary `…/support/fixtures/auth.fixture.ts` → cần S1 exclude shape.  
- TC “tạo entity X” seed nhầm folder entity Y vì title nhắc quan hệ sang Y → cần S1.5 token overlap với **module**, không penalty cứng tên Y.  
- Login wall + thiếu `authRole:` → S3 + S2.

Các path cụ thể trong phụ lục **không** được copy vào code rank/exclude.
