# E2E Test Engine (Phase E0–E5)

| | |
|--|--|
| **Trạng thái** | Product SoT cho Automate E2E (Playwright TS MVP) |
| **Ngày** | 2026-07-28 |
| **Liên quan** | [`E2E_TESTING_AI_CLI_PLAN.md`](../E2E_TESTING_AI_CLI_PLAN.md) · [`UNIT_TEST_ENGINE_UX.md`](./UNIT_TEST_ENGINE_UX.md) · [`E2E_TEST_ENGINE_UX.md`](./E2E_TEST_ENGINE_UX.md) · [`AITEST_OUTPUT_LAYOUT.md`](./AITEST_OUTPUT_LAYOUT.md) · [`E2E_AI_TESTING_REQUIREMENTS.md`](../E2E_AI_TESTING_REQUIREMENTS.md) (phân loại TC + UX) |

## North star

**SoT:** PostgreSQL (Approved TC `type=e2e`, workspace runs `test_type=e2e`, verify/reports) + **AI CLI** generate / auto-heal selectors.  
**Desktop:** gắn project root + Target URL → **Chạy E2E Job** → Staging → Headless Verify (+ Auto-Heal) → Artifact sync → Apply `AItest/E2ETest/`.  
**Framework MVP:** Playwright TypeScript only.

## Happy path

```text
TC Approved (e2e) → Project root + Target URL → Chạy E2E Job (AI CLI)
  → Inspect DOM/source → Generate POM + Spec (+ playwright.config)
  → Optional storageState / seed → Headless run (+ Auto-Heal ≤3)
  → Artifact sync (video/trace/screenshot) → PG → Apply AItest/E2ETest/
  → Dọn .ai-test/workspace/{runId}
```

## Phases

| Phase | Nội dung | Status |
|-------|----------|--------|
| **E0** | Docs + API contract + layout `AItest/E2ETest/{Module}/pages\|specs\|fixtures/` | Done |
| **E1** | DOM / source inspect → interactive elements JSON | Done |
| **E2** | Generate multi-file POM + Spec + config scaffold | Done |
| **E3** | `storageState.json` + optional `seedCommand` / `teardownCommand` | Done |
| **E4** | Headless Playwright + Auto-Heal selector (mirror Unit sandbox) | Done |
| **E5** | Artifact sync → `ReportRecord` meta (paths only, không upload binary) | Done |
| **XP0** | Windows spawn + exc_detail + Playwright check + cwd=config dir | **Done** |
| **EX3** | Staging `.ai-test` → Apply confirm `AItest/E2ETest` + cleanup + path jail | **Done** |
| **EX4** | Batch module queue + Playwright inspect + meta env + open HTML report | **Done** |
| **EX5** | Preview Files · IDE open opt-in · Copy heal · UX SoT doc | **Done** |

Chi tiết roadmap tiếp (R1, EX1…): [`E2E_AI_TESTING_REQUIREMENTS.md`](../E2E_AI_TESTING_REQUIREMENTS.md) §10.

## Layout

```text
[{pkg}/]AItest/E2ETest/{Module}/
├── pages/           # Page Object Models (*.page.ts)
├── specs/           # Specs (*.spec.ts)
├── fixtures/        # Test data + storageState.json (optional)
└── playwright.config.ts   # (hoặc ở root E2ETest/)
```

## API contract

| Method | Path | Mục đích |
|--------|------|----------|
| `POST` | `/api/generate-e2e` | Sinh POM + Spec (+ config) từ Approved TC |
| `POST` | `/api/e2e-sandbox-repair` | Headless 1 spec + auto-heal ≤2 (`headed` = hiện Chromium) |
| `POST` | `/api/e2e-sandbox-module` | Headless cả `specs/` + heal chọn lọc fail (`headed` tương tự) |
| `POST` | `/api/e2e-inspect` | Inspect targetUrl / FE source → elements JSON |
| `POST` | `/api/e2e-artifacts-sync` | Quét video/trace/screenshot → `ReportRecord` |

### `POST /generate-e2e` body (chính)

- `projectId`, `testCaseId` (Approved)
- `targetUrl?`, `domSnapshot?`, `sourceCode?` / `workspaceId?`
- `module?`, `packagePrefix?`, `projectRoot?`
- `storageStateRel?`, `seedCommand?`, `teardownCommand?`

### Response shape

```json
{
  "files": [{ "path": "AItest/E2ETest/Auth/pages/login.page.ts", "content": "...", "kind": "page" }],
  "suggestedPaths": ["..."],
  "primarySpecPath": "AItest/E2ETest/Auth/specs/login.spec.ts",
  "testCaseId": "...",
  "projectId": "...",
  "runnerUsed": "AI_CLI"
}
```

### `POST /e2e-sandbox-repair` response

```json
{
  "status": "PASSED|FAILED",
  "attempts": 2,
  "primarySpecPath": "...",
  "files": [{ "path": "...", "content": "..." }],
  "errorLog": null,
  "history": [{ "attempt": 1, "exitCode": 1, "success": false }]
}
```

## Artifact metadata (E5)

`ReportRecord.format = "e2e-artifacts"`, `meta_json` chứa:

- `localRunId`, `testCaseId`, `module`, `status`, `durationMs?`
- `artifacts[]`: `{ kind: "video"|"trace"|"screenshot"|"report", path, sizeBytes? }`

Không lưu binary video/trace trong PostgreSQL — chỉ path tương đối dưới project root.

## EX4 (Batch & Inspect+)

- **Batch:** console Collapse «Batch E2E theo module» — multi-select TC; pipeline **Inspect 1× → Generate N → Headless module 1× (`POST /e2e-sandbox-module`) → Heal fails**; pause/resume giữa Generate; campaign multi-task.
- **Inspect:** `POST /e2e-inspect` `usePlaywright=true` → Chromium render; fallback HTTP GET. Single job: cache snapshot ~5 phút cùng Target URL.
- **Meta:** `ProjectMeta.e2e` (`targetUrl`, storage/seed/teardown, `usePlaywrightInspect`, `showBrowser`) — hydrate + Lưu / auto sau job.
- **Headed:** mặc định bật «Hiện cửa sổ Chromium» → CLI `--headed`; tắt = chạy nền (nhanh hơn). Config scaffold tắt `captureGitInfo` để giảm cold-start.
- **Artifacts:** tab Artifacts → «Mở report» / «Mở thư mục» (`open_path_in_os` Tauri).

## EX5 (Polish)

- **Files preview:** chọn POM/Spec → read-only textarea; Copy nội dung.
- **Copy heal:** chip khi PASS sau Auto-Heal.
- **UX SoT:** [`E2E_TEST_ENGINE_UX.md`](./E2E_TEST_ENGINE_UX.md).
- E2E console không còn IDE Connect / «Mở trong IDE».

## Playwright runner

Headless dùng `@playwright/test` theo thứ tự:

1. **Project** (root / package con) nếu đã cài  
2. **AITest shared** — `~/.aitest/playwright-runner` (`POST /e2e-playwright-ensure` · nút «Cài Playwright trên AITest»)

Không cần IDE. AI CLI chỉ generate/heal; Chromium chạy qua `npx --prefix <runner> playwright test`.

## Ngoài phạm vi MVP

- Cypress / Selenium / Appium
- Upload binary vào DB
- Rewrite toàn bộ journey business logic khi heal (ưu tiên sửa Page Object / selector)
