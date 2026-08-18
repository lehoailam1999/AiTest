# Unit Approve Source Grounding (as-built)

## Ownership

| Layer | Role |
| --- | --- |
| AITest / API | Unit TC IR (`READY_FOR_GROUNDING`), atomic `POST /testcases/{id}/approve-unit` |
| IDE Extension | Repository Intelligence — symbols, definitions, implementations, references, hashes |
| Desktop | Coordinator only — call IDE, validate decision, persist projections |
| Cursor CLI | Code synthesis from locked Gen packet — no SUT re-search |

## Invariants

1. One immutable `UnitApprovalDecision` (`aitest-unit-approve-decision-v2`) per Approve.
2. DB `unit_decision_json`, Markdown, and `.grounding.json` are projections of that decision.
3. `authoritative=true` only when `outcome=READY` and bindings/hashes/checks pass.
4. `FEATURE_GAP` / `NOT_READY` may retain nearest primary + bindings; never authoritative.
5. Gen consumes authoritative decisions only — no Desktop planner / Extension disk re-resolve.
6. Field labels stay human (`moTa`); execution properties are source-backed (`Description`).
7. E2E Approve is unchanged and does not use Repository Intelligence.
8. Field binding uses exact source metadata first, then a bounded Cursor CLI pick
   from the IDE-produced property shortlist. AI output outside that shortlist is
   rejected; unresolved or unavailable AI remains `NOT_READY`.

## Key files

- Protocol: `packages/ide-protocol/src/unitApproveRpc.ts`
- IDE resolver: `ide-plugins/vscode/src/repositoryIntelligence/`
- Desktop: `desktop/src/lib/unitApprove/`
- API: `api/app/routers/testcases.py` (`approve-unit`), migration `0014_unit_approval_decision.py`
- Gen consume-only: `desktop/src/lib/unitWorkspace/unitJobRunner.ts`, `ide-plugins/vscode/src/unitGenCommands.ts`
