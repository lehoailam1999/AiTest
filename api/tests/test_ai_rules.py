"""Tests for 3-tier AI Rules (System / Project / User)."""

from __future__ import annotations

from app.llm.ai_rules import (
    append_layered_rules,
    build_project_rules_text,
    build_user_rules_text,
    format_layered_rules_block,
    merge_project_meta,
    seed_ai_rules_on_meta,
    synthesize_project_auto_rules,
)
from app.llm.base import GenerateContext, e2e_system_prompt, system_prompt, unit_system_prompt


def test_synthesize_from_scan_fields():
    auto = synthesize_project_auto_rules(
        {
            "scanLanguage": "TypeScript",
            "frameworks": ["NestJS"],
            "testFrameworks": ["Jest"],
            "stacks": ["node"],
        }
    )
    assert "TypeScript" in auto
    assert "Jest" in auto
    assert "NestJS" in auto


def test_build_project_and_user_rules():
    meta = {
        "aiRules": {
            "projectAuto": "AUTO_BLOCK",
            "projectExtra": "EXTRA_NOTE",
            "user": "USER_PREF",
        }
    }
    assert "AUTO_BLOCK" in build_project_rules_text(meta)
    assert "EXTRA_NOTE" in build_project_rules_text(meta)
    assert build_user_rules_text(meta) == "USER_PREF"


def test_fallback_synthesize_when_ai_rules_empty():
    meta = {"scanLanguage": "Python", "testFrameworks": ["pytest"]}
    text = build_project_rules_text(meta)
    assert "Python" in text
    assert "pytest" in text


def test_format_layered_precedence_header():
    block = format_layered_rules_block(
        system_extra="SYS",
        project_rules="PROJ",
        user_rules="USR",
    )
    assert "System > Project > User" in block
    assert "SYS" in block and "PROJ" in block and "USR" in block
    # Order: system before project before user
    assert block.index("SYS") < block.index("PROJ") < block.index("USR")


def test_seed_respects_lock_project_auto():
    meta = {
        "scanLanguage": "Go",
        "frameworks": ["gin"],
        "aiRules": {
            "projectAuto": "KEEP_ME",
            "user": "u1",
            "lockProjectAuto": True,
        },
    }
    seeded = seed_ai_rules_on_meta(meta, language="Go")
    assert seeded["aiRules"]["projectAuto"] == "KEEP_ME"
    assert seeded["aiRules"]["user"] == "u1"


def test_seed_refreshes_when_unlocked():
    meta = {
        "scanLanguage": "TypeScript",
        "testFrameworks": ["Vitest"],
        "aiRules": {"projectAuto": "OLD", "lockProjectAuto": False},
    }
    seeded = seed_ai_rules_on_meta(meta)
    assert "Vitest" in seeded["aiRules"]["projectAuto"]


def test_merge_project_meta_deep_merges_ai_rules():
    existing = {
        "frameworks": ["react"],
        "aiRules": {"user": "keep-user", "projectAuto": "auto"},
        "e2e": {"targetUrl": "http://a"},
    }
    merged = merge_project_meta(
        existing,
        {"e2e": {"targetUrl": "http://b"}, "aiRules": {"projectExtra": "extra"}},
    )
    assert merged["e2e"]["targetUrl"] == "http://b"
    assert merged["aiRules"]["user"] == "keep-user"
    assert merged["aiRules"]["projectAuto"] == "auto"
    assert merged["aiRules"]["projectExtra"] == "extra"
    assert merged["frameworks"] == ["react"]


def test_tc_system_prompt_injects_three_tiers():
    ctx = GenerateContext(
        custom_rules="SYS_RULE",
        project_rules="PROJ_RULE",
        user_rules="USER_RULE",
    )
    prompt = system_prompt(ctx)
    assert "SYS_RULE" in prompt
    assert "PROJ_RULE" in prompt
    assert "USER_RULE" in prompt
    assert "System > Project > User" in prompt


def test_unit_and_e2e_prompts_append_project_user():
    unit = unit_system_prompt(
        "jest",
        "TypeScript",
        testing_framework="jest",
        project_rules="UNIT_PROJ",
        user_rules="UNIT_USER",
    )
    assert "UNIT_PROJ" in unit
    assert "UNIT_USER" in unit

    e2e = e2e_system_prompt(
        heal=False,
        has_storage_state=False,
        project_rules="E2E_PROJ",
        user_rules="E2E_USER",
    )
    assert "E2E_PROJ" in e2e
    assert "E2E_USER" in e2e


def test_synthesize_includes_unit_entrypoint_rule():
    auto = synthesize_project_auto_rules({"scanLanguage": "TypeScript"})
    assert "entrypoint" in auto.lower() or "bootstrap" in auto.lower()
    assert "Project Extra" in auto


def test_unit_system_prompt_bootstrap_safety():
    unit = unit_system_prompt("jest", "TypeScript", testing_framework="jest")
    assert "UUTGS" in unit
    assert "entrypoint" in unit.lower() or "bootstrap" in unit.lower()
    assert "Single Source of Truth" in unit
    assert "NestFactory" in unit or "Nest/Express" in unit


def test_unit_system_prompt_csharp_import_rule():
    unit = unit_system_prompt("xunit", "C#", testing_framework="xunit", mock_framework="Moq")
    assert "CRITICAL for C#/.NET" in unit
    assert "NEVER invent" in unit
    assert "CS0854" in unit or "optional" in unit.lower()
    assert "CaseRecord" not in unit
    assert "AppendEvidenceActionAsync" not in unit
    assert "JHipsterNet" not in unit
    # TS prompt must not get the C# block
    ts = unit_system_prompt("jest", "TypeScript", testing_framework="jest")
    assert "CRITICAL for C#/.NET" not in ts
    assert "UUTGS" in unit
    assert "main" in unit.lower()  # forbidden entrypoints in UUTGS


def test_unit_user_prompt_warns_on_main_entrypoint():
    from app.llm.base import UnitRequest, is_likely_app_entrypoint, unit_user_prompt

    assert is_likely_app_entrypoint("backend/src/main.ts")
    assert is_likely_app_entrypoint(
        "src/app.ts",
        "async function bootstrap() { await NestFactory.create(AppModule); }",
    )
    assert not is_likely_app_entrypoint("src/todo/todo.service.ts")

    req = UnitRequest(
        test_case_title="ValidationPipe whitelist",
        test_case_type="Unit",
        priority="High",
        steps="1. Arrange pipe",
        expected_result="rejects unknown fields",
        precondition="",
        test_data="",
        source_file_name="backend/src/main.ts",
        source_code=(
            "async function bootstrap() {\n"
            "  const app = await NestFactory.create(AppModule);\n"
            "  app.enableCors();\n"
            "  await app.listen(3000);\n"
            "}\n"
            "bootstrap();\n"
        ),
        class_name="",
        method_name="",
        framework="jest",
        language="TypeScript",
        testing_framework="jest",
    )
    prompt = unit_user_prompt(req)
    assert "Entrypoint / bootstrap SUT" in prompt
    assert "do not import" in prompt.lower()
    assert "UUTGS" in prompt


def test_engine_rules_unit_forbids_entrypoint_sut():
    from app.llm.tc_generation_rules import engine_generation_rules

    text = engine_generation_rules("unit")
    assert "entrypoint" in text.lower() or "bootstrap" in text.lower()
    assert "main.ts" in text


def test_append_layered_rules_noop_when_empty():
    assert append_layered_rules("BASE") == "BASE"
