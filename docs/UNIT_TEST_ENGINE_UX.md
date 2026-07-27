# Unit Test Engine UX (Phase U0–U5)

| | |
|--|--|
| **Trạng thái** | Product SoT cho Phase 2 Automate (thay IDE-first happy path) |
| **Ngày** | 2026-07-27 |
| **Liên quan** | [`KIEN_TRUC_DU_AN.md`](../KIEN_TRUC_DU_AN.md) §3–4 · Step 1–5 AI CLI · [`ARCHITECTURE_V2_IDE_FIRST.md`](./ARCHITECTURE_V2_IDE_FIRST.md) (legacy design) |

## North star

**SoT:** PostgreSQL (Approved TC, workspace runs, verify/coverage/apply audit, campaigns) + **AI CLI** generate/repair.  
**Desktop:** Job Console — gắn project root → **Chạy Unit Job** → Staging → **VerifyApplyConsole** → Apply.  
**IDE bridge:** viewer / mở file / boost context — **tuỳ chọn**, đã deprecate trên happy path (U4).

## Phases đã ship

| Phase | Nội dung |
|-------|----------|
| **U0** | Copy bỏ IDE-first; metric Local FS vs IDE |
| **U1** | CTA **Chạy Unit Job**; IDE thu vào Nâng cao |
| **U2** | **Unit Job Board** (`/activity`) |
| **U3** | Apply không cần IDE; mở IDE opt-in |
| **U4** | IA “Unit Engine”; tắt auto-connect; docs SoT CLI |
| **U5** | **VerifyApplyConsole** + batch Verify/Apply queue; parse test summary; focus sau Generate; Apply dọn staging |

## Happy path

```text
TC Approved → Project root → Chạy Unit Job (AI CLI)
  → Staging preview → VerifyApplyConsole (+ Auto-Repair)
    → Coverage sync → PG → Apply AItest/
    → Dọn .ai-test/workspace/{runId}
```

## U5 — Verify / Apply Console

**Single TC** ([`VerifyApplyConsole.tsx`](../desktop/src/features/unit-test/VerifyApplyConsole.tsx)):

- Pipeline strip: Staging → Compile → Test → Coverage → Repair → Apply
- Runner summary + «Sửa lệnh» (CLI nâng cao)
- Summary chips (passed/failed) từ log Jest/Vitest/pytest/dotnet/Go
- Apply gate: checklist path AItest/, confirm, cleanup staging
- Sau Generate: scroll tới console + tag «Tiếp theo: Chạy Verify»

**Batch** ([`BatchRunConsole.tsx`](../desktop/src/features/unit-test/BatchRunConsole.tsx)):

- Cột Generate / Verify / Apply + Verify|Apply từng dòng
- Toolbar: Verify tất cả đã Generate · Apply tất cả đã PASS · pause/resume
- Filter: tất cả / chưa verify / lỗi

## Deprecation

- `IdeBridgeAutoConnect` = no-op (không auto reconnect).
- Ready → IDE section: banner deprecated.
- Generate → IDE panel: “viewer (deprecated happy path)”.
- Giữ protocol/plugin code để mở file; không block Unit Job khi offline.

## Không làm trong U5

- Route Verify riêng
- Scaffold Vitest/pytest tương đương Jest (U6)
- Đổi schema PostgreSQL
- Xóa package `ide-protocol` / extension
