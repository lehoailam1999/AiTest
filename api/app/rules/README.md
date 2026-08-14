# Rule Registry (Phase 3)

Governance (agent only): `.cursor/rules/rule-index.mdc`  
Unit TC gen pointer: `.cursor/rules/unit-tc-from-analysis.mdc` → fragments below  
Unit Approve pointer: `.cursor/rules/code-aliases-unit-gen.mdc` → Desktop ranking (not this registry)

- System spec: `docs/SYSTEM_MASTER_DOCUMENTATION.md`
- Registry: `api/app/rules/rule_registry.yaml`
- Loader: `registry_loader.py` · profiles: `profiles.py` · retriever: `retriever.py`

## Unit TC gen (runtime)

| Id / fragment | Role |
|---------------|------|
| `UNIT-TC-ANALYSIS-FULL` / `unit_tc_analysis_full.md` | SoT IR (6 gate + PRIMARY) |
| `UNIT-TC-ANALYSIS-FAST` / `unit_tc_analysis_fast.md` | Speed SoT |
| `TC-GEN-COMPACT-UNIT` / `tc_compact_unit.md` | Shared format |
| `TC-GEN-SPEED-UNIT` / `tc_speed_unit.md` | Speed shared |

Inject: `unit_tc_analysis_rules.py` prepended by `engine_generation_rules("unit")`.  
Context: PRIMARY BE only (`unit_tc_be_context` / MSC) — not FLOWS/UI.

## Selective gates

- `AITEST_RULE_RETRIEVE_MODE=selective`
- Unit codegen: `PROFILE-UNIT-CODEGEN`
- TC-gen: `AITEST_RULE_RETRIEVE_TCGEN=1`
- E2E: `AITEST_RULE_RETRIEVE_E2E=1`
- Analysis: `AITEST_RULE_RETRIEVE_ANALYSIS=1`

Log: `RuleProfile apply profile=… ids=… chars=…`

## Smoke

1. Unit / E2E / Analysis / TC-gen jobs  
2. Confirm log `ids`/`chars` per profile  
3. Approve path/code: Desktop tests `unitResolve` / `unitBodyRuleScore` (not this package)
