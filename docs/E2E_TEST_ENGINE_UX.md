# E2E Test Engine UX (Phase EX1–EX5)

| | |
|--|--|
| **Trạng thái** | Product SoT cho Automate E2E console (parity Unit U5) |
| **Ngày** | 2026-07-28 |
| **Liên quan** | [`E2E_TEST_ENGINE.md`](./E2E_TEST_ENGINE.md) · [`E2E_AI_TESTING_REQUIREMENTS.md`](../E2E_AI_TESTING_REQUIREMENTS.md) · [`UNIT_TEST_ENGINE_UX.md`](./UNIT_TEST_ENGINE_UX.md) · [`AITEST_OUTPUT_LAYOUT.md`](./AITEST_OUTPUT_LAYOUT.md) |

## North star

**SoT:** PostgreSQL (Approved TC `type=e2e`, workspace runs `test_type=e2e`, verify/reports, campaigns) + **AI CLI** generate / auto-heal selectors.  
**Desktop:** E2E Job Console — gắn project root + Target URL → **Chạy E2E Job** → Staging → Headless (+ Heal) → Artifacts → Apply `AItest/E2ETest/`.  
**Không cần IDE** trên E2E console — AI CLI + Playwright runner AITest.

## Phases đã ship

| Phase | Nội dung |
|-------|----------|
| **E0–E5** | Inspect · Generate POM/Spec · Env · Sandbox heal · Artifact sync |
| **XP0** | Windows spawn + Playwright check + cwd config |
| **R1** | TC type Unit/E2E tại Studio + deep-link CTA |
| **EX1** | Gate banner · pipeline strip · Files/Log/Artifacts tabs · empty Inspect |
| **EX2** | WorkspaceRun + Activity **E2E Jobs** + module campaign |
| **EX3** | Staging `.ai-test` → Apply confirm + path jail + cleanup |
| **EX4** | Batch Inspect 1× + Headless module · Playwright inspect · meta env · mở HTML report |
| **EX5** | Preview POM/Spec · Copy heal · docs UX SoT (IDE gỡ khỏi E2E) |

## Happy path

```text
TC Approved (e2e) → Project root + Target URL
  → [E2E Job] Sinh POM+Spec (Inspect cache nếu cần) → staging
  → [Verify] Playwright · Heal nếu FAIL
  → [Apply] AItest/E2ETest/ (chỉ sau PASS)
```

**UI đồng bộ Unit:** Steps Job → Verify → Apply · Radio Requirement/Single · primary 「Chạy E2E Job」 · Pause/Resume · card 「3. Verify & Apply」 (Kiểm thử / Heal / Áp dụng).

**Batch:** tất cả TC E2E Approved trong Requirement · bảng Generate|Verify|Apply + ghi chú tạm dừng · Verify được khi Generate pause.

## Console layout

**Page** [`E2ETestPage.tsx`](../desktop/src/features/e2e-test/E2ETestPage.tsx):

1. **Gate** — AI Ready · Source root · Target URL · FE probe ([`E2eGateBanner`](../desktop/src/features/e2e-test/E2eGateBanner.tsx))
2. **Env** — TC select · Target URL (+ Lưu meta) · Nâng cao (inspect Playwright · storageState · seed · teardown) · Batch module
3. **Pipeline** — Inspect → Generate → Headless → Heal → Artifacts → Apply ([`E2ePipelineStrip`](../desktop/src/features/e2e-test/E2ePipelineStrip.tsx))
4. **CTA** — từng bước: Inspect · Generate · Verify · Heal · Apply  
5. **Results** — [`E2eResultTabs`](../desktop/src/features/e2e-test/E2eResultTabs.tsx):
   - **Files:** list + read-only preview · Copy · Mở path
   - **Log:** theo phase hoặc full
   - **Artifacts:** HTML report / folder via OS

## EX5 — Polish checklist

| # | Việc | Status |
|---|------|--------|
| EX5.1 | Preview nội dung POM / Spec trong tab Files (read-only) | **Done** |
| EX5.2 | «Mở trong IDE» opt-in — đã gỡ khỏi E2E console (không cần IDE) | **Removed** |
| EX5.3 | Docs UX SoT (`docs/E2E_TEST_ENGINE_UX.md`) | **Done** |
| — | Copy heal chip khi PASS sau repair | **Done** |

## IDE

E2E console **không** dùng IDE bridge. AI CLI + Playwright runner AITest đủ cho Job.

## Không làm trong EX5 (Later)

- Visual baseline / viewport matrix  
- Live canvas highlight chuột  
- Cypress · Selenium adapters  
- Diff side-by-side POM vs Spec (có thể P1 sau)

## Mirror Unit

| Unit | E2E |
|------|-----|
| Chạy Unit Job | Chạy E2E Job |
| VerifyApplyConsole | Pipeline + Headless/Heal + Apply CTA |
| Coverage sync | Artifact sync |
| Apply AItest/UnitTest | Apply AItest/E2ETest |
| Batch Verify/Apply | Batch Generate/Headless (+ campaign) |
| IDE deprecated happy path | IDE opt-in (EX5.2) |
