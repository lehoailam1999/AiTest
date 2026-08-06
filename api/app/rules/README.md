# Rule Registry (Phase 3)

Rule registry is now wired across Unit/E2E/Analysis/TC-gen with selective retrieval gates.

- Governance: `.cursor/rules/rule-index.mdc`
- Plan: `docs/RULE_INDEX_PLAN.md`
- Inventory: `docs/rule_inventory.csv`
- Flow matrix: `docs/rule_flow_matrix.csv`

Available now:

- `rule_registry.yaml` — tagged rule content (JSON-in-YAML subset)
- `registry_loader.py` — loader + validation + cache
- `profiles.py` — selective profile scaffolding
- `retriever.py` — profile-based selection + `render_rules_for_profile_with_meta` (ids/chars)

Wired in runtime:

- `api/app/llm/uutgs_rules.py` reads `UUTGS-FULL` from registry with safe fallback.
- `AITEST_RULE_RETRIEVE_MODE=selective` enables profile render for Unit (`PROFILE-UNIT-CODEGEN`).
- `api/app/llm/e2e_codegen_rules.py` is registry-ready with safe fallback;
  selective E2E requires explicit gate `AITEST_RULE_RETRIEVE_E2E=1`.
- `api/app/llm/analysis_rules.py` reads analysis blocks from registry with safe fallback;
  selective analysis requires `AITEST_RULE_RETRIEVE_ANALYSIS=1`.
- `api/app/llm/tc_generation_rules.py`, `unit_tc_analysis_rules.py`, `e2e_tc_analysis_rules.py`
  read TC-gen blocks from registry with safe fallback; selective TC-gen requires
  `AITEST_RULE_RETRIEVE_TCGEN=1`.
- Runtime logs now emit profile observability at injection points:
  `RuleProfile apply profile=<...> mode=<...> ids=<rule_ids> chars=<n>`.

## Rollout runbook (recommended)

1. Set `AITEST_RULE_RETRIEVE_MODE=selective`.
2. Phase 4 default: Analysis/TC-gen/E2E selective are ON by default.
   Use gate env = `0|false|no|off` to disable one layer temporarily.
3. Run smoke jobs per flow (Unit/E2E/Analysis/TC-gen).
4. Verify logs include expected `profile`, `ids`, and reduced `chars`.
5. If any regression appears, disable only the failing gate first; keep others on.
