# Lộ Trình Triển Khai: Auto Rule trên Source Đích (Unit · E2E Gen · Playwright Verify)

> **Mục đích:** Hướng dẫn **thực hiện từng bước** — Auto-Discover → ghi `.ai-test/` trên **repo SUT** (Forensic, …) → Desktop/API đọc profile khi Gen và **chạy Playwright**.  
> **Ngày cập nhật:** 2026-08-06  
> **Đọc kèm:** [`TARGET_RULES_PROJECT_PROFILE_PLAN.md`](TARGET_RULES_PROJECT_PROFILE_PLAN.md) (kiến trúc), [`E2E_STABILITY_BEFORE_PERF_PLAN.md`](E2E_STABILITY_BEFORE_PERF_PLAN.md) (smoke G1–G6), [`AI_TEST_RULES.md`](AI_TEST_RULES.md) (engine rules).

---

## 0. Bắt đầu từ đâu? (đọc trước khi code)

### 0.1 Một dòng luồng

```text
bindSourceRoot → ghi .ai-test/project.profile.json trên SUT
              → Verify đọc playwrightRun (Sprint 1)
              → Gen đọc conventions + moduleMap (Sprint 2)
              → Unit + UI + Smoke (Sprint 3–4)
```

**Bắt đầu tại:** tạo `desktop/src/lib/projectProfile/` + wire `bindSourceRoot.ts` — **chưa** sửa cả `e2eJobRunner.ts` 2000 dòng.

### 0.2 Đừng bắt đầu từ

| Tránh | Lý do |
|-------|--------|
| UI nút Sync trước | Chưa có profile để sync |
| Unit profile trước E2E Verify | Lỗi thực tế là Playwright runtime (`storageState` ENOENT) |
| Refactor Rule Index | Profile là lớp **Target** trên SUT, không thay `api/app/rules/` |
| Job Builder / Worker Pool | [`E2E_STABILITY_BEFORE_PERF_PLAN.md`](E2E_STABILITY_BEFORE_PERF_PLAN.md) — sau G1–G6 |
| Sửa file staging Forensic tay | Overlay tạm; regen/Apply từ AITest |

### 0.3 Thứ tự sprint (thực thi)

| Sprint | Thời gian gợi ý | Deliverable |
|--------|-----------------|-------------|
| **S0** | 2–4 ngày | Module `projectProfile` + file `.ai-test/` khi bind |
| **S1** | 3–5 ngày | Verify preflight + env từ profile (fix storageState) |
| **S2** | 4–6 ngày | E2E Gen conventions + `moduleMap` / `featurePath` |
| **S3** | 3–4 ngày | Unit conventions + gates + deprecate `aiRules` trùng |
| **S4** | 3–5 ngày | UI sync + smoke G1–G6 |

---

## 1. Kiến trúc ba lớp (không trùng Engine AITest)

