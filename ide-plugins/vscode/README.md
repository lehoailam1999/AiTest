# AITest IDE Bridge (VS Code / Cursor) — P1

Localhost JSON-RPC bridge that exposes IDE semantic context (`IdeSemanticPacket`) to AITest Desktop.

## Quick install (from repo root)

```bash
npm run extension:install
```

Then in Cursor: **Developer: Reload Window**. Status bar should show `AITest :port`, and:

`%USERPROFILE%\.aitest\ide-bridge.json`

must exist. After that, run **Tauri Desktop** (`npm run desktop`) → Unit test → **Connect IDE**.

## Manual options

### A — Dev Host (F5)

```bash
cd ide-plugins/vscode
npm install
npm run compile
```

Open this folder in VS Code/Cursor → **F5** (Extension Development Host).

### B — VSIX

```bash
npm run extension:package
```

Extensions → **Install from VSIX…** → pick the `.vsix` → Reload → command **AITest: Start IDE Bridge** if needed.

### C — Mock bridge (Desktop only, no real IDE)

```bash
npm run mock-ide
```

Writes the same discovery file; useful to test Connect without the extension.

## Behavior

1. On activate (default): starts WS server on `127.0.0.1:<ephemeral>`
2. Writes `~/.aitest/ide-bridge.json` (port + token + ide)
3. On caret/selection change (debounced ~250ms): pushes `aitest/focusChanged`
4. Desktop connects with the token and calls `aitest/getSemanticContext`

## Commands

| Command | Action |
|---------|--------|
| AITest: Start IDE Bridge | Start server + write discovery |
| AITest: Stop IDE Bridge | Stop + clear discovery |
| AITest: Show Bridge Status | Port / clients |
| AITest: Refresh Focus Packet | Force push current focus |

## DoD (P1)

Caret change in IDE → Desktop focus chip updates in &lt;1s.
