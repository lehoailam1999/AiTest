# @aitest/ide-protocol (P0)

JSON-RPC 2.0 bridge contracts between **IDE Plugin** and **Desktop Orchestrator**.

## Install

```bash
cd packages/ide-protocol
npm install
npm test
```

## Discovery file

Plugin writes:

`~/.aitest/ide-bridge.json`

```json
{
  "protocolVersion": 1,
  "port": 51234,
  "token": "…",
  "ide": "mock",
  "startedAt": "…",
  "workspaceRoot": "D:/Project"
}
```

Desktop reads via `readBridgeDiscovery()` then `IdeRpcClient.connect()`.

## Mock IDE

```bash
npm run mock-ide
```

## MVP methods

See `IdeMethods` / `IdeNotifications` in `src/methods.ts`.

Desktop listens for `aitest/focusChanged` (caret push, P1).