```text
┌─────────────────────────────────────────────────────────────┐
│  A. Engine (repo AITest) — KHÔNG auto-discover               │
│     E2ECG/UUTGS, R6/R9, journey, taxonomy, Rule Index         │
│     api/app/llm/* · e2e_codegen_guard · e2e_journey_enforce    │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  B. Codegen conventions (SUT `.ai-test/*.md`)                │
│     Unit Gen · E2E Gen/Heal — LLM prompt excerpt              │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  C. Playwright Run (SUT `project.profile.json` → playwrightRun)│
│     Verify · Inspect · Seed — e2eJobRunner · e2e_orchestrator  │
└─────────────────────────────────────────────────────────────┘
```

| Lớp | Ai đọc | Khi nào |
|-----|--------|---------|
| Engine | API guard + registry | Mọi Gen/Heal |
| Codegen `.md` | `generate_e2e` / `generate_unit` | Generate / Heal |
| `playwrightRun` | `e2eJobRunner`, `e2e_orchestrator` | Inspect, Verify, Smoke |

**Đã có (chưa đủ):** `project.meta.aiRules` (DB text từ scan) — `projectSync.ts`, `api/app/llm/ai_rules.py`. **Chưa có:** file `.ai-test/` trên SUT, Verify đọc profile.

---

## 2. Artifact trên repo SUT

| File | SoT | Consumer |
|------|-----|----------|
| `.ai-test/project.profile.json` | Machine | Discover merge, runtime load |
| `.ai-test/e2e-conventions.md` | Render từ profile | E2E Gen prompt (`projectRules`) |
| `.ai-test/e2e-playwright-run.md` | Render từ `playwrightRun` | Human + Verify log; **không** inject LLM |
| `.ai-test/unit-conventions.md` | Render từ `unit` block | Unit Gen (Sprint 3) |

Cùng folder với Code Index: `.ai-test/index.db` (đã có).

---

## 3. Schema v1 — `project.profile.json`

```json
{
  "schema": "aitest-project-profile-v1",
  "runner": "playwright",
  "testRoot": "AItest/E2ETest",
  "playwrightRun": {
    "packageRoot": "",
    "workCwd": "per-tc-config",
    "configPattern": "**/playwright.config.ts",
    "baseURLEnv": "E2E_BASE_URL",
    "defaultBaseURL": "http://localhost:4200",
    "testIdAttribute": "data-cy",
    "storageState": {
      "strategy": "storageState",
      "canonicalRel": "./fixtures/storageState.json",
      "discoverDirs": [".ai-test/auth", "AItest/E2ETest/_shared/fixtures"],
      "sharedRel": "AItest/E2ETest/_shared/fixtures/storageState.json"
    },
    "seed": { "globalSetupRel": null, "seedCommand": "", "teardownCommand": "" },
    "run": { "workers": 1, "timeoutMs": 90000, "headless": false, "slowMoMs": 500, "browser": "chromium" },
    "envAllowlist": ["E2E_BASE_URL", "E2E_STORAGE_STATE", "E2E_USERNAME", "E2E_PASSWORD", "E2E_ROLE", "E2E_FEATURE_PATH"]
  },
  "auth": { "strategy": "storageState", "storageDir": ".ai-test/auth", "roles": [] },
  "locatorPolicy": ["testid", "role", "label"],
  "moduleMap": {},
  "reuseRoots": [],
  "updatedAt": "2026-08-06T00:00:00.000Z"
}
```

**Merge rule (bắt buộc):** Rescan giữ 100% key `moduleMap` user đã sửa; chỉ **thêm** key mới từ discover.

---

## 4. Trạng thái codebase (2026-08-06)

| Hạng mục | Trạng thái |
|----------|------------|
| `desktop/src/lib/projectProfile/*` | ✅ Sprint 0 |
| `bindSourceRoot` → Discover | ✅ Best-effort sau Code Index (~dòng 91–110) |
| `project.meta.aiRules` | ✅ Text scan ngắn |
| `e2eWorkspace` Gen/Verify | ✅ `e2eJobRunner.ts`, `env.ts` |
| Guards R6/R9 | ✅ `e2eSyntaxGate.ts`, `e2e_journey_enforce` |
| `e2e_auth_bootstrap.attach_storage_state_to_files` | ✅ API — align Sprint 1 |
| Rule Index selective | ✅ Không thay thế profile |

---

# Sprint 0 — Foundation (BẮT ĐẦU TẠI ĐÂY)

**Mục tiêu:** Bind SUT → tạo `.ai-test/project.profile.json` (+ md). **Chưa** wire Verify/Gen.

### S0.1 Cấu trúc module (copy pattern `codeIndex`)

Tạo folder:

```text
desktop/src/lib/projectProfile/
  constants.ts
  types.ts
  tauriIo.ts              ← mirror codeIndex/tauriIo.ts
  loadSaveProfile.ts
  discoverProjectProfile.ts
  renderConventions.ts
  index.ts
  projectProfile.phase0.test.ts
```

**Tham chiếu IO:** [`desktop/src/lib/codeIndex/tauriIo.ts`](../../desktop/src/lib/codeIndex/tauriIo.ts)

### S0.2 `constants.ts`

```ts
export const PROFILE_SCHEMA = "aitest-project-profile-v1";
export const AI_TEST_DIR = ".ai-test";
export const PROFILE_REL_PATH = ".ai-test/project.profile.json";
export const E2E_CONVENTIONS_REL = ".ai-test/e2e-conventions.md";
export const E2E_PLAYWRIGHT_RUN_REL = ".ai-test/e2e-playwright-run.md";
export const UNIT_CONVENTIONS_REL = ".ai-test/unit-conventions.md";
```

### S0.3 `types.ts` — export types

- `ProjectProfile`, `PlaywrightRunProfile`, `StorageStateProfile`, `AuthProfile`
- `UnitProfile` (stub cho Sprint 3: `runner`, `testFramework`, `mockLibrary`)
- `DiscoverResult` { profile, notes: string[] }

### S0.4 `discoverProjectProfile.ts` — **thin discover** (S0 chỉ 4 nhóm)

| # | Quét | Gán field | Ghi chú |
|---|------|-----------|---------|
| 1 | `node_modules/@playwright/test` từ root + shallow children | `playwrightRun.packageRoot` | Mirror `find_playwright_package_root` logic (desktop list files) |
| 2 | `playwright.config.ts` đầu tiên tìm được | `defaultBaseURL`, `run.*`, `seed.globalSetupRel` | Regex parse nhẹ, không cần AST |
| 3 | Line `storageState` trong config | `storageState.canonicalRel`, `strategy` | |
| 4 | `.ai-test/auth/**`, `storageState*.json` | `discoverDirs`, `auth.storageDir` | |
| 5 | 1–3 file FE `.ts/.html` (từ Code Index hoặc list) | `testIdAttribute`, `locatorPolicy` | `data-cy` vs `data-testid` |
| 6 | (optional S0) | `testRoot` | Folder `AItest/E2ETest` hoặc `e2e/` nếu có |

**S0 chưa làm:** Cypress, full `moduleMap` từ route catalog, Pytest/Jest discover chi tiết.

### S0.5 `loadSaveProfile.ts`

Functions:

- `loadProjectProfile(projectRoot, io): ProjectProfile | null`
- `mergeProjectProfile(existing, discovered): ProjectProfile` — **giữ `moduleMap` keys cũ**
- `saveProjectProfile(projectRoot, profile, io): void`

### S0.6 `renderConventions.ts`

- `renderE2eConventionsMd(profile): string` — locator, testRoot, layout artifact, forbidden
- `renderE2ePlaywrightRunMd(profile): string` — packageRoot, storageState, workers, env
- `renderUnitConventionsMd(profile): string` — stub ngắn Sprint 0
- `renderAllConventionFiles(profile): Record<string, string>` — path rel → content

### S0.7 `index.ts` — public API

```ts
export async function discoverAndPersistProjectProfile(projectRoot: string): Promise<DiscoverResult>
export async function loadProjectProfile(projectRoot: string): Promise<ProjectProfile | null>
export function mergeProjectProfile(...)
```

`discoverAndPersistProjectProfile`:

1. `discoverProjectProfile(projectRoot, io)`
2. `load` existing → `merge`
3. `save` json + 3 md files
4. return `{ profile, notes }`

### S0.8 Wire `bindSourceRoot.ts`

Sau block Code Index (~dòng 91–100), thêm:

```ts
try {
  const { discoverAndPersistProjectProfile } = await import("../projectProfile");
  void discoverAndPersistProjectProfile(rootPath).catch(() => {
    /* best-effort — bind vẫn OK */
  });
} catch {
  /* optional module */
}
```

**Không block** bind nếu discover fail.

### S0.9 Tests `projectProfile.phase0.test.ts`

- [ ] Merge: `moduleMap` user key không mất sau discover
- [ ] Render md có `testIdAttribute`
- [ ] Parse config mock: extract `baseURL` / `storageState` line
- [ ] `packageRoot` detect khi có fake tree (mock io)

### S0.10 Kiểm tra tay (Acceptance S0)

1. Restart desktop (`npm run desktop`)
2. Projects → bind `Forensic/forensic` (hoặc Rescan)
3. Kiểm tra filesystem:

```text
Forensic/forensic/.ai-test/project.profile.json
Forensic/forensic/.ai-test/e2e-playwright-run.md
Forensic/forensic/.ai-test/e2e-conventions.md
```

4. JSON có `playwrightRun.packageRoot` không rỗng (nếu đã `npm i` Playwright)
5. `moduleMap` = `{}` hoặc gợi ý — user có thể sửa tay JSON

**Chạy test:**

```powershell
cd desktop
node ../packages/ide-protocol/node_modules/tsx/dist/cli.mjs --test src/lib/projectProfile/projectProfile.phase0.test.ts
```

### S0 checklist tổng

- [x] S0.1–S0.7 Module files
- [x] S0.8 Wire bind
- [x] S0.9 Unit tests pass
- [ ] S0.10 Bind Forensic → 4 artifact `.ai-test/` (kiểm tra tay sau restart desktop)

---

# Sprint 1 — Playwright Verify (ưu tiên sau S0)

**Mục tiêu:** Verify/Inspect đọc profile — **preflight** trước Playwright; fix lỗi `Error reading storage state from …`.

### S1.1 `resolveForVerify.ts` (mới trong `projectProfile/`)

```ts
export type VerifyProfileContext = {
  profile: ProjectProfile | null;
  storageStateAbs?: string;
  storageStateValid: boolean;
  packageRoot?: string;
  playwrightInstalled: boolean;
  preflightErrors: string[];
};

