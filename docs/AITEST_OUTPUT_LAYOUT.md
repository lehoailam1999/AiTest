# Generated test output layout (`AItest/`)

When Apply writes into the user repo, paths follow:

```text
AItest/                         ← root của project (không cạnh production)
├── UnitTest/
│   └── {Module}/               ← ưu tiên TC.module (1–2 segment)
│       └── {SourceStem}.test.*
├── IntegrationTest/
├── APITest/
├── E2ETest/
│   └── {Module}/
│       ├── pages/              # *.page.ts (POM)
│       ├── specs/              # *.spec.ts
│       ├── fixtures/           # storageState.json, data
│       └── playwright.config.ts
├── Reports/
├── Coverage/
└── Metadata/
```

## Rules

- Root is always `AItest/` at the **project root** after Apply (staging under `.ai-test/workspace/…/overlay/` is temporary).
- Kind folders: `UnitTest` | `IntegrationTest` | `APITest` | `E2ETest`.
- **Prefer Approved TC `module`** as the folder under Kind (flat).
- If no TC module: derive a **short** path from source — strip `ClientApp` / `src` / `app` / shells; max 2 segments. Never mirror `ClientApp/src/app/admin/…`.
- Naming follows language conventions.

## Example (Angular)

Source: `Forensic/ClientApp/src/app/admin/case-record/update/evidence-update-modal.component.ts`  
TC module: `Forensic`

→ `AItest/UnitTest/Forensic/evidence-update-modal.component.test.ts`

## Code

| Layer | File |
|-------|------|
| BE | `api/app/services/test_output_layout.py` |
| BE prompts/paths | `api/app/llm/base.py` |
| FE | `desktop/src/lib/testOutputLayout.ts` |

## Tests

```bash
cd api
.venv/Scripts/python -m unittest tests.test_output_layout -v
```
