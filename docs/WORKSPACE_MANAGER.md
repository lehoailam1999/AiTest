# Workspace Manager (Backend)

Production path for **source discovery / read** on the Desktop + local FastAPI stack.

## Principles

- React UI chooses folder (Tauri dialog) and calls APIs — it does **not** scan/read/parse source for generate.
- FastAPI `WorkspacePort` owns metadata scan, search, and lazy file read.
- **Metadata only** in SQLite + memory index — never persist source code.
- Same `WorkspacePort` can later be implemented by a **Local Agent** when API moves to cloud.

## REST

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/workspace/open` | `{ projectId, rootPath }` → session + background scan |
| GET | `/api/workspace/{id}` | Session summary |
| GET | `/api/workspace/{id}/status` | `indexing\|ready\|error` + progress |
| POST | `/api/workspace/{id}/refresh` | `{ full?: boolean }` incremental/full rescan |
| POST | `/api/workspace/{id}/close` | Close session |
| GET | `/api/workspace/{id}/files` | Metadata list (`ext`, `q`, `limit`, `cursor`) |
| POST | `/api/workspace/{id}/search` | `{ by, query, limit }` |
| POST | `/api/workspace/{id}/read` | `{ paths, maxBytesPerFile }` — jail under root |
| POST | `/api/workspace/{id}/resolve-scope` | TC → primary/related paths (+ optional AI tokens) |

## Generate unit

`POST /api/generate-unit` (và `generate-api-test`) accepts `workspaceId` (+ optional `sourceFileName` / `relatedPaths`).  
Backend reads files via Workspace Manager; FE may still show source in the textarea for UX preview (via `POST /workspace/{id}/read`) but must not rely on uploading `sourceCode` when `workspaceId` is set.

## Layout

```text
api/app/ports/workspace.py
api/app/features/workspace/
  api.py, application.py, di.py
  domain/
  infrastructure/   # scanner, gitignore, sqlite, reader, searcher, watcher, …
```

## Config

- `WORKSPACE_META_DB` — SQLite path (default `./.aitest_workspace/meta.db`)
- `WORKSPACE_ENABLE_WATCHER` — poll+debounce refresh (default `false`)

## FE

- **Step 4:** FE page Workspace Host **removed** from product path.
  - `/workspace`, `/repo`, `/open-project` → redirect `unitTestUrl()` (Unit test).
  - Open folder UI: `SourceRootBar` on `/unit-test`.
  - Keep: `workspace.ts` (localPath/workspaceId), `lib/workspaceManager/*`, Agent Staging.
  - Dead UI: `features/workspace/WorkspaceHostPage.tsx` (deprecated, not routed).
- Journey / Home / Layout (Step 3): không còn menu Workspace; CTA → `/unit-test`.
- `bindSourceRoot` / `pickAndBindSourceRoot` — pick folder → localPath → `POST /workspace/open` → sync meta.
- Generate: send `workspaceId` + paths; BE reads disk. FE read only for preview UI.
- Tauri `list_source_files` / `read_text_file` deprecated for generate (staging write still local)

## Tests

```bash
cd api
.venv/Scripts/python -m unittest tests.test_workspace -v
```