export async function resolveProfileForVerify(
  projectRoot: string,
  uiFallback: { targetUrl?: string; useStorageState?: boolean; storageStateRel?: string }
): Promise<VerifyProfileContext>
```

Logic:

- Load profile (hoặc null → fallback UI)
- Walk `discoverDirs` + check file exists + JSON có `cookies`/`origins` (mirror `is_valid_storage_state_json` đơn giản)
- Check `packageRoot/node_modules/@playwright/test`

### S1.2 `e2eWorkspace/env.ts`

- [ ] `buildE2EEnvFromProfile(profile, uiInput): E2EEnvConfig`
- [ ] `canonicalRel` từ `profile.playwrightRun.storageState.canonicalRel`
- [ ] `testIdAttribute` → `E2E_TEST_ID_ATTRIBUTE` (nếu chưa có)

### S1.3 `e2eJobRunner.ts` — điểm chèn (Verify path)

Tìm `verifyE2eModuleBatch` / `verifyE2eForTestCase` — **đầu hàm**:

1. `const vctx = await resolveProfileForVerify(projectRoot, opts)`
2. Log: `verify profile: packageRoot=… storageValid=…`
3. Nếu `vctx.preflightErrors.length` → return FAILED rows với `PreconditionFailed`, **không** gọi API playwright
4. Merge `vctx` vào `buildE2EEnvConfig` trước `playwrightEnvFromConfig`

### S1.4 `pickDiscoveredStorageState.ts`

- [ ] Thêm `pickStorageStateFromProfile(projectRoot, profile): string | undefined`
- [ ] Thứ tự: `discoverDirs` → file valid → return project-relative path
- [ ] Trước Verify: nếu cần attach vào TC `fixtures/` — gọi logic tương tự API `attach_storage_state_to_files` (desktop copy file vào overlay staging)

### S1.5 Preflight messages (chuẩn taxonomy)

| Điều kiện | Message |
|-----------|---------|
| `strategy=storageState` + no valid file | `PreconditionFailed: storageState missing — run Auth Discover/Seed` |
| No `@playwright/test` | `PreconditionFailed: install Playwright in {packageRoot}` |
| Profile missing (S1) | Fallback UI settings + log `profile: (none)` |

### S1.6 `e2e_codegen_guard.py` — đồng bộ path Spec

- [ ] `normalize_config_storage_state` + spec `test.use({ storageState })` dùng **một** `canonicalRel` (không `_shared` khi env là `./fixtures/`)
- [ ] Đọc optional body field `playwrightRun` từ Gen request (Sprint 2 có thể gửi từ Desktop)

### S1.7 `e2e_orchestrator.py`

- [ ] Body verify: optional `playwrightRun` snapshot
- [ ] `_runtime_fix_missing_storage_state` ưu tiên `canonicalRel` + `sharedRel` từ snapshot
- [ ] Test: `api/tests/test_e2e_orchestrator.py` case storageState fix

### S1.8 `inspectE2eDom` trong `e2eJobRunner`

- [ ] `baseURL` từ `profile.playwrightRun.defaultBaseURL` nếu UI trống
- [ ] `storage_state_path` abs từ profile resolve trước Inspect

### S1.9 Acceptance S1

- [ ] Verify TC upload-file: **không** ENOENT giữa PW — hoặc fail preflight với hint Seed
- [ ] Log có `storageValid=yes|no` **trước** `→ Verify module`
- [ ] Sau Auth Seed: Verify chạy PW (có thể vẫn LocatorNotFound — đó là Sprint 2)

### S1 checklist

- [x] S1.1 `resolveForVerify.ts` + `storageStateValidation.ts`
- [x] S1.2 `env.ts` — `buildE2EEnvWithProfile`, `E2E_TEST_ID_ATTRIBUTE`
- [x] S1.3 `e2eJobRunner` + `verifyProfilePrep.ts` preflight
- [x] S1.4 `applyStorageStateToVerifyFiles` (bundle inject)
- [ ] S1.5–S1.7 Guard + orchestrator (API runtime — optional follow-up)
- [x] S1.8 Inspect — profile `defaultBaseURL` + `canonicalRel`
- [ ] S1.9 Manual verify Forensic 1 TC (restart desktop + Auth Seed)

---

# Sprint 2 — E2E Codegen wire (1A)

**Mục tiêu:** Gen đọc conventions + `moduleMap` → ít lệch `featurePath` / locator.

### S2.1 Load conventions cho Gen

`e2eJobRunner.ts` — trong `generateE2eForTestCase` / batch:

```ts
const conventions = await readConventionExcerpt(projectRoot, E2E_CONVENTIONS_REL, 2500);
// payload projectRules = conventions (Desktop authoritative)
```

API nhận `projectRules` trực tiếp từ Desktop body; không fallback `projectAuto` ngầm cho luồng E2E Gen.

### S2.2 `deriveFeaturePathFromTc.ts`

Thứ tự resolve (cập nhật):

1. TC marker `path:` / `featurePath:` usable  
2. `profile.moduleMap[tc.module]`  
3. `matchFeaturePathFromCatalog`  
4. FE retrieve — **không** invent `/admin/...`

### S2.3 Discover gợi ý `moduleMap` (mở rộng S0)

- [x] `discoverProjectProfile`: gọi `buildE2eRouteCatalog` để suggest route
- [x] Chỉ **add** entries score ≥ `STRONG_CATALOG_SCORE`; không overwrite user keys

### S2.4 Guard codegen

- [x] `testIdAttribute` từ profile vào generated `playwright.config.ts`
- [x] `gotoFeature` baked path ưu tiên TC + moduleMap

### S2.5 API

- [x] `generate_e2e.py`: log source + authoritative cho `project_rules` (debug)
- [x] Cap 2000 chars cho body `projectRules` ở route `_build_e2e_req`

### S2.6 Acceptance S2

- [x] Log Gen: `profile loaded`, `featurePath source=moduleMap|TC|catalog|...`
- [x] Smoke G1: FE domain khớp TC module (report có `G1 sample`)

### S2 checklist

- [x] S2.1 conventions → API
- [x] S2.2 featurePath order
- [x] S2.3 moduleMap discover suggest
- [x] S2.4 guard testIdAttribute
- [x] S2.5 API logging
- [x] S2.6 Smoke G1 sample

---

# Sprint 3 — Unit + Gates (1A Unit + Phase 2)

### S3.1 Unit discover (mở rộng discover)

- Jest / Vitest / Pytest / xUnit từ `package.json`, `pyproject.toml`, `*.csproj`
- Render `unit-conventions.md`

### S3.2 `unitWorkspace` wire

- Load `unit-conventions.md` → `projectRules` khi generate

### S3.3 Gates

- [x] `assertTcReadyForE2eGen.ts`: warn nếu profile thiếu `runner` / `auth.strategy`
- [x] DoR Verify: đã có S1 preflight
- [x] `e2e-playwright-run.md` **không** inject LLM

### S3.4 Deprecate trùng `aiRules`

- [x] `projectSync.ts` / `seed_ai_rules_on_meta`: `projectAuto` = excerpt từ profile render khi sync
- [x] `lockProjectAuto` vẫn tôn trọng user lock

### S3 checklist

- [x] S3.1 Unit discover
- [x] S3.2 unitWorkspace wire
- [x] S3.3 gates
- [x] S3.4 aiRules merge

---

# Sprint 4 — UI + Smoke (Phase 3 + 4)

### S4.1 `E2ETestPage.tsx`

- Nút «Đồng bộ Project Profile» → `discoverAndPersistProjectProfile(localPath)`
- Badge: `Playwright · {testIdAttribute} · storageState · {packageRoot leaf}`

### S4.2 Verify panel

- Trước Verify: hiện preflight từ `resolveProfileForVerify` (✓/✗ storage, ✓/✗ PW installed)

### S4.3 `e2eSmokeRunner.ts`

- Load profile; G4 auth đọc `playwrightRun.storageState`

### S4.4 Smoke + docs

- [ ] Chạy `runE2eSmokeJob` 5–10 TC Forensic
- [ ] Ghi G1–G6 vào `E2E_STABILITY_BEFORE_PERF_PLAN.md`
- [ ] Pointer `AI_TEST_RULES.md`

### S4 checklist

- [ ] S4.1 UI sync button + badge
- [ ] S4.2 Verify preflight panel
- [ ] S4.3 smoke runner
- [ ] S4.4 smoke report + docs

---

## 5. Map lỗi thực tế → Sprint

| Log / lỗi | Sprint fix |
|-----------|------------|
| `Error reading storage state from …/_shared/…` | S1 preflight + attach + guard một path |
| `verify env: E2E_STORAGE_STATE=./fixtures` nhưng Spec `_shared` | S1.6 guard |
| `ContextMissing R9/R6` | Đã có engine — không profile |
| `featurePath` lệch domain | S2 moduleMap |
| `0/125 PASS` metrics suite | S4 smoke — fix từng gate G1–G6 |
| Không có `.ai-test/profile` | S0 bind |

---

## 6. File map (tất cả sprint)

| Path | Sprint | Việc |
|------|--------|------|
| `desktop/src/lib/projectProfile/*` | S0 | New module |
| `desktop/src/lib/workspaceManager/bindSourceRoot.ts` | S0 | Wire discover |
| `desktop/src/lib/projectProfile/resolveForVerify.ts` | S1 | Preflight |
| `desktop/src/lib/e2eWorkspace/env.ts` | S1 | Profile → env |
| `desktop/src/lib/e2eWorkspace/e2eJobRunner.ts` | S1, S2 | Verify + Gen |
| `desktop/src/lib/e2eWorkspace/pickDiscoveredStorageState.ts` | S1 | discoverDirs |
| `desktop/src/lib/e2eWorkspace/deriveFeaturePathFromTc.ts` | S2 | moduleMap |
| `api/app/services/e2e_codegen_guard.py` | S1, S2 | storageState path |
| `api/app/services/e2e_orchestrator.py` | S1 | Runtime fix |
| `api/app/services/e2e_auth_bootstrap.py` | S1 | Align attach |
| `api/app/routers/generate_e2e.py` | S2 | projectRules |
| `desktop/src/lib/unitWorkspace/*` | S3 | Unit wire |
| `desktop/src/features/e2e-test/E2ETestPage.tsx` | S4 | UI |
| `desktop/src/lib/e2eWorkspace/e2eSmokeRunner.ts` | S4 | Smoke |

**Không đụng khi làm profile:** Rule Index core, Code Index indexer logic — chỉ **đọc** `reuseRoots` / FE list.

---

## 7. Acceptance toàn bộ (S0–S4 done)

- [ ] Bind SUT → 4 file `.ai-test/` (json + 3 md)
- [ ] Verify: preflight trước PW; không ENOENT storageState giữa chừng
- [ ] Gen: `projectRules` từ file; `featurePath` log nguồn
- [ ] Unit: conventions từ file
- [ ] UI: sync profile + badge
- [ ] Smoke G1–G6 ghi stability plan
- [ ] Engine R6/R9 vẫn apply; không hardcode tên product trong AITest runtime

---

**Tóm tắt:** Copy pattern `codeIndex` → thin discover → ghi SUT → **Verify đọc profile (S1)** → Gen conventions (S2) → Unit + UI + Smoke (S3–S4). Engine AITest giữ nguyên; profile là input trên repo đích.
